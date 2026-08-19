/**
 * Bitwarden Secrets Manager provider.
 *
 * This is deliberately only an adapter around an operator-provided official
 * `bws` executable. Dockhand does not distribute the client and does not
 * implement Bitwarden's API or cryptography. The provider bulk-loads one
 * Project selected by UUID and optionally targets an EU or self-hosted server.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { BitwardenConfig, SecretProvider, TestConnectionResult } from './shared';
import { UnsupportedOperationError, assertSafeProviderHost } from './shared';

const DEFAULT_BWS_PATH = '/usr/local/bin/bws';
const VERSION_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const VERSION_OUTPUT_LIMIT = 4 * 1024;
const TEST_OUTPUT_LIMIT = 2 * 1024 * 1024;
const SECRET_OUTPUT_LIMIT = 10 * 1024 * 1024;
const STDERR_OUTPUT_LIMIT = 64 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const CHILD_ENV_ALLOWLIST = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR'
] as const;

class BwsAdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BwsAdapterError';
	}
}

interface CommandLimits {
	timeoutMs: number;
	stdoutBytes: number;
	stderrBytes: number;
	accessToken?: string;
	serverUrl?: string;
}

function executablePath(): string {
	const override = process.env.DOCKHAND_BWS_PATH?.trim();
	if (!override) return DEFAULT_BWS_PATH;
	if (!isAbsolute(override)) {
		throw new BwsAdapterError('Bitwarden bws executable path must be absolute');
	}
	return override;
}

function childEnvironment(stateDir: string, accessToken?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: stateDir,
		XDG_CONFIG_HOME: stateDir
	};
	for (const key of CHILD_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (accessToken !== undefined) env.BWS_ACCESS_TOKEN = accessToken;
	return env;
}

function spawnFailure(error: unknown): BwsAdapterError {
	const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
	if (code === 'ENOENT') return new BwsAdapterError('Bitwarden bws executable was not found');
	if (code === 'EACCES') return new BwsAdapterError('Bitwarden bws executable is not executable');
	return new BwsAdapterError('Bitwarden bws executable could not be started');
}

/** Execute one bws process without a shell while bounding its lifetime and output. */
async function executeBws(
	stateDir: string,
	args: string[],
	limits: CommandLimits
): Promise<Buffer> {
	const stdoutChunks: Buffer[] = [];
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let failure: BwsAdapterError | undefined;
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const child = spawn(executablePath(), args, {
				env: childEnvironment(stateDir, limits.accessToken),
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false
			});

			const terminate = (error: BwsAdapterError) => {
				if (failure) return;
				failure = error;
				try {
					child.kill('SIGTERM');
				} catch {
					// The close/error handler below still settles the command.
				}
				killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						try {
							child.kill('SIGKILL');
						} catch {
							// The close/error handler below still settles the command.
						}
					}
				}, KILL_GRACE_MS);
			};

			const timeout = setTimeout(
				() => terminate(new BwsAdapterError('Bitwarden bws command timed out')),
				limits.timeoutMs
			);

			child.stdout?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += data.length;
				if (stdoutBytes > limits.stdoutBytes) {
					terminate(new BwsAdapterError('Bitwarden bws command exceeded the stdout limit'));
					return;
				}
				stdoutChunks.push(Buffer.from(data));
			});

			// stderr is deliberately never retained: only its byte count is observed.
			child.stderr?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				stderrBytes += Buffer.byteLength(chunk);
				if (stderrBytes > limits.stderrBytes) {
					terminate(new BwsAdapterError('Bitwarden bws command exceeded the stderr limit'));
				}
			});

			child.once('error', (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				reject(failure ?? spawnFailure(error));
			});

			child.once('close', (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (killTimer) clearTimeout(killTimer);
				if (failure) {
					reject(failure);
					return;
				}
				if (code !== 0) {
					reject(new BwsAdapterError('Bitwarden bws command failed'));
					return;
				}
				resolve(Buffer.concat(stdoutChunks, stdoutBytes));
			});
		});
	} finally {
		for (const chunk of stdoutChunks) chunk.fill(0);
	}
}

/** Execute bws in an isolated profile, configuring a non-default server when requested. */
async function runBws(args: string[], limits: CommandLimits): Promise<Buffer> {
	let stateDir: string | undefined;
	try {
		stateDir = await mkdtemp(join(tmpdir(), 'dockhand-bws-'));
		await chmod(stateDir, 0o700);
	} catch {
		if (stateDir) await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
		throw new BwsAdapterError('Bitwarden bws temporary state could not be created');
	}

	try {
		if (limits.serverUrl) {
			const configOutput = await executeBws(
				stateDir,
				['config', 'server-base', limits.serverUrl],
				{
					timeoutMs: VERSION_TIMEOUT_MS,
					stdoutBytes: VERSION_OUTPUT_LIMIT,
					stderrBytes: STDERR_OUTPUT_LIMIT
				}
			);
			configOutput.fill(0);
		}
		return await executeBws(stateDir, args, limits);
	} finally {
		// Swallow a cleanup failure: throwing here would mask the real error on the
		// failure path, and turn a successful pull into a thrown error on the happy
		// path. rm --force rarely fails; a stray temp dir is harmless residue.
		await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function runJsonArray(args: string[], limits: CommandLimits): Promise<unknown[]> {
	let output: Buffer | undefined;
	try {
		output = await runBws(args, limits);
		let parsed: unknown;
		try {
			parsed = JSON.parse(output.toString('utf8'));
		} catch {
			throw new BwsAdapterError('Bitwarden bws returned invalid JSON');
		}
		if (!Array.isArray(parsed)) {
			throw new BwsAdapterError('Bitwarden bws returned an invalid JSON response');
		}
		return parsed;
	} finally {
		output?.fill(0);
	}
}

async function assertSupportedVersion(): Promise<void> {
	let output: Buffer | undefined;
	try {
		output = await runBws(['--version'], {
			timeoutMs: VERSION_TIMEOUT_MS,
			stdoutBytes: VERSION_OUTPUT_LIMIT,
			stderrBytes: STDERR_OUTPUT_LIMIT
		});
		const match = /^bws\s+(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(
			output.toString('utf8')
		);
		const minor = match ? Number(match[2]) : -1;
		const patch = match ? Number(match[3]) : -1;
		const isAtLeastStable210 = minor > 1 || (minor === 1 && (patch > 0 || !match?.[4]));
		if (!match || Number(match[1]) !== 2 || !isAtLeastStable210) {
			throw new BwsAdapterError('Bitwarden bws version must be >=2.1.0 and <3.0.0');
		}
	} finally {
		output?.fill(0);
	}
}

function accessToken(config: BitwardenConfig): string {
	const token = typeof config?.token === 'string' ? config.token.trim() : '';
	if (!token) throw new BwsAdapterError('Bitwarden Machine Account access token is empty');
	return token;
}

function serverUrl(config: BitwardenConfig): string | undefined {
	const url = typeof config?.serverUrl === 'string' ? config.serverUrl.trim() : '';
	if (!url) return undefined;
	try {
		assertSafeProviderHost(url, 'Bitwarden Secrets Manager');
	} catch (error: unknown) {
		throw new BwsAdapterError(
			error instanceof Error ? error.message : 'Bitwarden Secrets Manager: host not allowed'
		);
	}
	return url.replace(/\/+$/, '');
}

function projectId(selector: string): string {
	const id = typeof selector === 'string' ? selector.trim() : '';
	if (!UUID_RE.test(id)) {
		throw new BwsAdapterError('Bitwarden Project selector must be a valid UUID');
	}
	return id;
}

function sanitizedError(error: unknown): string {
	return error instanceof BwsAdapterError
		? error.message
		: 'Bitwarden bws operation failed';
}

function secretRecord(payload: unknown[]): Record<string, string> {
	const result = Object.create(null) as Record<string, string>;
	const seen = new Set<string>();

	for (const entry of payload) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new BwsAdapterError('Bitwarden bws returned an invalid secret list');
		}
		const { key, value } = entry as Record<string, unknown>;
		if (typeof key !== 'string' || typeof value !== 'string' || value.includes('\0')) {
			throw new BwsAdapterError('Bitwarden bws returned an invalid secret list');
		}
		if (!ENV_NAME_RE.test(key)) {
			throw new BwsAdapterError('Bitwarden secret key is not a valid environment variable name');
		}
		if (DANGEROUS_KEYS.has(key)) {
			throw new BwsAdapterError('Bitwarden secret key is not allowed');
		}
		if (seen.has(key)) {
			throw new BwsAdapterError('Bitwarden bws returned duplicate secret keys');
		}
		seen.add(key);
		result[key] = value;
	}

	return result;
}

export const bitwardenProvider: SecretProvider<BitwardenConfig> = {
	type: 'bitwarden',
	label: 'Bitwarden Secrets Manager',
	supportsReferences: false,
	supportsBulk: true,

	isReference(_value: unknown): _value is string {
		return false;
	},

	async testConnection(config: BitwardenConfig): Promise<TestConnectionResult> {
		try {
			const token = accessToken(config);
			const server = serverUrl(config);
			await assertSupportedVersion();
			await runJsonArray(['project', 'list', '--output', 'json', '--color', 'no'], {
				timeoutMs: COMMAND_TIMEOUT_MS,
				stdoutBytes: TEST_OUTPUT_LIMIT,
				stderrBytes: STDERR_OUTPUT_LIMIT,
				accessToken: token,
				serverUrl: server
			});
			return { ok: true };
		} catch (error: unknown) {
			return { ok: false, error: sanitizedError(error) };
		}
	},

	async resolveSecretReferences(): Promise<Map<string, string>> {
		throw new UnsupportedOperationError(
			'Bitwarden Secrets Manager does not support inline references; use a Project bulk selector.'
		);
	},

	async resolveBulk(config: BitwardenConfig, selector: string): Promise<Record<string, string>> {
		try {
			const token = accessToken(config);
			const project = projectId(selector);
			const server = serverUrl(config);
			const payload = await runJsonArray(
				['secret', 'list', project, '--output', 'json', '--color', 'no'],
				{
					timeoutMs: COMMAND_TIMEOUT_MS,
					stdoutBytes: SECRET_OUTPUT_LIMIT,
					stderrBytes: STDERR_OUTPUT_LIMIT,
					accessToken: token,
					serverUrl: server
				}
			);
			return secretRecord(payload);
		} catch (error: unknown) {
			if (error instanceof BwsAdapterError) throw error;
			throw new BwsAdapterError(sanitizedError(error));
		}
	}
};

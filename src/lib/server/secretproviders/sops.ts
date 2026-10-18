/**
 * SOPS provider.
 *
 * Decrypts a SOPS-encrypted dotenv file (committed next to the compose file in a
 * Git stack) with an age identity stored in the provider config. It is neither a
 * reference nor a bulk backend: the secrets live in the stack's own env file, so
 * the provider implements `decryptEnvFile` and nothing else.
 *
 * An adapter around the `sops` executable (shipped in the image, overridable with
 * DOCKHAND_SOPS_PATH). The ciphertext goes in on stdin and the plaintext comes back
 * on stdout, so neither touches the disk. The age identity is passed to the child
 * only, via SOPS_AGE_KEY in an otherwise minimal environment - never on argv (it
 * would show on /proc/<pid>/cmdline), and without HOME so SOPS cannot fall back to
 * an SSH key or keys.txt that happens to exist in the container.
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { SecretProvider, SopsConfig, TestConnectionResult } from './shared';
import { UnsupportedOperationError } from './shared';
import { cliTimeoutMessage, cliTimeoutMs } from './cli-timeout-core';
import { normalizeAgeIdentities, parseSopsDecryptOutput, sopsEncryptedKeys } from './sops-core';

const DEFAULT_CLI_PATH = '/usr/bin/sops';
const TIMEOUT_ENV_VAR = 'DOCKHAND_SOPS_TIMEOUT_MS';
const DEFAULT_TIMEOUT_MS = 30_000;
const STDOUT_OUTPUT_LIMIT = 10 * 1024 * 1024;
const STDERR_OUTPUT_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 2_000;

class SopsCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SopsCliError';
	}
}

function executablePath(): string {
	const override = process.env.DOCKHAND_SOPS_PATH?.trim();
	if (!override) return DEFAULT_CLI_PATH;
	if (!isAbsolute(override)) throw new SopsCliError('SOPS executable path must be absolute');
	return override;
}

function spawnFailure(error: unknown): SopsCliError {
	const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
	if (code === 'ENOENT') return new SopsCliError('SOPS executable was not found');
	if (code === 'EACCES') return new SopsCliError('SOPS executable is not executable');
	return new SopsCliError('SOPS executable could not be started');
}

/**
 * SOPS exits 128 when no configured key opens the file's data key, and 1 for a
 * file it cannot parse. Its stderr is never kept (it can quote the input), so the
 * exit code is all the diagnosis there is.
 */
function nonZeroExitMessage(code: number | null): string {
	if (code === 128) return 'none of the configured age keys is a recipient of the env file';
	return `sops exited with code ${code}; the env file may not be valid SOPS dotenv`;
}

/**
 * Runs one sops process without a shell, bounding its lifetime and output. stdout
 * is captured; stderr is only counted.
 */
async function executeSops(
	phase: string,
	args: string[],
	ageKey: string | undefined,
	stdin: string | undefined
): Promise<Buffer> {
	const stdoutChunks: Buffer[] = [];
	const timeoutMs = cliTimeoutMs(process.env[TIMEOUT_ENV_VAR], DEFAULT_TIMEOUT_MS);
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let failure: SopsCliError | undefined;
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin' };
			if (ageKey) env.SOPS_AGE_KEY = ageKey;

			const child = spawn(executablePath(), args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				env
			});

			const terminate = (error: SopsCliError) => {
				if (failure) return;
				failure = error;
				try {
					child.kill('SIGTERM');
				} catch {
					// the close/error handler still settles the command
				}
				killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						try {
							child.kill('SIGKILL');
						} catch {
							// the close/error handler still settles the command
						}
					}
				}, KILL_GRACE_MS);
			};

			const timeout = setTimeout(
				() => terminate(new SopsCliError(cliTimeoutMessage('SOPS', phase, timeoutMs, TIMEOUT_ENV_VAR))),
				timeoutMs
			);

			child.stdin?.on('error', () => {
				/* a closed stdin (fast exit) is not fatal on its own */
			});
			child.stdin?.end(stdin ?? '');

			child.stdout?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += data.length;
				if (stdoutBytes > STDOUT_OUTPUT_LIMIT) {
					terminate(new SopsCliError('SOPS output exceeded the size limit'));
					return;
				}
				stdoutChunks.push(Buffer.from(data));
			});

			// stderr is deliberately never retained: only its byte count is observed.
			child.stderr?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				stderrBytes += Buffer.byteLength(chunk);
				if (stderrBytes > STDERR_OUTPUT_LIMIT) {
					terminate(new SopsCliError('SOPS error output exceeded the size limit'));
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
					reject(new SopsCliError(nonZeroExitMessage(code)));
					return;
				}
				resolve(Buffer.concat(stdoutChunks, stdoutBytes));
			});
		});
	} finally {
		for (const chunk of stdoutChunks) chunk.fill(0);
	}
}

function sanitizedError(error: unknown): string {
	return error instanceof Error ? error.message : 'SOPS operation failed';
}

export const sopsProvider: SecretProvider<SopsConfig> = {
	type: 'sops',
	label: 'SOPS (age)',
	supportsReferences: false,
	supportsBulk: false,

	isReference(_value: unknown): _value is string {
		return false;
	},

	async testConnection(config: SopsConfig): Promise<TestConnectionResult> {
		try {
			normalizeAgeIdentities(config.ageKey);
			// There is no backend to reach: what can fail is the key's shape (checked above)
			// and the executable. --disable-version-check keeps --version off the network.
			const output = await executeSops('version check', ['--disable-version-check', '--version'], undefined, undefined);
			output.fill(0);
			return { ok: true };
		} catch (error: unknown) {
			return { ok: false, error: sanitizedError(error) };
		}
	},

	async resolveSecretReferences(): Promise<Map<string, string>> {
		throw new UnsupportedOperationError('SOPS does not resolve inline references; it decrypts the stack env file');
	},

	async resolveBulk(): Promise<Record<string, string>> {
		throw new UnsupportedOperationError('SOPS does not support a bulk selector; it decrypts the stack env file');
	},

	async decryptEnvFile(config: SopsConfig, content: string, logPrefix = ''): Promise<Record<string, string>> {
		const ageKey = normalizeAgeIdentities(config.ageKey);
		let output: Buffer | undefined;
		try {
			output = await executeSops(
				'decrypt',
				['decrypt', '--input-type', 'dotenv', '--output-type', 'json', '/dev/stdin'],
				ageKey,
				content
			);
			const { vars, skipped } = parseSopsDecryptOutput(output.toString('utf8'), sopsEncryptedKeys(content));
			if (skipped.length > 0) {
				console.warn(`${logPrefix} SOPS skipped ${skipped.length} key(s) that are not valid environment variable names: ${skipped.join(', ')}`);
			}
			return vars;
		} finally {
			output?.fill(0);
		}
	}
};

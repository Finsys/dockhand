/**
 * Proton Pass provider.
 *
 * Like the Bitwarden provider, this is only an adapter around an
 * operator-installed official `pass-cli` executable. Dockhand does not
 * distribute the client and does not implement Proton's API or cryptography.
 *
 * pass-cli is STATEFUL: a session is created by `login`, used by subsequent
 * commands, and torn down by `logout`. Each Dockhand call runs the whole
 * login/operate/logout cycle inside a private, ephemeral session directory
 * (PROTON_PASS_SESSION_DIR) so concurrent calls never share credentials and no
 * session state survives the call.
 *
 * Two resolution modes:
 *   - Bulk pull: `item list --vault-name <selector> --output json --show-secrets`,
 *     mapping each item to one env var (title -> primary secret).
 *   - Inline references: `pass://VAULT/ITEM/FIELD` (id or name), resolved one field at
 *     a time via `item view <uri> --output json`.
 *
 * The access token is passed via the PROTON_PASS_PERSONAL_ACCESS_TOKEN
 * environment variable (pass-cli's own env channel for the PAT), never on argv,
 * so it is not exposed on the login process's /proc/<pid>/cmdline. `login` with
 * no --pat routes to PAT login when that env var is set.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ProtonConfig, SecretProvider, TestConnectionResult } from './shared';
import { stripSurroundingQuotes } from './shared';

const DEFAULT_PASS_CLI_PATH = '/usr/local/bin/pass-cli';
const LOGIN_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const LIST_OUTPUT_LIMIT = 10 * 1024 * 1024;
const VIEW_OUTPUT_LIMIT = 1 * 1024 * 1024;
const LOGIN_OUTPUT_LIMIT = 64 * 1024;
const STDERR_OUTPUT_LIMIT = 64 * 1024;

// pass://VAULT/ITEM/FIELD. VAULT and ITEM may be an opaque share/item id OR a
// human-readable name (pass-cli resolves names to ids itself); names can contain
// spaces, so those two segments allow any char except a path separator or a control
// char (newline/tab). The FIELD segment is required and kept tight (no spaces): with
// a field, `item view` prints the bare field value, which is unambiguous; without one
// it would print the whole item and there is no single "the secret". The ref is passed
// to pass-cli as a single argv element (spawn shell:false), so a space is safe.
const PASS_REF_RE = /^pass:\/\/[^/\n\r\t]+\/[^/\n\r\t]+\/[^/\s]+$/;
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

class PassCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PassCliError';
	}
}

interface CommandLimits {
	timeoutMs: number;
	stdoutBytes: number;
	stderrBytes: number;
	/** Set only on the `login` call; passed to pass-cli via its own env channel. */
	accessToken?: string;
}

function executablePath(): string {
	const override = process.env.DOCKHAND_PASS_CLI_PATH?.trim();
	if (!override) return DEFAULT_PASS_CLI_PATH;
	if (!isAbsolute(override)) {
		throw new PassCliError('Proton Pass pass-cli executable path must be absolute');
	}
	return override;
}

function childEnvironment(sessionDir: string, accessToken?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		HOME: sessionDir,
		XDG_CONFIG_HOME: sessionDir,
		PROTON_PASS_SESSION_DIR: sessionDir,
		PROTON_PASS_NO_UPDATE_CHECK: '1',
		// Dockhand runs headless in a container with no system keyring / D-Bus, where
		// pass-cli's default key provider fails with NoStorageAccess before any auth.
		// The filesystem provider stores the key under our isolated sessionDir instead.
		// An operator with a real keyring can override via the container env (#1440).
		PROTON_PASS_KEY_PROVIDER: process.env.PROTON_PASS_KEY_PROVIDER?.trim() || 'fs'
	};
	for (const key of CHILD_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	if (accessToken !== undefined) env.PROTON_PASS_PERSONAL_ACCESS_TOKEN = accessToken;
	return env;
}

function spawnFailure(error: unknown): PassCliError {
	const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
	if (code === 'ENOENT') return new PassCliError('Proton Pass pass-cli executable was not found');
	if (code === 'EACCES')
		return new PassCliError('Proton Pass pass-cli executable is not executable');
	return new PassCliError('Proton Pass pass-cli executable could not be started');
}

/** Execute one pass-cli process without a shell while bounding lifetime and output. */
async function executePassCli(
	sessionDir: string,
	args: string[],
	limits: CommandLimits
): Promise<Buffer> {
	const stdoutChunks: Buffer[] = [];
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let failure: PassCliError | undefined;
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const child = spawn(executablePath(), args, {
				env: childEnvironment(sessionDir, limits.accessToken),
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false
			});

			const terminate = (error: PassCliError) => {
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
				() => terminate(new PassCliError('Proton Pass pass-cli command timed out')),
				limits.timeoutMs
			);

			child.stdout?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += data.length;
				if (stdoutBytes > limits.stdoutBytes) {
					terminate(new PassCliError('Proton Pass pass-cli command exceeded the stdout limit'));
					return;
				}
				stdoutChunks.push(Buffer.from(data));
			});

			// stderr is deliberately never retained: only its byte count is observed.
			child.stderr?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				stderrBytes += Buffer.byteLength(chunk);
				if (stderrBytes > limits.stderrBytes) {
					terminate(new PassCliError('Proton Pass pass-cli command exceeded the stderr limit'));
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
					reject(new PassCliError('Proton Pass pass-cli command failed'));
					return;
				}
				resolve(Buffer.concat(stdoutChunks, stdoutBytes));
			});
		});
	} finally {
		for (const chunk of stdoutChunks) chunk.fill(0);
	}
}

/**
 * Runs `fn` inside a fresh, private pass-cli session: login, then the callback,
 * then an unconditional logout, then the session dir is removed. The PAT never
 * survives the call.
 */
async function withSession<T>(
	token: string,
	fn: (session: string) => Promise<T>
): Promise<T> {
	let sessionDir: string | undefined;
	try {
		sessionDir = await mkdtemp(join(tmpdir(), 'dockhand-pass-'));
		await chmod(sessionDir, 0o700);
	} catch {
		if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
		throw new PassCliError('Proton Pass pass-cli session state could not be created');
	}

	try {
		const loginOutput = await executePassCli(sessionDir, ['login'], {
			timeoutMs: LOGIN_TIMEOUT_MS,
			stdoutBytes: LOGIN_OUTPUT_LIMIT,
			stderrBytes: STDERR_OUTPUT_LIMIT,
			accessToken: token
		});
		loginOutput.fill(0);
		try {
			return await fn(sessionDir);
		} finally {
			// Best-effort teardown of the remote session; a failure here must not
			// mask the real result. The session dir is removed regardless below.
			await executePassCli(sessionDir, ['logout', '--force'], {
				timeoutMs: LOGOUT_TIMEOUT_MS,
				stdoutBytes: LOGIN_OUTPUT_LIMIT,
				stderrBytes: STDERR_OUTPUT_LIMIT
			}).catch(() => undefined);
		}
	} finally {
		await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function accessToken(config: ProtonConfig): string {
	const token = typeof config?.token === 'string' ? config.token.trim() : '';
	if (!token) throw new PassCliError('Proton Pass access token is empty');
	if (token.includes('\0') || /\s/.test(token)) {
		throw new PassCliError('Proton Pass access token is malformed');
	}
	return token;
}

function vaultName(selector: string): string {
	const name = typeof selector === 'string' ? selector.trim() : '';
	if (!name) throw new PassCliError('Proton Pass vault selector is empty');
	if (name.includes('\0') || name.startsWith('-')) {
		throw new PassCliError('Proton Pass vault selector is invalid');
	}
	return name;
}

function passReference(value: string): string {
	const ref = value.trim();
	if (!PASS_REF_RE.test(ref)) {
		throw new PassCliError('Proton Pass reference must be pass://VAULT/ITEM/FIELD (id or name)');
	}
	return ref;
}

function sanitizedError(error: unknown): string {
	return error instanceof PassCliError ? error.message : 'Proton Pass pass-cli operation failed';
}

function parseJson(output: Buffer): unknown {
	try {
		return JSON.parse(output.toString('utf8'));
	} catch {
		throw new PassCliError('Proton Pass pass-cli returned invalid JSON');
	}
}

function asObject(v: unknown): Record<string, unknown> | null {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Reads the primary injectable secret from one item of `item list --show-secrets`.
 * The item's payload is pass-cli's own `Item` serde (see pass-domain): the
 * content lives under `content` (an ItemData), whose `content` is an
 * externally-tagged ItemContent enum (`{ "Login": { password, ... } }`). A
 * Login item yields its password; otherwise the item's note text is used, else
 * the first hidden extra field. Items with no readable secret are reported as
 * null so the caller can skip them.
 */
function primarySecret(item: Record<string, unknown>): string | null {
	const data = asObject(item.content);
	if (!data) return null;

	const inner = asObject(data.content);
	if (inner) {
		const login = asObject(inner.Login);
		if (login && typeof login.password === 'string' && login.password) {
			return login.password.includes('\0') ? null : login.password;
		}
	}

	if (typeof data.note === 'string' && data.note && !data.note.includes('\0')) {
		return data.note;
	}

	const extras = Array.isArray(data.extra_fields) ? data.extra_fields : [];
	for (const field of extras) {
		const f = asObject(field);
		const content = f && asObject(f.content);
		const hidden = content?.Hidden;
		if (typeof hidden === 'string' && hidden && !hidden.includes('\0')) return hidden;
	}
	return null;
}

/**
 * Maps a bulk `item list --show-secrets` payload to env vars. Each item
 * contributes one entry keyed by its title (which must already be a valid
 * env-var name; other items are skipped) with its primary secret as the value.
 */
function bulkRecord(payload: unknown): Record<string, string> {
	const wrapper = asObject(payload);
	const items = wrapper && Array.isArray(wrapper.items) ? wrapper.items : null;
	if (!items) throw new PassCliError('Proton Pass pass-cli returned an invalid item list');

	const result = Object.create(null) as Record<string, string>;
	const seen = new Set<string>();

	for (const entry of items) {
		const item = asObject(entry);
		if (!item) throw new PassCliError('Proton Pass pass-cli returned an invalid item');
		const data = asObject(item.content);
		const title = data && typeof data.title === 'string' ? data.title.trim() : '';
		if (!ENV_NAME_RE.test(title) || DANGEROUS_KEYS.has(title)) {
			// A title that is not a valid env-var name cannot be injected; skip it
			// rather than fail the whole pull.
			continue;
		}
		const value = primarySecret(item);
		if (value === null) continue; // no injectable secret on this item
		if (seen.has(title)) {
			throw new PassCliError('Proton Pass vault has duplicate item titles');
		}
		seen.add(title);
		result[title] = value;
	}

	return result;
}

export const protonProvider: SecretProvider<ProtonConfig> = {
	type: 'proton',
	label: 'Proton Pass',
	supportsReferences: true,
	supportsBulk: true,

	isReference(value: unknown): value is string {
		return typeof value === 'string' && stripSurroundingQuotes(value).startsWith('pass://');
	},

	async testConnection(config: ProtonConfig): Promise<TestConnectionResult> {
		try {
			const token = accessToken(config);
			await withSession(token, async (session) => {
				const output = await executePassCli(session, ['info', '--output', 'json'], {
					timeoutMs: COMMAND_TIMEOUT_MS,
					stdoutBytes: LOGIN_OUTPUT_LIMIT,
					stderrBytes: STDERR_OUTPUT_LIMIT
				});
				output.fill(0);
			});
			return { ok: true };
		} catch (error: unknown) {
			return { ok: false, error: sanitizedError(error) };
		}
	},

	async resolveSecretReferences(
		config: ProtonConfig,
		refs: string[],
		logPrefix = ''
	): Promise<Map<string, string>> {
		const token = accessToken(config);
		const unique = [...new Set(refs)];
		return withSession(token, async (session) => {
			const resolved = new Map<string, string>();
			for (const raw of unique) {
				let ref: string;
				try {
					ref = passReference(raw);
				} catch {
					continue; // malformed reference: leave the literal in place
				}
				let output: Buffer | undefined;
				try {
					// A field-targeted `item view` prints the bare field value on stdout
					// (no JSON envelope); a trailing newline is the only decoration.
					output = await executePassCli(session, ['item', 'view', ref], {
						timeoutMs: COMMAND_TIMEOUT_MS,
						stdoutBytes: VIEW_OUTPUT_LIMIT,
						stderrBytes: STDERR_OUTPUT_LIMIT
					});
					const value = output.toString('utf8').replace(/\r?\n$/, '');
					if (value.includes('\0')) throw new PassCliError('field value is not valid text');
					resolved.set(raw, value);
				} catch (error: unknown) {
					// A single lookup failure is logged and skipped; the caller keeps
					// the literal. Transport-level failures still propagate below.
					console.warn(`${logPrefix}Proton Pass reference did not resolve: ${sanitizedError(error)}`);
				} finally {
					output?.fill(0);
				}
			}
			return resolved;
		});
	},

	async resolveBulk(config: ProtonConfig, selector: string): Promise<Record<string, string>> {
		try {
			const token = accessToken(config);
			const vault = vaultName(selector);
			return await withSession(token, async (session) => {
				let output: Buffer | undefined;
				try {
					output = await executePassCli(
						session,
						['item', 'list', '--vault-name', vault, '--output', 'json', '--show-secrets'],
						{
							timeoutMs: COMMAND_TIMEOUT_MS,
							stdoutBytes: LIST_OUTPUT_LIMIT,
							stderrBytes: STDERR_OUTPUT_LIMIT
						}
					);
					return bulkRecord(parseJson(output));
				} finally {
					output?.fill(0);
				}
			});
		} catch (error: unknown) {
			if (error instanceof PassCliError) throw error;
			throw new PassCliError(sanitizedError(error));
		}
	}
};

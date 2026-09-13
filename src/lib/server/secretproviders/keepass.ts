/**
 * KeePassXC provider.
 *
 * An adapter around an operator-installed `keepassxc-cli` executable reading a
 * local `.kdbx` database (bind-mounted into the Dockhand container). Dockhand
 * does not distribute the client and does not implement the KeePass format.
 *
 * keepassxc-cli is STATELESS per call: each command opens the database, reads,
 * and exits. The master password is fed on STDIN (never on argv, so it is not
 * exposed on the process's /proc/<pid>/cmdline); an optional key file is passed
 * by path. Two resolution modes:
 *   - Bulk pull: `ls -R -f` lists every entry path; each entry's Password becomes
 *     one env var keyed by the entry title (must be a valid env-var name).
 *   - Inline references: `keepass://GROUP/ENTRY/FIELD` - the last segment is the
 *     attribute (Password by default is what a bare title maps to; here FIELD is
 *     explicit), everything before it is the entry path (groups may nest). Resolved
 *     with `show <entry> -q -s -a <FIELD>`, which prints the bare value on stdout.
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { KeePassConfig, SecretProvider, TestConnectionResult } from './shared';
import { stripSurroundingQuotes } from './shared';

const DEFAULT_CLI_PATH = '/usr/bin/keepassxc-cli';
const COMMAND_TIMEOUT_MS = 30_000;
const LIST_OUTPUT_LIMIT = 10 * 1024 * 1024;
const SHOW_OUTPUT_LIMIT = 1 * 1024 * 1024;
const STDERR_OUTPUT_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 2_000;

// keepass://GROUP/ENTRY/FIELD. Groups may nest (any number of "/"), so the entry
// path is everything up to the LAST segment, which is the attribute name. The ref
// is passed to keepassxc-cli as single argv elements (spawn shell:false), so spaces
// in a group/entry/field are safe; we only forbid control chars and empty segments.
const KEEPASS_PREFIX = 'keepass://';
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class KeePassCliError extends Error {
	/** True for a FAILURE TO RUN the command (timeout, output-limit kill, spawn error)
	 *  as opposed to the command running and exiting non-zero (bad group / password /
	 *  entry). A bulk group listing may treat a non-operational error as "empty group",
	 *  but an operational error must fail the deploy - it does NOT mean the group is
	 *  empty, and swallowing it ships a stack with blank secrets. */
	readonly operational: boolean;
	constructor(message: string, operational = false) {
		super(message);
		this.name = 'KeePassCliError';
		this.operational = operational;
	}
}

interface ParsedRef {
	entry: string;
	field: string;
}

function executablePath(): string {
	const override = process.env.DOCKHAND_KEEPASSXC_CLI_PATH?.trim();
	if (!override) return DEFAULT_CLI_PATH;
	if (!isAbsolute(override)) {
		// Operational: we can't even locate the executable, same class as ENOENT - it must
		// fail the deploy, not be swallowed as an empty group.
		throw new KeePassCliError('KeePassXC keepassxc-cli executable path must be absolute', true);
	}
	return override;
}

function spawnFailure(error: unknown): KeePassCliError {
	const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
	if (code === 'ENOENT') return new KeePassCliError('KeePassXC keepassxc-cli executable was not found', true);
	if (code === 'EACCES') return new KeePassCliError('KeePassXC keepassxc-cli executable is not executable', true);
	return new KeePassCliError('KeePassXC keepassxc-cli executable could not be started', true);
}

/**
 * keepassxc-cli exits 1 for EVERY error (no distinct codes) and we never retain its
 * stderr (it can echo secret data), so we can't read the exact cause. But the COMMAND
 * narrows the likely reason, which is far more useful than one generic "wrong
 * password/entry" string that made a bad group selector look like a credentials error.
 */
function nonZeroExitMessage(command: string | undefined): string {
	switch (command) {
		case 'db-info':
			return 'KeePassXC could not open the database (wrong password or key file, or the .kdbx path is unreadable)';
		case 'ls':
			return 'KeePassXC could not list the group (the group name may not exist, or the database could not be opened)';
		case 'show':
			return 'KeePassXC could not read the entry (the entry path may not exist)';
		default:
			return 'KeePassXC keepassxc-cli command failed';
	}
}

/** Path arguments (database, key file) must be absolute and free of NUL / control chars. */
function safePath(value: string, label: string): string {
	const p = typeof value === 'string' ? value.trim() : '';
	if (!p) throw new KeePassCliError(`KeePassXC ${label} is empty`);
	if (!isAbsolute(p) || p.includes('\0') || /[\n\r\t]/.test(p) || p.startsWith('-')) {
		throw new KeePassCliError(`KeePassXC ${label} is invalid`);
	}
	return p;
}

/**
 * Base argv for a database command: the .kdbx path plus the auth flags. Password (if any)
 * goes on stdin, not here. `--no-password` is passed when no password is configured so a
 * key-file-only database opens without prompting.
 */
function dbArgs(config: KeePassConfig): { path: string; keyFile?: string; hasPassword: boolean; flags: string[] } {
	const path = safePath(config.databasePath, 'database path');
	const hasPassword = typeof config.password === 'string' && config.password.length > 0;
	const keyFile = config.keyFilePath ? safePath(config.keyFilePath, 'key file path') : undefined;
	if (!hasPassword && !keyFile) {
		throw new KeePassCliError('KeePassXC needs a password or a key file');
	}
	const flags: string[] = ['-q'];
	if (keyFile) flags.push('-k', keyFile);
	if (!hasPassword) flags.push('--no-password');
	return { path, keyFile, hasPassword, flags };
}

/**
 * Run one keepassxc-cli process without a shell, feeding the master password on stdin,
 * while bounding lifetime and output. stdout is captured; stderr byte count only.
 */
async function executeKeepass(args: string[], password: string | undefined, stdoutLimit: number): Promise<Buffer> {
	const stdoutChunks: Buffer[] = [];
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let failure: KeePassCliError | undefined;
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const child = spawn(executablePath(), args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false
			});

			const terminate = (error: KeePassCliError) => {
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
				() => terminate(new KeePassCliError('KeePassXC keepassxc-cli command timed out', true)),
				COMMAND_TIMEOUT_MS
			);

			// The password (plus the newline keepassxc-cli waits for) is written to stdin and
			// the stream is ended. A key-file-only db gets no password: stdin is just closed.
			child.stdin?.on('error', () => {
				/* a closed stdin (fast exit / no prompt) is not fatal on its own */
			});
			if (password) {
				const buf = Buffer.from(`${password}\n`, 'utf8');
				child.stdin?.end(buf, () => buf.fill(0));
			} else {
				child.stdin?.end();
			}

			child.stdout?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += data.length;
				if (stdoutBytes > stdoutLimit) {
					terminate(new KeePassCliError('KeePassXC keepassxc-cli command exceeded the stdout limit', true));
					return;
				}
				stdoutChunks.push(Buffer.from(data));
			});

			// stderr is deliberately never retained: only its byte count is observed.
			child.stderr?.on('data', (chunk: Buffer | string) => {
				if (failure) return;
				stderrBytes += Buffer.byteLength(chunk);
				if (stderrBytes > STDERR_OUTPUT_LIMIT) {
					terminate(new KeePassCliError('KeePassXC keepassxc-cli command exceeded the stderr limit', true));
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
					reject(new KeePassCliError(nonZeroExitMessage(args[0])));
					return;
				}
				resolve(Buffer.concat(stdoutChunks, stdoutBytes));
			});
		});
	} finally {
		for (const chunk of stdoutChunks) chunk.fill(0);
	}
}

/** `keepass://GROUP/ENTRY/FIELD` -> `{ entry, field }`. The last path segment is the field. */
function parseReference(value: string): ParsedRef {
	const ref = value.trim();
	if (!ref.startsWith(KEEPASS_PREFIX)) {
		throw new KeePassCliError('KeePassXC reference must start with keepass://');
	}
	const rest = ref.slice(KEEPASS_PREFIX.length);
	if (rest.includes('\0') || /[\n\r\t]/.test(rest)) {
		throw new KeePassCliError('KeePassXC reference contains invalid characters');
	}
	const segments = rest.split('/');
	if (segments.length < 2 || segments.some((s) => s.length === 0)) {
		throw new KeePassCliError('KeePassXC reference must be keepass://GROUP/ENTRY/FIELD (a field is required)');
	}
	const field = segments.pop() as string;
	const entry = segments.join('/');
	// keepassxc-cli parses a leading "-" as a flag, not a positional argument, so an
	// operator-controlled entry/field beginning with "-" would inject a flag. Reject it
	// (a real KeePass title/attribute never starts with "-" in practice).
	if (entry.startsWith('-') || field.startsWith('-')) {
		throw new KeePassCliError('KeePassXC reference entry and field must not start with "-"');
	}
	return { entry, field };
}

function sanitizedError(error: unknown): string {
	return error instanceof KeePassCliError ? error.message : 'KeePassXC keepassxc-cli operation failed';
}

export const keepassProvider: SecretProvider<KeePassConfig> = {
	type: 'keepass',
	label: 'KeePassXC',
	supportsReferences: true,
	supportsBulk: true,

	isReference(value: unknown): value is string {
		return typeof value === 'string' && stripSurroundingQuotes(value).startsWith(KEEPASS_PREFIX);
	},

	async testConnection(config: KeePassConfig): Promise<TestConnectionResult> {
		try {
			const { path, flags } = dbArgs(config);
			// `db-info` opens the database and prints metadata; it fails on a bad
			// password/key file, so a clean exit proves the credentials open the db.
			const output = await executeKeepass(['db-info', ...flags, path], config.password, SHOW_OUTPUT_LIMIT);
			output.fill(0);
			return { ok: true };
		} catch (error: unknown) {
			return { ok: false, error: sanitizedError(error) };
		}
	},

	async resolveSecretReferences(
		config: KeePassConfig,
		refs: string[],
		logPrefix = ''
	): Promise<Map<string, string>> {
		const { path, flags } = dbArgs(config);
		const unique = [...new Set(refs)];
		const resolved = new Map<string, string>();
		for (const raw of unique) {
			let parsed: ParsedRef;
			try {
				parsed = parseReference(raw);
			} catch {
				continue; // malformed reference: leave the literal in place
			}
			let output: Buffer | undefined;
			try {
				// `show <db> <entry> -s -a <field>` prints the bare attribute value.
				output = await executeKeepass(
					['show', ...flags, path, parsed.entry, '-s', '-a', parsed.field],
					config.password,
					SHOW_OUTPUT_LIMIT
				);
				const value = output.toString('utf8').replace(/\r?\n$/, '');
				if (value.includes('\0')) throw new KeePassCliError('field value is not valid text');
				resolved.set(raw, value);
			} catch (error: unknown) {
				console.warn(`${logPrefix}KeePassXC reference did not resolve: ${sanitizedError(error)}`);
			} finally {
				output?.fill(0);
			}
		}
		return resolved;
	},

	async resolveBulk(config: KeePassConfig, selector: string): Promise<Record<string, string>> {
		try {
			const { path, flags } = dbArgs(config);
			const group = typeof selector === 'string' ? selector.trim() : '';
			if (group.includes('\0') || /[\n\r\t]/.test(group) || group.startsWith('-')) {
				throw new KeePassCliError('KeePassXC group selector is invalid');
			}
			// `ls -R -f` prints every entry as a full path (groups end with "/", entries do not).
			// An empty selector lists from the root group. `-f` gives flat, full paths.
			const lsArgs = group ? ['ls', ...flags, '-R', '-f', path, group] : ['ls', ...flags, '-R', '-f', path];
			let listOut: Buffer | undefined;
			let entryPaths: string[];
			try {
				listOut = await executeKeepass(lsArgs, config.password, LIST_OUTPUT_LIMIT);
				entryPaths = listOut
					.toString('utf8')
					.split('\n')
					.map((l) => l.replace(/\r$/, '')) // strip only CR, not a legit trailing space in a title
					.filter((l) => l.length > 0 && !l.endsWith('/')); // drop group lines
			} catch (error: unknown) {
				// A non-zero `ls` means either the group does not exist OR the database could
				// not be opened (wrong password after a rotation, corrupt/unreadable db). We
				// can't tell them apart reliably (same exit code, locale-dependent stderr), and
				// both should FAIL the deploy rather than silently bring a stack up with blank
				// secrets. The message names both possibilities.
				if (error instanceof KeePassCliError && error.operational) throw error;
				throw new KeePassCliError(nonZeroExitMessage('ls'), true);
			} finally {
				listOut?.fill(0);
			}

			const result = Object.create(null) as Record<string, string>;
			const seen = new Set<string>();
			for (const entryPath of entryPaths) {
				// keepassxc-cli reads a leading "-" as a flag; skip a path whose first
				// segment starts with "-" so it can never inject one into `show`.
				if (entryPath.startsWith('-')) {
					console.warn(`KeePassXC bulk skipped entry "${entryPath}" (path starts with "-")`);
					continue;
				}
				// Key the env var by the entry's leaf title; skip titles that are not valid
				// env-var names rather than failing the whole pull. Warn so a title with a
				// dash/space (e.g. "test-test") isn't silently dropped - a common surprise.
				const title = entryPath.split('/').pop() ?? '';
				if (!ENV_NAME_RE.test(title) || DANGEROUS_KEYS.has(title)) {
					console.warn(`KeePassXC bulk skipped entry "${entryPath}": title "${title}" is not a valid environment variable name`);
					continue;
				}
				// The same title in different subgroups is common in KeePass and can't map to
				// two env vars. Keep the FIRST resolved one and skip later duplicates with a
				// warning, rather than failing the whole deploy.
				if (seen.has(title)) {
					console.warn(`KeePassXC bulk skipped a duplicate entry title "${title}" (${entryPath}); the first match is used`);
					continue;
				}
				let showOut: Buffer | undefined;
				try {
					showOut = await executeKeepass(
						['show', ...flags, path, entryPath, '-s', '-a', 'Password'],
						config.password,
						SHOW_OUTPUT_LIMIT
					);
					const value = showOut.toString('utf8').replace(/\r?\n$/, '');
					if (!value || value.includes('\0')) continue; // no usable password on this entry
					seen.add(title);
					result[title] = value;
				} catch (error: unknown) {
					// One unreadable entry (e.g. a title the flat ls path can't re-address) is
					// skipped, not fatal - mirrors resolveSecretReferences. The db-open failure
					// already surfaced on the ls above, so this is genuinely per-entry.
					console.warn(`KeePassXC bulk entry did not resolve: ${sanitizedError(error)}`);
				} finally {
					showOut?.fill(0);
				}
			}
			return result;
		} catch (error: unknown) {
			if (error instanceof KeePassCliError) throw error;
			throw new KeePassCliError(sanitizedError(error));
		}
	}
};

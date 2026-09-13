/**
 * Pure helper functions for backup/restore operations.
 *
 * Every function here is a (input) → (output) — no side effects, no I/O,
 * no globals, no DB. Safe to call in any context and to unit-test in isolation.
 */

import { join } from 'node:path';
import { isValidCron } from '../scheduler/cron-utils';
import { privateIpReason, dangerousHostReason, isSafeWebhookUrl, isSafeNotificationUrl } from '../url-safety';
import { BackupError, isLocalRepo } from './models';
export { privateIpReason };

// Restic exits 10 when the repo isn't initialized.
export const RESTIC_EXIT_REPO_NOT_FOUND = 10;

/** Parse a stored JSON retention policy. Bad/missing JSON → empty object
 * (the caller skips retention rather than crashing on corrupt config data). */
export function parseRetentionJson(retention: string | null | undefined): Record<string, any> {
	if (!retention) return {};
	try { return JSON.parse(retention); } catch { return {}; }
}

/** Parse stored backup options JSON. Same contract as parseRetentionJson. */
export function parseOptionsJson(options: string | null | undefined): Record<string, any> {
	if (!options) return {};
	try { return JSON.parse(options); } catch (err) {
		// eslint-disable-next-line no-console
		console.warn(`[Backup] Failed to parse options JSON: ${err instanceof Error ? err.message : String(err)}`);
		return {};
	}
}

/** The job.options shape a backup run consumes (subset of what's persisted on a config). */
export interface JobOptions {
	excludePatterns?: string[];
	excludeCaches?: boolean;
	compression?: string;
	limitUpload?: number;
	limitDownload?: number;
	webhookSuccess?: string;
	webhookFailure?: string;
	excludedStackFiles?: string[];
}

/**
 * Map a config's stored options (from parseOptionsJson) into the job.options a backup run uses.
 * Pure so a SAVED backup (scheduled or "run now") gets EXACTLY the same options as an in-request
 * run. Every persisted field must be forwarded here, or it silently vanishes on the config-driven path.
 */
export function buildJobOptions(opts: Record<string, any>): JobOptions {
	return {
		excludePatterns: typeof opts.excludePatterns === 'string'
			? opts.excludePatterns.split(',').map((s: string) => s.trim()).filter(Boolean)
			: undefined,
		excludeCaches: opts.excludeCaches,
		compression: opts.compression,
		limitUpload: opts.limitUpload,
		limitDownload: opts.limitDownload,
		webhookSuccess: typeof opts.webhookSuccess === 'string' ? opts.webhookSuccess : undefined,
		webhookFailure: typeof opts.webhookFailure === 'string' ? opts.webhookFailure : undefined,
		excludedStackFiles: Array.isArray(opts.excludedStackFiles) ? opts.excludedStackFiles : undefined,
	};
}

/** A destination's extra restic flags, split by scope. `backup` applies to backup + repo
 * ops; `restore` applies only to `restic restore`. */
export interface BackupFlags {
	backup: string;
	restore: string;
}

/**
 * Parse the stored `flags` column into typed {backup, restore}. The column is a JSON
 * object `{"backup":"...","restore":"..."}`. A LEGACY value (a bare flag string like
 * `--limit-upload 5120`, or malformed JSON) is treated as BACKUP flags with an empty
 * restore string. SINGLE place that string-vs-JSON is decided, so the ambiguity can't
 * leak elsewhere.
 */
export function parseBackupFlags(flags: string | null | undefined): BackupFlags {
	if (!flags || !flags.trim()) return { backup: '', restore: '' };
	const trimmed = flags.trim();
	// Only a JSON OBJECT counts as the new shape; anything else is a legacy flag string.
	if (trimmed.startsWith('{')) {
		try {
			const o = JSON.parse(trimmed);
			if (o && typeof o === 'object' && !Array.isArray(o)) {
				return {
					backup: typeof o.backup === 'string' ? o.backup : '',
					restore: typeof o.restore === 'string' ? o.restore : '',
				};
			}
		} catch { /* fall through to legacy */ }
	}
	return { backup: trimmed, restore: '' };   // legacy bare string = backup flags
}

/** Serialize typed {backup, restore} back into the JSON stored in the `flags` column.
 * Returns null when both are empty (keeps the column NULL rather than storing `{}`). */
export function serializeBackupFlags(f: BackupFlags): string | null {
	const backup = (f.backup ?? '').trim();
	const restore = (f.restore ?? '').trim();
	if (!backup && !restore) return null;
	return JSON.stringify({ backup, restore });
}

/**
 * Parse a stored `selected_volumes` JSON blob into a `string[]` or null. Guards the SHAPE,
 * not just the JSON: a corrupt/legacy row holding a string (or other non-array) must NOT
 * flow into `new Set(...)` as an iterable-of-chars, which would match no volume key and
 * silently filter EVERY volume out (a metadata-only snapshot reported as success). Any
 * non-array parses to null = "all volumes" (the safe default).
 */
export function parseSelectedVolumes(raw: string | null | undefined): string[] | null {
	if (!raw) return null;
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return null; }
	if (!Array.isArray(parsed)) return null;
	return parsed.filter((x): x is string => typeof x === 'string');
}

/**
 * Parse a stored destination `policies` JSON blob. Bad/missing JSON → empty
 * object, logging ONCE so a corrupt policies field is diagnosable rather than
 * silently disabling autoUnlock/prune/check/verify.
 */
export function parsePoliciesJson(policies: string | null | undefined): Record<string, any> {
	if (!policies) return {};
	try {
		return JSON.parse(policies);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn(`[Backup] Ignoring malformed destination policies JSON: ${err instanceof Error ? err.message : String(err)}`);
		return {};
	}
}

/** The five recognised retention keep-* keys. */
const RETENTION_KEEP_KEYS = ['keepLast', 'keepDaily', 'keepWeekly', 'keepMonthly', 'keepYearly'] as const;

/**
 * Validate a retention policy object before it is persisted. Retention is
 * optional (null/undefined → ok). When present, each supplied keep-* value must
 * be a non-negative integer within a sane cap; anything else (negative,
 * fractional, string, NaN, Infinity) is rejected so corrupt retention can never
 * reach restic's `--keep-*` args (where it would silently throw and be swallowed
 * while the run still reports success).
 */
export function validateRetention(retention: unknown): { ok: true } | { ok: false; reason: string } {
	if (retention === null || retention === undefined) return { ok: true };
	if (typeof retention !== 'object' || Array.isArray(retention)) {
		return { ok: false, reason: 'retention must be an object' };
	}
	for (const key of RETENTION_KEEP_KEYS) {
		const v = (retention as Record<string, unknown>)[key];
		if (v === undefined || v === null) continue;
		if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10000) {
			return { ok: false, reason: `retention.${key} must be an integer between 0 and 10000` };
		}
	}
	return { ok: true };
}

/**
 * Repository backends restic supports that Dockhand allows. A local repository
 * is a plain absolute path (leading '/'); everything else must carry one of
 * these scheme prefixes. Single source of truth for the create/update/test
 * save-time validation.
 */
// Only the backends selectable in the destination form and verified end to end.
// Add a scheme back here only once it has a form entry and a passing round-trip test.
export const ALLOWED_REPO_SCHEMES = ['rest:', 's3:', 'b2:', 'azure:', 'gs:'] as const;

/** True iff `repository` is a local absolute path or a supported scheme URL. */
export function isAllowedRepository(repository: string | null | undefined): boolean {
	if (!repository || typeof repository !== 'string') return false;
	const repo = repository.trim();
	if (isLocalRepo(repo)) return true;
	return ALLOWED_REPO_SCHEMES.some((s) => repo.startsWith(s));
}

/**
 * Redact a webhook URL for logging. maskRepositoryUrl only hides `user:pass@`
 * userinfo, leaving path/query intact — so a secret embedded in a
 * healthchecks-style path or a `?token=` query would be logged verbatim. This
 * keeps only origin + the first path segment and drops the query entirely.
 * Fails closed: an unparseable URL yields a constant placeholder, never the raw
 * string. The RAW url must still be used for the actual fetch — this is
 * logging-only.
 */
export function sanitizeWebhookUrlForLog(raw: string): string {
	try {
		const u = new URL(raw);
		const segments = u.pathname.split('/').filter(Boolean);
		if (segments.length === 0) return u.origin;
		// keep only the first path segment; redact the rest and the query.
		return `${u.origin}/${segments[0]}${segments.length > 1 ? '/***' : ''}`;
	} catch {
		return '<webhook>';
	}
}

/**
 * Fire a per-config backup webhook with a JSON payload. Best-effort and
 * fire-and-forget: a webhook never changes the backup outcome. Three hardening layers:
 *   - SSRF literal-host guard (isSafeWebhookUrl): block loopback/private/metadata.
 *   - DNS-rebinding guard: resolve the hostname and re-check EVERY resolved IP
 *     against the private/metadata ranges before connecting, so a public-looking
 *     name that resolves to an internal IP can't slip past the literal check.
 *   - Redacted logging (sanitizeWebhookUrlForLog): never log the raw URL, since a
 *     secret may live in its path/query (healthchecks uuid, ?token=).
 * POSTs JSON; falls back to a bare GET for simple receivers (ntfy, healthchecks).
 * `timestamp` is stamped here so callers pass only the domain payload.
 *
 * `deps` is injectable purely so the unit tests can exercise the guard/branch
 * logic without real network or DNS; production passes nothing.
 */
export interface FireWebhookDeps {
	fetch: typeof globalThis.fetch;
	resolveHost: (host: string) => Promise<string[]>;
	log: (msg: string) => void;
	now: () => string;
}

export function fireWebhook(
	url: string,
	payload: Record<string, unknown>,
	deps: Partial<FireWebhookDeps> = {},
): Promise<void> {
	const log = deps.log ?? (() => {});
	const doFetch = deps.fetch ?? globalThis.fetch;
	const now = deps.now ?? (() => new Date().toISOString());
	const resolveHost = deps.resolveHost ?? (async (host: string) => {
		const dns = await import('node:dns/promises');
		return (await dns.lookup(host, { all: true })).map((a) => a.address);
	});

	// Webhooks are self-hosted RECEIVERS (ntfy / healthchecks / a Slack relay on the
	// user's own LAN), same trust model as notification channels — so we use the
	// NOTIFICATION-grade policy (block loopback + cloud-metadata + reserved, but
	// ALLOW private LAN ranges), NOT the strict backup-DESTINATION policy that
	// blocks all private IPs. Loopback (127.x) and metadata (169.254.169.254) stay
	// blocked, both on the literal host and on every DNS-resolved IP below.
	const safe = isSafeNotificationUrl(url);
	if (!safe.ok) { log(`Webhook blocked: ${safe.reason}`); return Promise.resolve(); }
	const safeUrl = sanitizeWebhookUrlForLog(url);

	return (async () => {
		// DNS-rebinding guard — resolve real hostnames (IP literals already judged).
		try {
			const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
			if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
				const addrs = await resolveHost(host);
				for (const addr of addrs) {
					const reason = dangerousHostReason(addr);
					if (reason) { log(`Webhook blocked: host ${host} resolves to a disallowed address (${reason})`); return; }
				}
			}
		} catch (err) {
			log(`Webhook blocked: could not resolve host (${err instanceof Error ? err.message : String(err)})`);
			return;
		}

		const body = JSON.stringify({ ...payload, timestamp: now() });
		try {
			await doFetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				signal: AbortSignal.timeout(10000),
			});
			log(`Webhook POST sent to ${safeUrl}`);
		} catch {
			// Fall back to GET for receivers that only support a ping (ntfy, healthchecks).
			try {
				await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
				log(`Webhook GET fallback sent to ${safeUrl}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[Backup] Webhook delivery failed for ${safeUrl}: ${msg}`);
				log(`Webhook failed: ${msg}`);
			}
		}
	})();
}

/** True iff this looks like a restic-not-initialized error. */
export function isRepoNotInitializedError(error: unknown): boolean {
	return (error as any)?.exitCode === RESTIC_EXIT_REPO_NOT_FOUND;
}

/**
 * Classify a backup/restore failure into a small, stable, machine-readable
 * vocabulary so failures can be alerted/grouped by category rather than only
 * stored as opaque free-text. Total function — always returns a value; UNKNOWN
 * is the safe default. Classify the ORIGINAL error (not a human-cleaned message).
 */
export function classifyBackupError(error: unknown): string {
	if (isRepoNotInitializedError(error)) return 'REPO_NOT_INIT';
	const raw = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
	// A killed/cancelled restic (slow remote backend, watchdog timeout) reports its
	// OWN exit as `signal terminated` / `context canceled`, and restic then prints a
	// MISLEADING `code:12 wrong password or no key found` because it was interrupted
	// mid key-load. Catch the termination markers FIRST so a timeout is never
	// mis-surfaced to the user as a bad password.
	if (raw.includes('sigterm') || raw.includes('sigkill') || raw.includes('signal terminated') || raw.includes('signal killed') || raw.includes('context canceled') || raw.includes('context cancelled') || raw.includes('timed out') || raw.includes('timeout')) return 'RESTIC_TIMEOUT';
	if (raw.includes('wrong password') || raw.includes('invalid password') || raw.includes('no key found')) return 'WRONG_PASSWORD';
	if (raw.includes('already locked') || raw.includes('unable to create lock') || raw.includes('repository is already locked')) return 'REPO_LOCKED';
	if (raw.includes('no volumes') || raw.includes('nothing to backup')) return 'NO_VOLUMES';
	if (raw.includes('external stack') || raw.includes('cannot back up this stack')) return 'EXTERNAL_STACK';
	if (raw.includes('network') || raw.includes('connection refused') || raw.includes('dial tcp') || raw.includes('no such host') || raw.includes('timeout awaiting')) return 'NETWORK';
	return 'UNKNOWN';
}

/** Validate restic snapshot ID format (hex string, 8-64 chars).
 * Guards every restore/browse endpoint from arbitrary input — without this,
 * a request could ship `..%2F..%2Fetc` style payloads into restic CLI args. */
export function isValidSnapshotId(id: string): boolean {
	return /^[0-9a-f]{8,64}$/.test(id);
}

/** Clean embedded JSON from error messages.
 *
 * Restic emits errors like `Fatal: {"message":"wrong password or no key found"}`
 * — useful for the API, terrible for users. This unwraps the JSON and surfaces
 * the human message, with the surrounding prefix preserved. Also strips ANSI
 * colour escapes that restic sometimes emits when stderr is a TTY (the helper
 * container's stderr looks like a TTY to restic). */
// cleanErrorMsg lives in error-message.ts; re-exported so importers of helpers.ts keep working.
export { cleanErrorMsg } from './error-message';

/**
 * The delete-everything guard for `restic forget --dry-run --json`. Re-exported from retention.ts
 * (`checkWouldWipe`) so this data-loss guard lives in exactly one place - a second copy could drift.
 */
export { checkWouldWipe as wouldDeleteAllSnapshots } from './retention';

// -----------------------------------------------------------------------------
// restic subprocess hardening
// -----------------------------------------------------------------------------

// Base process-env vars restic legitimately needs (PATH/HOME/temp/proxy/TLS).
// Everything else — ENCRYPTION_KEY, DATABASE_URL, and any other operator secret
// on Dockhand's process.env — is deliberately excluded so a restic-side
// compromise or crash can't exfiltrate the master key.
const RESTIC_BASE_ENV_ALLOW = new Set([
	'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ',
	'TMPDIR', 'TMP', 'TEMP',
	'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
	'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
	'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
	'RESTIC_CACHE_DIR', 'RESTIC_PROGRESS_FPS'
]);

// Prefixes of destination-supplied cloud credential vars restic/its backends
// consume. Destination envVars are allowlisted to these so a malicious envVars
// map can't inject PATH/LD_PRELOAD/LD_LIBRARY_PATH and hijack the restic binary.
// Kept in sync with ALLOWED_REPO_SCHEMES: only the enabled backends' credential
// prefixes.
const CLOUD_ENV_PREFIXES = [
	'AWS_', 'AZURE_', 'B2_', 'GOOGLE_', 'GCS_', 'GS_',
	'RESTIC_REST_', 'ALIYUN_', 'BACKBLAZE_'
];
// A few exact cloud var names that don't share a prefix.
const CLOUD_ENV_EXACT = new Set([
	'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
	'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE',
	'DIGITALOCEAN_TOKEN', 'CLOUDFLARE_API_TOKEN'
]);

function isAllowedCloudEnv(key: string): boolean {
	if (CLOUD_ENV_EXACT.has(key)) return true;
	return CLOUD_ENV_PREFIXES.some(p => key.startsWith(p));
}

/**
 * Filter a destination's decrypted envVars down to the cloud-credential
 * allowlist. Used when building the env for a restic HELPER CONTAINER — the
 * container doesn't inherit the host process.env, but a malicious envVars map
 * could still set PATH/LD_PRELOAD inside the helper.
 */
export function filterCloudEnvVars(envVars: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(envVars || {})) {
		if (isAllowedCloudEnv(k)) out[k] = v;
	}
	return out;
}

// SSRF URL-safety primitives live in the neutral $lib/server/url-safety module
// (shared by backups + notifications). Re-exported here so backup-side importers keep resolving.
export { isSafeWebhookUrl };

/**
 * Build the environment for a restic subprocess from an allowlisted base plus
 * the destination's own repo/password/cloud-creds — never the full process.env.
 * Prevents ENCRYPTION_KEY / DATABASE_URL leakage and blocks PATH/LD_PRELOAD
 * injection via destination envVars.
 */
export function buildResticEnv(
	procEnv: Record<string, string | undefined>,
	opts: { repository: string; password: string; envVars?: Record<string, string> }
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(procEnv)) {
		if (v !== undefined && RESTIC_BASE_ENV_ALLOW.has(k)) env[k] = v;
	}
	// Persist restic's cache under DATA_DIR (a durable volume) instead of the default
	// $HOME/.cache/restic on the container's ephemeral RW layer, which is wiped on every
	// redeploy. A cold cache re-fetches the repo index from the remote backend (backblaze/
	// S3) on the first ls/snapshots/dump after a redeploy - ~3x slower and enough to trip a
	// reverse proxy's idle timeout. Only for the host-side restic (this fn feeds runLocal +
	// destination test); the helper container builds its env separately (buildHelperEnv). An
	// operator-set RESTIC_CACHE_DIR (copied in above) wins.
	if (!env.RESTIC_CACHE_DIR) {
		env.RESTIC_CACHE_DIR = join(procEnv.DATA_DIR || '/app/data', '.restic-cache');
	}
	env.RESTIC_REPOSITORY = opts.repository;
	env.RESTIC_PASSWORD = opts.password;
	for (const [k, v] of Object.entries(opts.envVars || {})) {
		if (isAllowedCloudEnv(k)) env[k] = v;
	}
	return env;
}

// Restic flags a destination operator may append. Backup/global flags apply to backup +
// repo ops; restore flags apply ONLY to `restic restore` (which has its own flags like
// --exclude-xattr, #1349). The two are stored SEPARATELY (see BackupFlags), so a
// restore-only flag can never leak into `restic backup`. Anything that can read/write
// arbitrary files or run code (--option, --password-command, --cacert to an arbitrary
// path) is rejected. Flags may be `--flag` or `--flag=value`.
const RESTIC_BACKUP_FLAG_ALLOW = new Set([
	'--limit-upload', '--limit-download', '--no-cache', '--cleanup-cache',
	'--pack-size', '--compression', '--no-lock', '--json', '--quiet', '--verbose',
	'--tls-client-cert', '--retry-lock', '--insecure-tls'
]);

// Restore adds --exclude-xattr (restore-only in restic; #1349 SELinux xattr the
// unprivileged helper can't remove on a cross-distro restore).
const RESTIC_RESTORE_FLAG_ALLOW = new Set([...RESTIC_BACKUP_FLAG_ALLOW, '--exclude-xattr']);

// Allowlisted flags that take a VALUE. Written joined (`--retry-lock=10m`) or
// space-separated (`--retry-lock 10m`); in the space-separated form the FOLLOWING
// token is that value, not a flag, so it legitimately doesn't start with `--`.
const RESTIC_FLAG_TAKES_VALUE = new Set([
	'--limit-upload', '--limit-download', '--pack-size', '--compression',
	'--tls-client-cert', '--retry-lock', '--exclude-xattr'
]);

/** Core allowlist validator, parameterized by which allowlist applies. */
function sanitizeAgainst(flags: string | null | undefined, allow: Set<string>): string[] {
	if (!flags || !flags.trim()) return [];
	const tokens = flags.trim().split(/\s+/);
	const out: string[] = [];
	let expectValue = false;
	for (const tok of tokens) {
		if (expectValue) {
			out.push(tok);       // value of the previous space-separated value-taking flag
			expectValue = false;
			continue;
		}
		const name = tok.startsWith('--') ? tok.split('=')[0] : tok;
		if (!name.startsWith('--') || !allow.has(name)) {
			throw new Error(`Disallowed restic flag: ${tok}`);
		}
		out.push(tok);
		if (RESTIC_FLAG_TAKES_VALUE.has(name) && !tok.includes('=')) expectValue = true;
	}
	if (expectValue) throw new Error('Restic flag is missing its value');
	return out;
}

/**
 * Split and validate a destination's BACKUP/global extra restic flags against the backup
 * allowlist. Throws on any flag not allowed (never forwards --option/--password-command/etc).
 */
export function sanitizeResticFlags(flags: string | null | undefined): string[] {
	return sanitizeAgainst(flags, RESTIC_BACKUP_FLAG_ALLOW);
}

/** Split and validate a destination's RESTORE extra restic flags (backup allowlist plus
 * restore-only flags like --exclude-xattr). */
export function sanitizeRestoreFlags(flags: string | null | undefined): string[] {
	return sanitizeAgainst(flags, RESTIC_RESTORE_FLAG_ALLOW);
}

/**
 * Conservative default retention for SCHEDULED configs created without a policy —
 * otherwise their snapshots grow forever, since pruning is gated on a non-empty
 * keep-* policy.
 */
export const DEFAULT_SCHEDULED_RETENTION = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 };

/**
 * Serialize the retention to store: keep an explicit non-empty policy; apply the
 * default only for scheduled configs with no policy; otherwise null. Used by the
 * config create and update routes so both apply the same default.
 */
export function retentionToStore(retention: any, schedule: unknown): string | null {
	const hasRetention = retention && typeof retention === 'object' && Object.values(retention).some((v) => v);
	if (hasRetention) return JSON.stringify(retention);
	const scheduled = typeof schedule === 'string' && schedule.trim().length > 0;
	return scheduled ? JSON.stringify(DEFAULT_SCHEDULED_RETENTION) : null;
}

/**
 * Resolve the retention value to persist on a PARTIAL config update. `undefined` means
 * "leave the stored retention untouched" (the caller must skip the field). A minimal PUT
 * that only flips `enabled` (pause/resume) omits `retention`, so re-applying the scheduled
 * default here would silently wipe the user's policy (#1462). The default is applied ONLY
 * when the retention is actually provided, or when the schedule is being added/changed -
 * the transition the default exists to cover.
 */
export function resolveRetentionForUpdate(
	retention: unknown,
	newSchedule: unknown,
	existingSchedule: unknown
): string | null | undefined {
	const retentionProvided = retention !== undefined;
	const scheduleChanged = newSchedule !== undefined && newSchedule !== existingSchedule;
	if (!retentionProvided && !scheduleChanged) return undefined; // leave stored value as-is
	return retentionToStore(retention, newSchedule ?? existingSchedule);
}

/**
 * Decide the `enabled` flag when a backup config is updated. A "run once" backup persists a
 * MANUAL, paused config (schedule=null, enabled=false); adding a cron schedule later should make
 * it actually run, so a manual -> scheduled transition auto-enables it. A config that was ALREADY
 * scheduled is left alone, so a deliberately-paused scheduled backup stays paused across edits.
 * Applies to container and stack backups alike (both go through PUT).
 */
export function resolveEnabledOnScheduleChange(input: {
	requestedEnabled: unknown;
	existingSchedule: unknown;
	newSchedule: unknown;
}): boolean | undefined {
	const wasScheduled = typeof input.existingSchedule === 'string' && input.existingSchedule.trim().length > 0;
	const isScheduled = typeof input.newSchedule === 'string' && input.newSchedule.trim().length > 0;
	// Manual -> scheduled: force-enable, ignoring a stale requested `false`.
	if (!wasScheduled && isScheduled) return true;
	// Otherwise pass the request through UNCHANGED — a boolean is honoured, and
	// `undefined` (field absent) must stay undefined so the DB layer leaves the
	// existing value alone (returning false here would silently pause a config
	// on any PUT that omits `enabled`).
	return typeof input.requestedEnabled === 'boolean' ? input.requestedEnabled : undefined;
}

/**
 * Validate a destination repository at save time. Rejects unknown schemes, and
 * for URL-form backends (rest: and any scheme that embeds an http(s) host)
 * blocks loopback / cloud-metadata / reserved hosts to stop SSRF into internal
 * services, while allowing ordinary LAN ranges so a self-hosted repo (MinIO,
 * REST server) on the local network still works. Returns an error string or
 * null. Fail-closed: an unparseable URL-form repo is rejected.
 */
export function validateRepositoryForSave(repository: string): string | null {
	if (!isAllowedRepository(repository)) {
		return 'Invalid repository: must be a local absolute path or a supported scheme (rest:, s3:, b2:, azure:, gs:)';
	}
	const httpMatch = repository.match(/https?:\/\/[^\s]+/);
	if (httpMatch) {
		let host: string;
		try { host = new URL(httpMatch[0]).hostname; } catch { return 'Invalid repository URL'; }
		const reason = dangerousHostReason(host);
		if (reason) return `Repository host not allowed: ${reason}`;
	}
	return null;
}

/** Validate a destination's extra restic flags at save time. sanitizeResticFlags
 * throws on a disallowed flag; surface that as an error string, or null if ok. */
export function validateFlags(flags: unknown): string | null {
	if (flags === undefined || flags === null) return null;
	// The route may send either the split shape ({ backup, restore }) or a legacy bare
	// string. Validate each scope against its own allowlist (restore permits --exclude-xattr).
	const { backup, restore } = parseBackupFlags(typeof flags === 'string' ? flags : serializeBackupFlags(flags as BackupFlags) ?? '');
	try {
		sanitizeResticFlags(backup);
		sanitizeRestoreFlags(restore);
		return null;
	} catch (e) { return e instanceof Error ? e.message : 'Invalid restic flags'; }
}

/** Validate a raw {backup, restore} pair from the API and return the serialized flags
 * column value (JSON, or null when both empty), or throw with the allowlist error. */
export function validateAndSerializeFlags(backup: unknown, restore: unknown): string | null {
	const b = typeof backup === 'string' ? backup : '';
	const r = typeof restore === 'string' ? restore : '';
	sanitizeResticFlags(b);      // throws on a disallowed backup flag
	sanitizeRestoreFlags(r);     // throws on a disallowed restore flag
	return serializeBackupFlags({ backup: b, restore: r });
}

/**
 * Validate the prune/check/verify cron schedules embedded in a destination's
 * policies payload. `policies` is stored as a JSON string; accept either a
 * string or an already-parsed object. Returns an error message for the first
 * invalid non-empty schedule, or null if all are valid / absent.
 */
export function validatePolicySchedules(policies: unknown): string | null {
	if (policies == null) return null;
	let parsed: any;
	if (typeof policies === 'string') {
		try { parsed = JSON.parse(policies); } catch { return 'Invalid policies JSON'; }
	} else if (typeof policies === 'object') {
		parsed = policies;
	} else {
		return null;
	}
	for (const field of ['pruneSchedule', 'checkSchedule', 'verifySchedule'] as const) {
		const value = parsed?.[field];
		if (typeof value === 'string' && value.trim() && !isValidCron(value.trim())) {
			return `Invalid cron expression for ${field}: ${value}`;
		}
	}
	return null;
}

/** Race a promise against a timeout, throwing a clear BackupError on expiry. The
 * underlying request is left to settle on its own (Node can't force-abort an
 * already-issued socket write here), but the caller no longer waits on it. Used to
 * fail-fast on a stalled helper-image inspect/pull instead of hanging the backup. */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new BackupError('DOCKER', message)), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface SnapshotDiff {
	added: string[];
	removed: string[];
	modified: string[];
	metadataChanged: string[];
	raw: string;
}

/** Parse `restic diff --json` (one JSON object per line) into the structured shape
 * the UI expects. restic emits `{message_type:'change', path, modifier}` lines
 * where modifier is '+' (added), '-' (removed), 'M' (content) / 'U'|'T' (metadata
 * only, e.g. uid/gid/type). Non-JSON lines (older restic) fall back to the leading
 * `+ / - / M` column. */
export function parseResticDiff(raw: string): Omit<SnapshotDiff, 'raw'> {
	const added: string[] = [], removed: string[] = [], modified: string[] = [], metadataChanged: string[] = [];
	for (const line of raw.split('\n')) {
		const s = line.trim();
		if (!s) continue;
		let path: string | undefined, mod: string | undefined;
		try {
			const o = JSON.parse(s);
			if (o?.message_type && o.message_type !== 'change') continue; // skip summary/stats
			if (typeof o?.path === 'string') { path = o.path; mod = String(o.modifier ?? ''); }
		} catch {
			// Plain-text restic diff: "<modifier>    <path>"
			const m = s.match(/^([+\-MUT]+)\s+(.*)$/);
			if (m) { mod = m[1]; path = m[2]; }
		}
		if (!path || !mod) continue;
		if (mod.includes('+')) added.push(path);
		else if (mod.includes('-')) removed.push(path);
		else if (mod.includes('M')) modified.push(path);
		else metadataChanged.push(path); // U / T — mode/owner/type only
	}
	return { added, removed, modified, metadataChanged };
}

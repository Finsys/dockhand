/**
 * Pure helper functions for backup/restore operations.
 *
 * Every function here is a (input) → (output) — no side effects, no I/O,
 * no globals, no DB. Safe to call in any context and to unit-test in isolation.
 */

import { isValidCron } from '../scheduler/cron-utils';
import { privateIpReason, dangerousHostReason, isSafeWebhookUrl, isSafeNotificationUrl } from '../url-safety';
import { BackupError } from './models';
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

/**
 * Parse a stored destination `policies` JSON blob. Bad/missing JSON → empty
 * object, logging ONCE so a corrupt policies field is diagnosable rather than
 * silently disabling autoUnlock/prune/check/verify. This is the single source of
 * truth for the previously-duplicated inline IIFEs.
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
	if (repo.startsWith('/')) return true; // local absolute path
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
 * fire-and-forget: a webhook never changes the backup outcome. Ported from the
 * legacy engine, keeping its three hardening layers:
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
	if (raw.includes('sigterm') || raw.includes('sigkill') || raw.includes('timed out') || raw.includes('timeout')) return 'RESTIC_TIMEOUT';
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
export function cleanErrorMsg(msg: string): string {
	// Strip ANSI escape codes
	const clean = msg.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
	// Try parsing the whole string as JSON
	try { const p = JSON.parse(clean); if (p.message) return p.message; } catch { /* not pure JSON */ }
	// Try extracting embedded JSON — replace real newlines so JSON.parse works
	const jsonStart = clean.indexOf('{');
	const jsonEnd = clean.lastIndexOf('}');
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		try {
			const jsonStr = clean.slice(jsonStart, jsonEnd + 1).replace(/\n/g, '\\n');
			const parsed = JSON.parse(jsonStr);
			if (parsed.message) {
				const prefix = clean.slice(0, jsonStart).trim();
				const message = parsed.message.replace(/\\n/g, ' ').trim();
				return prefix ? `${prefix} ${message}` : message;
			}
			if (parsed.message_type) {
				// A killed helper appends restic's last --json PROGRESS line
				// (message_type, no `message`) to the exit-code detail — no error
				// text; drop it, keep just the readable prefix.
				const p2 = clean.slice(0, jsonStart).trim().replace(/:\s*$/, '');
				if (p2) return p2;
			}
		} catch { /* not embedded JSON */ }
	}
	return clean;
}

/**
 * Inspect `restic forget --dry-run --json` output and decide whether running
 * the real `forget --prune` would delete every snapshot in the targeted group.
 *
 * Restic's JSON shape for `forget` is an array of "forget groups", each with
 * `keep`, `remove`, and `reasons`. Snapshots are objects with an `id` field;
 * we count list lengths rather than poking at fields. When the policy keeps
 * zero and removes everything, that's the dangerous case we want to block.
 *
 * Empty/unparseable stdout → `{ wouldWipe: false, ... zeros }`. Restic emits
 * an empty array when the repo holds no snapshots, which is also "not a
 * wipe-out worth blocking" because there's nothing to lose.
 *
 * Pure function, no I/O — the caller runs it after running restic; tests can
 * pass canned stdout.
 */
export function wouldDeleteAllSnapshots(stdout: string): {
	wouldWipe: boolean;
	keep: number;
	remove: number;
	total: number;
} {
	let keep = 0;
	let remove = 0;
	// Restic forget --json emits a single JSON document (array of groups).
	// Parse the whole stdout once; ignore trailing whitespace.
	const trimmed = stdout.trim();
	if (!trimmed) return { wouldWipe: false, keep: 0, remove: 0, total: 0 };
	let parsed: unknown;
	try { parsed = JSON.parse(trimmed); } catch { return { wouldWipe: false, keep: 0, remove: 0, total: 0 }; }
	if (!Array.isArray(parsed)) return { wouldWipe: false, keep: 0, remove: 0, total: 0 };
	for (const group of parsed) {
		if (!group || typeof group !== 'object') continue;
		const g = group as { keep?: unknown[]; remove?: unknown[] };
		if (Array.isArray(g.keep)) keep += g.keep.length;
		if (Array.isArray(g.remove)) remove += g.remove.length;
	}
	const total = keep + remove;
	return { wouldWipe: total > 0 && keep === 0 && remove > 0, keep, remove, total };
}

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

// SSRF URL-safety primitives now live in the neutral $lib/server/url-safety
// module so subsystems (backups, notifications) import DOWN into a shared home
// rather than the notification router importing UP from the backup engine.
// Re-exported here so existing backup-side importers keep resolving unchanged.
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
	env.RESTIC_REPOSITORY = opts.repository;
	env.RESTIC_PASSWORD = opts.password;
	for (const [k, v] of Object.entries(opts.envVars || {})) {
		if (isAllowedCloudEnv(k)) env[k] = v;
	}
	return env;
}

// restic global/backup/restore flags that are safe for an operator to append
// per destination. Anything that can read/write arbitrary files or run code
// (--option, --password-command, --cacert to an arbitrary path, etc.) is
// rejected. Flags may be `--flag` or `--flag=value`.
const RESTIC_FLAG_ALLOW = new Set([
	'--limit-upload', '--limit-download', '--no-cache', '--cleanup-cache',
	'--pack-size', '--compression', '--no-lock', '--json', '--quiet', '--verbose',
	'--tls-client-cert', '--retry-lock', '--insecure-tls'
]);

// Allowlisted flags that take a VALUE. Written joined (`--retry-lock=10m`) or
// space-separated (`--retry-lock 10m`); in the space-separated form the FOLLOWING
// token is that value, not a flag, so it legitimately doesn't start with `--`.
const RESTIC_FLAG_TAKES_VALUE = new Set([
	'--limit-upload', '--limit-download', '--pack-size', '--compression',
	'--tls-client-cert', '--retry-lock'
]);

/**
 * Split and validate a destination's extra restic CLI flags against an
 * allowlist. Returns the accepted flag tokens; throws on any flag not in the
 * allowlist so we never forward attacker-controlled options like `--option`,
 * `--password-command`, or a bare non-flag argument. A value that follows a
 * space-separated value-taking flag (e.g. the `10m` in `--retry-lock 10m`) is
 * accepted as that flag's argument rather than treated as a flag itself.
 */
export function sanitizeResticFlags(flags: string | null | undefined): string[] {
	if (!flags || !flags.trim()) return [];
	const tokens = flags.trim().split(/\s+/);
	const out: string[] = [];
	let expectValue = false;
	for (const tok of tokens) {
		if (expectValue) {
			// This token is the value of the previous value-taking flag.
			out.push(tok);
			expectValue = false;
			continue;
		}
		const name = tok.startsWith('--') ? tok.split('=')[0] : tok;
		if (!name.startsWith('--') || !RESTIC_FLAG_ALLOW.has(name)) {
			throw new Error(`Disallowed restic flag: ${tok}`);
		}
		out.push(tok);
		// A space-separated value-taking flag (no `=value`) consumes the next token.
		if (RESTIC_FLAG_TAKES_VALUE.has(name) && !tok.includes('=')) expectValue = true;
	}
	if (expectValue) throw new Error('Restic flag is missing its value');
	return out;
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
 * Decide the `enabled` flag when a backup config is updated, auto-enabling a config
 * that gains a schedule.
 *
 * The motivating flow: a "run once" backup persists a MANUAL, paused config
 * (schedule=null, enabled=false) — correct on its own. But when the user later edits
 * that config to ADD a cron schedule, they expect it to actually run; leaving it
 * paused (because the run-once config was created disabled and the UI's Enabled
 * toggle still reflected that) is a surprise that forces a manual un-pause on the
 * Schedules page. So: a transition from manual (no schedule) to scheduled (a real
 * cron) auto-enables the config.
 *
 * This deliberately does NOT touch a config that was ALREADY scheduled — a user who
 * paused a scheduled backup on purpose keeps it paused across edits. Same rationale
 * as retentionToStore: adding a schedule should leave the config in a sane, working
 * state. Applies identically to container and stack backups (both go through PUT).
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
	try { sanitizeResticFlags(flags as string); return null; }
	catch (e) { return e instanceof Error ? e.message : 'Invalid restic flags'; }
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

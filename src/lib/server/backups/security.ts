/**
 * backups/security.ts - the security surface for backup/restore.
 *
 * Hardened, well-tested primitives that keep restic invocation, credential
 * handling, and restore targets safe (env/flag/cloud allowlists, SSRF guards,
 * at-rest encryption, path containment). RE-EXPORTED from their existing homes,
 * not re-derived: one import site for the whole domain, so a reviewer sees the
 * security surface in one place.
 *
 * Nothing here has app-specific logic — it is a barrel plus two small pure guards
 * the rewrite needs (restore-target containment + a snapshot-path allowlist).
 */

// --- restic subprocess safety: allowlists, never the full env/flags ---
export {
	/** Build the restic subprocess env from an allowlisted base + this
	 * destination's repo/password/cloud-creds. NEVER the full process.env, so the
	 * master ENCRYPTION_KEY / DATABASE_URL can't leak into restic, and
	 * a malicious destination envVars map can't inject PATH/LD_PRELOAD. */
	buildResticEnv,
	/** Filter a destination's decrypted envVars down to the cloud-credential
	 * allowlist before they reach a helper container. */
	filterCloudEnvVars,
	/** Split + validate a destination's extra restic flags against an allowlist;
	 * throws on anything that could read/write arbitrary files or run code
	 * (`--option`, `--password-command`, `--cacert`, …). Backup/global vs restore
	 * (restore adds --exclude-xattr). */
	sanitizeResticFlags,
	sanitizeRestoreFlags,
	/** True iff `id` is a syntactically valid restic snapshot id (hex, 8 or 64).
	 * The first gate before an id is interpolated into any restic argv. */
	isValidSnapshotId,
	/** Map a raw restic/docker error to a stable BackupErrorCode string. */
	classifyBackupError,
	/** Strip restic's embedded-JSON wrapper + ANSI from an error message. */
	cleanErrorMsg,
} from './helpers';

// --- webhook / destination SSRF ---
export {
	/** Reject non-http(s) schemes and hosts that are loopback/private/link-local/
	 * metadata IPs — the literal-host SSRF guard. Pair with
	 * `redirect: 'manual'` on the fetch to also block redirect-based SSRF. */
	isSafeWebhookUrl,
	/** Range logic shared by the literal-host check and the fire-time resolved-IP
	 * re-check, so both judge private/loopback/metadata ranges identically. */
	privateIpReason,
} from './helpers';

// --- credential encryption at rest ---
export {
	/** Encrypt a plaintext credential to `enc:v1:<base64(iv|tag|ct)>` (AES-256-GCM). */
	encrypt,
	/** Decrypt a stored credential, FAILING CLOSED: throws if a genuine ciphertext
	 * blob can't be decrypted (wrong/rotated key) rather than returning the raw
	 * `enc:v1:…` string as the live secret. Use for anything that
	 * becomes a live credential (RESTIC_PASSWORD, cloud creds). */
	decryptStrict,
	/** True iff a value is one of our ciphertext blobs (has the prefix AND decodes
	 * to a valid length) — so a user secret that merely starts with the prefix
	 * isn't mistaken for ciphertext. */
	isEncrypted,
} from '../encryption';

// NOTE: `decryptBackupDestination` (decrypt a whole destination ROW for use) is a
// DB/persistence operation, not a pure security primitive — services import it
// directly from `../db`. Keeping it out of this barrel lets security.ts stay pure
// (no better-sqlite3 pulled in) so its allowlists/guards are unit-testable.

import { resolve as resolvePath, sep as pathSep } from 'path';
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for secrets (e.g. verifying a supplied repo
 * password against the stored one). A plain `===` short-circuits on the first
 * differing byte, so its timing leaks how much of a guess is correct. Length is
 * compared first — that isn't secret — then the bytes via timingSafeEqual on
 * equal-length buffers.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * Snapshot-path allowlist: a restore `--include` / swap target is always
 * `/volumes/<safe-name>`. Interpolating a container mount destination or dir
 * name into the helper's root shell is a command-injection vector if it can
 * carry shell metacharacters, so we reject anything
 * that isn't a plain `/volumes/<[A-Za-z0-9._-]+>` before it reaches the script.
 */
const SAFE_VOLUME_INCLUDE = /^\/volumes\/[A-Za-z0-9._-]+$/;

export function isSafeVolumeInclude(inc: string): boolean {
	// A config-only (metadata-only) snapshot has no volumes; its new-location
	// restore extracts the whole stored /metadata dir. This is a fixed literal
	// (never attacker-influenced), so allow it explicitly. The stack dir now rides
	// /volumes/__dockhand_stackdir__ (a SAFE_VOLUME_INCLUDE), so no /metadata/stacks path.
	return inc === '/metadata' || SAFE_VOLUME_INCLUDE.test(inc);
}

/** Throwing variant — use at the boundary before building a restore script. */
export function assertSafeVolumeInclude(inc: string): void {
	if (!isSafeVolumeInclude(inc)) {
		throw new Error(`Unsafe restore include path: ${inc}`);
	}
}

/**
 * Restore-target containment.
 * A stack-file restore / new-location restore writes to (and may rm within) a
 * host path derived from attacker-influenceable metadata. Reject a target that
 * escapes its allowed root: resolve both, require the resolved target to sit
 * under the resolved root. The name-level check (no `/ \ ..`) is NOT enough on
 * its own — `stacks-evil` is a sibling of `stacks`, not a child — so we check
 * the resolved-path prefix WITH a separator boundary.
 */
export function isPathWithin(root: string, target: string): boolean {
	const r = resolvePath(root);
	const t = resolvePath(target);
	if (t === r) return true;
	return t.startsWith(r.endsWith(pathSep) ? r : r + pathSep);
}

/** Throwing variant. `label` names the thing being restored for the error. */
export function assertTargetWithin(root: string, target: string, label = 'restore target'): void {
	if (!isPathWithin(root, target)) {
		throw new Error(`Refusing: ${label} "${target}" resolves outside the allowed directory "${root}".`);
	}
}

/** System paths a new-location restore must NEVER write into. The restore helper runs as
 * root and bind-mounts targetPath:targetPath:rw, then restic writes `targetPath/volumes/...`,
 * so an unguarded targetPath is arbitrary host-dir write. A plain new-location restore is a
 * legitimate "extract wherever the operator picked" feature, so we don't confine it to one
 * root; we reject absolute-path escapes and well-known sensitive roots instead. */
const FORBIDDEN_RESTORE_ROOTS = [
	'/', '/etc', '/root', '/boot', '/dev', '/proc', '/sys', '/run',
	'/var/run', '/bin', '/sbin', '/lib', '/lib64', '/var/lib/docker',
];

/** Returns a reason string if `targetPath` is unsafe for a new-location restore, else null.
 * Uses resolve() so `/etc/../etc`, `/srv/../etc`, trailing slashes all normalize before the
 * forbidden-root compare — a string-only prefix check would miss those. */
export function unsafeRestoreTargetReason(targetPath: string): string | null {
	const raw = (targetPath ?? '').trim();
	if (!raw) return 'a target path is required';
	if (!raw.startsWith('/')) return 'target path must be absolute';
	if (raw.includes('\0')) return 'target path must not contain NUL';
	const norm = resolvePath(raw); // collapses .. and trailing slashes
	for (const root of FORBIDDEN_RESTORE_ROOTS) {
		if (norm === root || norm.startsWith(root === '/' ? '/' : root + pathSep)) {
			// `/` matches everything by the prefix rule; only flag `/` itself for that root.
			if (root === '/' && norm !== '/') continue;
			return `target path "${norm}" is inside a protected system directory (${root})`;
		}
	}
	return null;
}

/** Throwing variant for the service layer (defense-in-depth behind API validation). */
export function assertSafeRestoreTarget(targetPath: string): void {
	const reason = unsafeRestoreTargetReason(targetPath);
	if (reason) throw new Error(`Refusing new-location restore: ${reason}`);
}

/**
 * Reject a user-supplied name (stack/target) that could traverse the filesystem
 * when joined into a path. Empty or containing a path separator / `..` → invalid.
 * Combine with assertTargetWithin (both checks are needed — the name check alone
 * misses sibling-prefix escapes, the containment check alone misses a name that
 * is used as a path component before resolution).
 */
export function isSafePathSegment(name: string): boolean {
	if (!name) return false;
	if (name.includes('/') || name.includes('\\')) return false;
	if (name === '.' || name === '..' || name.includes('..')) return false;
	return true;
}

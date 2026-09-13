/**
 * Repository / environment predicates — pure, dependency-free.
 *
 * These live here (NOT in $lib/utils/backup.ts) because that module imports
 * lucide-svelte for its icon helpers, which pulls the icon library into the
 * server bundle. Server routes need only these predicates, so three of them had
 * hand-inlined copies (bug #37 / audit 03-medium-low). One lucide-free module,
 * re-exported by $lib/utils/backup.ts, removes the copies and the drift risk.
 */

/** A restic repository that is a local filesystem path (not a cloud/REST URL). */
export function isLocalRepo(repository: string): boolean {
	return repository.startsWith('/') || repository.startsWith('./');
}

/**
 * Whether a backup destination's TLS-certificate fields (CA / client cert) are
 * meaningful for a given backend type. Only backends that can be self-hosted over
 * HTTPS with a private/self-signed CA qualify: `s3` (MinIO/Ceph) and `rest`. A
 * local path has no network, and `b2`/`azure`/`gs` are managed clouds served from
 * public CAs, so the TLS fields are noise there. When editing a destination that
 * already has a cert stored, return true regardless so its data is never hidden.
 */
export function backendSupportsTls(
	backendType: string,
	opts?: { isEditing?: boolean; hasStoredCert?: boolean }
): boolean {
	if (backendType === 's3' || backendType === 'rest') return true;
	return !!(opts?.isEditing && opts?.hasStoredCert);
}

/** An environment reachable over the network (hawser or direct-with-host). */
export function isRemoteEnvironment(env?: { connectionType?: string | null; host?: string | null } | null): boolean {
	if (!env) return false;
	if (env.connectionType === 'hawser-standard' || env.connectionType === 'hawser-edge') return true;
	if (env.connectionType === 'direct' && !!env.host) return true;
	return false;
}

/**
 * Advisory (NOT a block): a local-path repo on a remote/direct env only works
 * when that env's Docker daemon shares Dockhand's host (e.g. a co-located
 * socket-proxy). The backup/restore helper runs on the target daemon and fails
 * loud if the repo isn't visible there (see restic-script.ts localRepoGuard), so
 * this is only a UI hint — the operation itself is allowed and self-checks.
 */
export function localRepoNeedsSameHost(
	dest: { repository: string },
	env?: { connectionType?: string | null; host?: string | null } | null
): boolean {
	return isLocalRepo(dest.repository) && isRemoteEnvironment(env);
}

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

/** An environment reachable over the network (hawser or direct-with-host). */
export function isRemoteEnvironment(env?: { connectionType?: string | null; host?: string | null }): boolean {
	if (!env) return false;
	if (env.connectionType === 'hawser-standard' || env.connectionType === 'hawser-edge') return true;
	if (env.connectionType === 'direct' && !!env.host) return true;
	return false;
}

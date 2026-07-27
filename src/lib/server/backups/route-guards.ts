/**
 * Shared authorization guard for snapshot-content API routes.
 *
 * The `backups:view` RBAC check alone is GLOBAL — on enterprise it does not
 * distinguish which environment a snapshot belongs to, so a non-admin with
 * backups:view in env A could otherwise read env-B snapshot content by supplying
 * env-B's destination + snapshot id. This resolves the owning environment from
 * the snapshot's own tag (server-side, not a caller-supplied `env` param) and
 * enforces per-env access. Fails CLOSED when the env can't be resolved.
 */
import { resolveSnapshotEnvId, filterSnapshotsByAccessibleEnv } from './index';
import { getBackupConfig } from '../db';
import type { AuthorizationContext } from '../authorize';
import type { BackupConfig } from '../db';

// Local JSON response helper — identical output to SvelteKit's `json()` but with
// no `@sveltejs/kit` import, so this module (and its unit test) load in a plain
// `bun test` context without the Vite/SvelteKit resolution layer.
function json(data: unknown, init?: { status?: number }): Response {
	return new Response(JSON.stringify(data), {
		status: init?.status ?? 200,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * Shared RBAC check for backup routes: returns a 403 Response if the caller
 * lacks `backups:<action>`, else null. Collapses the ~24 hand-copied
 * `if (auth.authEnabled && !await auth.can('backups', ...)) return 403` blocks
 * into one place.
 */
export async function requireBackups(
	auth: AuthorizationContext,
	action: 'view' | 'manage'
): Promise<Response | null> {
	if (auth.authEnabled && !(await auth.can('backups', action))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return null;
}

/**
 * Load a backup config by id AND enforce per-environment access in ONE call, so
 * a config-scoped route cannot forget the env gate. Returns either the config or
 * a Response to return verbatim (404 not-found / 400 bad-id / 403 env-denied).
 *
 * This closes the gap where the configs/[id]/stop route had the `backups:manage`
 * check but NOT the `canAccessEnvironment` gate its sibling run route has, so a
 * user with global backups:manage and no role on the config's env could cancel
 * an in-flight backup there. Routing every config-scoped handler through this
 * guard makes the omission unrepresentable.
 */
export async function loadConfigGateEnv(
	idParam: string,
	auth: AuthorizationContext
): Promise<{ config: BackupConfig } | { response: Response }> {
	const id = parseInt(idParam);
	if (isNaN(id)) return { response: json({ error: 'Invalid ID' }, { status: 400 }) };

	const config = await getBackupConfig(id);
	if (!config) return { response: json({ error: 'Config not found' }, { status: 404 }) };

	if (config.environmentId && auth.isEnterprise && !(await auth.canAccessEnvironment(config.environmentId))) {
		return { response: json({ error: 'Access denied to this environment' }, { status: 403 }) };
	}
	return { config };
}

/**
 * Returns a 403 Response if the caller may not access the snapshot's environment,
 * otherwise null (access allowed). Free edition / admins have full env access so
 * this is a no-op for them; only enterprise non-admins are gated.
 */
export async function guardSnapshotEnvAccess(
	auth: AuthorizationContext,
	destinationId: number,
	snapshotId: string
): Promise<Response | null> {
	// Only enterprise applies per-environment scoping; elsewhere backups:view already
	// grants full access and there are no per-env boundaries to enforce.
	if (!auth.isEnterprise) return null;

	let resolution: { envId: number | null | undefined; resolved: boolean };
	try {
		resolution = await resolveSnapshotEnvId(destinationId, snapshotId);
	} catch {
		// Any failure resolving the snapshot's env → deny (fail closed).
		return json({ error: 'Could not verify snapshot environment access' }, { status: 403 });
	}

	if (!resolution.resolved) {
		// Unknown / unresolvable environment → deny.
		return json({ error: 'Snapshot environment could not be resolved' }, { status: 403 });
	}
	// envId === null means an unscoped ('local') snapshot — no env gate to apply.
	if (resolution.envId == null) return null;

	if (!(await auth.canAccessEnvironment(resolution.envId))) {
		return json({ error: 'Environment access denied' }, { status: 403 });
	}
	return null;
}

/**
 * Drop snapshots whose owning environment the caller can't access, used by the
 * destination-wide list branch which has no target/config filter. Resolves each
 * snapshot's env from its own stable-id `dockhand:envid` tag (no restic round-trip
 * per snapshot). Unscoped ('local') snapshots are kept; snapshots whose env can't
 * be resolved are dropped (fail closed).
 */
export async function filterSnapshotsByEnvAccess<T extends { tags?: string[] }>(
	auth: AuthorizationContext,
	snapshots: T[]
): Promise<T[]> {
	if (!auth.isEnterprise || snapshots.length === 0) return snapshots;
	const tagged = snapshots.map((s) => ({ ...s, tags: s.tags ?? [] }));
	return filterSnapshotsByAccessibleEnv(tagged, (envId) => auth.canAccessEnvironment(envId));
}

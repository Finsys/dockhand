/**
 * backups/snapshots.ts - the READ side: list snapshots and read their contents,
 * with the ownership guards that keep one installation (or one environment) from
 * reading another's backups on a shared repository.
 *
 * TWO ownership checks, both enforced HERE so no read path can forget them:
 *   - INSTANCE ownership: every content read (browse/dump/diff/metadata) first
 *     asks restic for the snapshot filtered by THIS install's instance tag. If
 *     restic returns nothing, the snapshot isn't ours - we refuse. Without this,
 *     anyone who knows a snapshot id could read another install's volume data
 *     from a shared repo.
 *   - ENVIRONMENT ownership (enterprise): the snapshot's owning environment is
 *     read from its own `dockhand:envid` tag (server-side, never a caller-
 *     supplied value) and checked against the caller's access. Fails closed if
 *     the env can't be resolved.
 *
 * The Restic wrapper is injected so the guard logic is testable without a repo.
 */
import { BackupError, parseSnapshots, instanceTagFilter, readEnvIdFromTags, type ResticRun } from './models';
import { isValidSnapshotId } from './security';

/** The minimal restic surface snapshots.ts needs (injected). */
export interface ResticReader {
	runLocal(destination: any, args: string[], tier?: 'interactive' | 'data'): Promise<ResticRun>;
}

/** Caller access context for the environment guard. `isEnterprise=false` means
 * no per-env boundaries apply (the check is a no-op). */
export interface AccessContext {
	isEnterprise: boolean;
	canAccessEnvironment: (envId: number) => Promise<boolean>;
}

/**
 * Assert THIS installation owns the snapshot: run `restic snapshots <id>`
 * filtered by the instance tag; if the result is empty the snapshot is not ours
 * (or doesn't exist) and we refuse. Returns the snapshot's tags (needed by the
 * env guard) so the caller doesn't re-query.
 */
export async function assertInstanceOwned(
	restic: ResticReader,
	destination: any,
	instanceId: string,
	snapshotId: string,
	enterprise = false,
): Promise<string[]> {
	if (!isValidSnapshotId(snapshotId)) {
		throw new BackupError('VALIDATION', 'invalid snapshot id');
	}
	// ENTERPRISE keeps the strict per-instance check: env-scoped RBAC installs enforce env
	// boundaries and don't copy repositories between instances, so a snapshot must be THIS
	// instance's. NON-ENTERPRISE looks up WITHOUT the instance filter, so a snapshot written
	// by another Dockhand instance (a physically-copied or shared repo) is a restorable orphan
	// (#1351, promised by the manual). Either way we confirm the id exists and is a Dockhand
	// snapshot (has a dockhand:instance= tag), so a foreign app's snapshot can't be targeted.
	const filterArgs = enterprise ? ['--tag', instanceTagFilter(instanceId)] : [];
	const run = await restic.runLocal(destination, [
		'snapshots', '--json', '--no-lock', ...filterArgs, snapshotId,
	]);
	if (run.exitCode !== 0) {
		throw new BackupError('RESTIC', `could not verify snapshot ownership: ${run.stderr.trim() || 'restic failed'}`);
	}
	const snaps = parseSnapshots(run.stdout);
	const match = snaps.find((s) => s.id === snapshotId || s.shortId === snapshotId);
	if (!match || !(match.tags || []).some((t) => t.startsWith('dockhand:instance='))) {
		// Not a Dockhand snapshot in this repo (or, for enterprise, not this instance's) -> refuse.
		throw new BackupError('VALIDATION', 'snapshot not found for this installation', { snapshotId });
	}
	return match.tags;
}

/**
 * Assert the caller may access the snapshot's owning ENVIRONMENT (enterprise
 * only). Resolves the env from the snapshot's own `dockhand:envid` tag - never a
 * caller-supplied env - and fails closed if it can't be resolved. `tags` is the
 * snapshot's tag list (from assertInstanceOwned, so we don't re-query).
 */
export async function assertEnvAccess(access: AccessContext, tags: string[]): Promise<void> {
	if (!access.isEnterprise) return; // no per-env boundaries outside enterprise
	const envId = readEnvIdFromTags(tags);
	if (envId === null) {
		throw new BackupError('VALIDATION', 'could not resolve the snapshot environment (denied)');
	}
	if (envId === 'local') return; // an unscoped snapshot has no env gate
	if (!(await access.canAccessEnvironment(envId))) {
		throw new BackupError('VALIDATION', 'access denied to this snapshot environment');
	}
}

/**
 * The one guard every content-read path calls first: instance ownership AND env
 * access, in order. Returns nothing; throws a BackupError if either fails.
 */
export async function guardSnapshotAccess(
	restic: ResticReader,
	destination: any,
	instanceId: string,
	snapshotId: string,
	access: AccessContext,
): Promise<void> {
	const tags = await assertInstanceOwned(restic, destination, instanceId, snapshotId, access.isEnterprise);
	await assertEnvAccess(access, tags);
}

/**
 * Resolve a snapshot's owning ENVIRONMENT from its own stable-id tag
 * (`dockhand:envid=<n>`), read server-side - never from a caller-supplied value.
 * Used by the route-level env gate. The lookup is instance-scoped (restic filters
 * by this install's instance tag), so a snapshot that isn't ours resolves to
 * "unresolved" and the caller fails closed.
 *
 * Returns:
 *   - { envId }        the numeric owning environment id
 *   - { envId: null }  a 'local' / unscoped snapshot (nothing to gate on)
 *   - { envId: undefined, resolved: false } when the env can't be resolved -
 *     callers MUST deny on this to fail closed.
 */
export async function resolveSnapshotEnvId(
	restic: ResticReader,
	destination: any,
	instanceId: string,
	snapshotId: string,
): Promise<{ envId: number | null | undefined; resolved: boolean }> {
	if (!isValidSnapshotId(snapshotId)) return { envId: undefined, resolved: false };
	const run = await restic.runLocal(destination, [
		'snapshots', '--json', '--no-lock', '--tag', instanceTagFilter(instanceId), snapshotId,
	]);
	if (run.exitCode !== 0) return { envId: undefined, resolved: false };
	const snaps = parseSnapshots(run.stdout);
	const match = snaps.find((s) => s.id === snapshotId || s.shortId === snapshotId);
	if (!match) return { envId: undefined, resolved: false };
	const envId = readEnvIdFromTags(match.tags);
	if (envId === null) return { envId: undefined, resolved: false }; // tag absent/malformed -> fail closed
	if (envId === 'local') return { envId: null, resolved: true };    // unscoped snapshot
	return { envId, resolved: true };
}

/**
 * Drop snapshots whose owning environment the caller can't access, resolving each
 * snapshot's env from its own stable-id `dockhand:envid` tag (no restic round-trip
 * per snapshot). A snapshot tagged 'local' (or with no resolvable env) that came
 * from an instance-scoped list is unscoped and kept; a snapshot whose env can't be
 * resolved AND isn't 'local' is dropped (fail closed). `canAccess` is memoised per
 * env id so a large list makes at most one check per environment.
 */
export async function filterSnapshotsByAccessibleEnv<T extends { tags: string[] }>(
	snapshots: T[],
	canAccess: (envId: number) => boolean | Promise<boolean>,
): Promise<T[]> {
	const decided = new Map<number, boolean>();
	const kept: T[] = [];
	for (const snap of snapshots) {
		const envId = readEnvIdFromTags(snap.tags);
		if (envId === 'local') { kept.push(snap); continue; }
		if (envId === null) continue; // unresolvable env -> fail closed
		if (!decided.has(envId)) decided.set(envId, await canAccess(envId));
		if (decided.get(envId)) kept.push(snap);
	}
	return kept;
}

/**
 * List this installation's snapshots in a repository (optionally scoped to one
 * config). Enterprise callers only see snapshots whose env they can access.
 */
export async function listSnapshots(
	restic: ResticReader,
	destination: any,
	instanceId: string,
	access: AccessContext,
	configId?: number,
): Promise<ReturnType<typeof parseSnapshots>> {
	// Per-config listing (a config row's own snapshots) stays instance-scoped - a config is
	// this install's, and its configid collides across instances (a fresh install reuses
	// 1,2,3...), so scoping by instance+configid is what keeps it correct. The FULL repo
	// listing (no configId - feeds orphan detection) must NOT be instance-scoped, or foreign
	// Dockhand snapshots (a physically-copied or shared repo) never surface as orphans (#1351).
	const args = ['snapshots', '--json', '--no-lock'];
	if (configId != null) args.push('--tag', `${instanceTagFilter(instanceId)},dockhand:configid=${configId}`);
	const run = await restic.runLocal(destination, args);
	if (run.exitCode !== 0) {
		// An empty repo (not initialised) and a real error look different; surface
		// the stderr so the caller can classify. Return [] only on a clean exit.
		throw new BackupError('RESTIC', run.stderr.trim() || 'could not list snapshots');
	}
	// restic --tag can't match "has ANY dockhand:instance= tag" (exact-match only), so filter
	// here: keep only snapshots this repo received FROM DOCKHAND (any instance), never those a
	// different app wrote to a shared repo. Per-config results already carry the tag.
	const snaps = parseSnapshots(run.stdout).filter((s) =>
		configId != null || (s.tags || []).some((t) => t.startsWith('dockhand:instance=')));
	if (!access.isEnterprise) return snaps;
	// Filter to snapshots whose env the caller can access. `local` is unscoped -> visible;
	// a null envId (tag absent/malformed) is UNRESOLVABLE -> fail CLOSED (drop), matching
	// readEnvIdFromTags's contract and the sibling filterSnapshotsByAccessibleEnv. Treating
	// null as visible would leak scoped snapshots whose env tag is missing/garbled.
	const visible = [];
	for (const s of snaps) {
		const envId = readEnvIdFromTags(s.tags);
		if (envId === 'local') { visible.push(s); continue; }
		if (envId === null) continue; // unresolvable env -> fail closed
		if (await access.canAccessEnvironment(envId)) visible.push(s);
	}
	return visible;
}

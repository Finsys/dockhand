import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getBackupConfig, getBackupDestinations } from '$lib/server/db';
import { listSnapshots } from '$lib/server/backups';
import { filterSnapshotsByEnvAccess } from '$lib/server/backups/route-guards';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const configIdParam = url.searchParams.get('configId');
	const destIdParam = url.searchParams.get('destinationId');
	const allDests = url.searchParams.get('allDestinations') === 'true';

	if (configIdParam) {
		const configId = parseInt(configIdParam);
		if (isNaN(configId)) return json({ error: 'Invalid configId' }, { status: 400 });
		const config = await getBackupConfig(configId);
		if (!config) return json({ error: 'Config not found' }, { status: 404 });

		// (audit #41) The config is environment-scoped; enforce env access before
		// listing snapshots (ids/sizes/paths/tags reveal the env-B workload).
		if (config.environmentId && auth.isEnterprise && !await auth.canAccessEnvironment(config.environmentId)) {
			return json({ error: 'Environment access denied' }, { status: 403 });
		}

		// Narrow to THIS config's identity by its stable config-id tag so a sibling
		// config sharing the same destination + targetName isn't mixed in.
		if (allDests) {
			// Search ALL destinations for this config's snapshots
			try {
				const destinations = await getBackupDestinations();
				// Bound each destination's listing so one slow or unreachable repo
				// can't stall the whole response for minutes (restic's own timeout is
				// several minutes). A timed-out destination is treated as a failed
				// one — surfaced as a partial result via X-Incomplete-Destinations.
				const PER_DEST_MS = Number(process.env.SNAPSHOT_LIST_TIMEOUT_MS ?? 30_000);
				const withTimeout = <T>(p: Promise<T>, name: string): Promise<T> =>
					Promise.race([
						p,
						new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${PER_DEST_MS}ms`)), PER_DEST_MS)),
					]);
				const results = await Promise.allSettled(
					destinations.map(dest => withTimeout(listSnapshots(dest.id, config.id), dest.name).then(snaps =>
						snaps.map(s => ({ ...s, _destinationId: dest.id, _destinationName: dest.name }))
					))
				);
				const allSnapshots: any[] = [];
				const seen = new Set<string>();
				// (audit #29) Don't silently drop destinations that errored. Collect
				// the failures and surface them via a response header (keeping the body
				// a plain array for compatibility), plus a server log — so a partial
				// result doesn't look complete.
				const failed: string[] = [];
				results.forEach((result, i) => {
					if (result.status === 'fulfilled') {
						for (const snap of result.value) {
							if (!seen.has(snap.id)) {
								seen.add(snap.id);
								allSnapshots.push(snap);
							}
						}
					} else {
						const dest = destinations[i];
						const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
						failed.push(`${dest.name} (${dest.id}): ${msg}`);
					}
				});
				allSnapshots.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
				if (failed.length > 0) {
					console.warn(`[Backup] Snapshot search incomplete — ${failed.length} destination(s) failed: ${failed.join('; ')}`);
					return json(allSnapshots, { headers: { 'X-Incomplete-Destinations': String(failed.length) } });
				}
				return json(allSnapshots);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				return json({ error: errorMsg }, { status: 500 });
			}
		}

		// Default: only search the config's current destination
		try {
			const snapshots = await listSnapshots(config.destinationId, config.id);
			return json(snapshots);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return json({ error: errorMsg }, { status: 500 });
		}
	} else if (destIdParam) {
		const destinationId = parseInt(destIdParam);
		if (isNaN(destinationId)) return json({ error: 'Invalid destinationId' }, { status: 400 });

		try {
			// No target filter — return all snapshots in this destination.
			const snapshots = await listSnapshots(destinationId);
			// (HIGH #8) On enterprise, a non-admin must not see snapshots belonging to
			// environments they can't access — the ids/paths alone are disclosure. Drop
			// any snapshot whose owning env (from its dockhand:env tag) isn't accessible.
			if (auth.isEnterprise) {
				const filtered = await filterSnapshotsByEnvAccess(auth, snapshots);
				return json(filtered);
			}
			return json(snapshots);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return json({ error: errorMsg }, { status: 500 });
		}
	} else {
		return json({ error: 'configId or destinationId parameter is required' }, { status: 400 });
	}
};

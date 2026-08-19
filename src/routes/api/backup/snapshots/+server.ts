import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { getBackupConfig, getBackupDestinations } from '$lib/server/db';
import { listSnapshots } from '$lib/server/backups';
import { filterSnapshotsByEnvAccess } from '$lib/server/backups/route-guards';
import { jobResult } from '$lib/server/sse';

/**
 * @openapi
 * summary: List restic snapshots for a backup config or a single destination (job-polled)
 * description: Pass configId to list across the config's destinations, or destinationId for one. Job-polled so a reverse proxy can't abort the sync restic snapshots read at ~15s; match each snapshot's instance tag against GET /api/backup/instance to tell own snapshots from foreign orphans.
 * query: configId:integer Backup config id (mutually exclusive with destinationId)
 * query: destinationId:integer Single destination id (mutually exclusive with configId)
 * query: allDestinations:boolean With configId, include every destination of the config
 * resp-400: Invalid or missing configId/destinationId
 * resp-403: Permission denied (needs backups:view) or environment access denied
 * resp-404: Backup config not found
 */
export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

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
			// Search ALL destinations for this config's snapshots.
			// Job-polling: `restic snapshots` across every destination is the slowest read here
			// and a reverse proxy would abort the sync request at ~15s. The result stays a bare
			// snapshot array (unchanged contract - many callers/tests treat it as an array); the
			// old X-Incomplete-Destinations header is now log-only.
			return jobResult(request, async () => {
				const destinations = await getBackupDestinations();
				// Bound each destination's listing so one slow or unreachable repo
				// can't stall the whole response for minutes (restic's own timeout is
				// several minutes). A timed-out destination is treated as a failed one.
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
				// (audit #29) Don't silently drop destinations that errored. Collect the
				// failures and surface a count so a partial result doesn't look complete.
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
				}
				return allSnapshots;
			});
		}

		// Default: only search the config's current destination.
		return jobResult(request, () => listSnapshots(config.destinationId, config.id));
	} else if (destIdParam) {
		const destinationId = parseInt(destIdParam);
		if (isNaN(destinationId)) return json({ error: 'Invalid destinationId' }, { status: 400 });

		// Job-polling: `restic snapshots` would otherwise be aborted at the proxy's ~15s cap.
		// Returns a bare snapshot array (unchanged contract). The per-snapshot dockhand:instance=
		// tag identifies the writing install; the client learns its OWN id from
		// GET /api/backup/instance (the old X-Dockhand-Instance header can't ride job polling).
		return jobResult(request, async () => {
			// No target filter — return all snapshots in this destination (incl. snapshots
			// from OTHER Dockhand instances sharing/copied into the repo).
			const snapshots = await listSnapshots(destinationId);
			// (HIGH #8) On enterprise, a non-admin must not see snapshots belonging to
			// environments they can't access — the ids/paths alone are disclosure. Drop
			// any snapshot whose owning env (from its dockhand:env tag) isn't accessible.
			if (auth.isEnterprise) {
				return await filterSnapshotsByEnvAccess(auth, snapshots);
			}
			return snapshots;
		});
	} else {
		return json({ error: 'configId or destinationId parameter is required' }, { status: 400 });
	}
};

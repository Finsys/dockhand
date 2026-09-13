import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination, getBackupConfigs } from '$lib/server/db';
import { runRepoTask } from '$lib/server/backups';
import { createJobResponse } from '$lib/server/sse';

/**
 * POST /api/backup/destinations/{id}/task - Run a repository maintenance task
 *
 * @openapi
 * summary: Run a restic repository maintenance task (unlock, check, prune, stats, repair-index or repair-snapshots) against a destination
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard. Streamed via createJobResponse — a task failure never surfaces as an HTTP 500; it comes back as a 200 with a failed job result (JSON-preferring callers) or a job/SSE 'result' event with success:false (streaming callers).
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * body: {task:string!}
 * body-example: {"task":"check"}
 * resp-200: The task result object — { success: true, ... } on success, or { success: false, error } when the task itself fails
 * resp-400: Invalid input — invalid destination id, or an unknown task name (must be one of unlock, check, prune, stats, repair-index, repair-snapshots)
 * resp-403: No access to an environment whose configs use this destination (enterprise)
 * resp-404: Destination not found
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	const destId = parseInt(params.id);
	if (isNaN(destId)) return json({ error: 'Invalid destination ID' }, { status: 400 });

	const body = await request.json();
	const task = body.task as string;

	if (!['unlock', 'check', 'prune', 'stats', 'repair-index', 'repair-snapshots'].includes(task)) {
		return json({ error: `Invalid task: ${task}` }, { status: 400 });
	}

	const dest = await getBackupDestination(destId);
	if (!dest) return json({ error: 'Destination not found' }, { status: 404 });

	// Repo maintenance (prune/check/repair) is destructive and operates on the
	// shared repo. Destinations aren't environment-scoped, so gate on every
	// environment whose configs use this destination: an enterprise user scoped
	// to one env must not run maintenance on a repo shared with another env's data.
	if (auth.isEnterprise) {
		const configs = await getBackupConfigs();
		const envIds = [...new Set(
			configs.filter((c: any) => c.destinationId === destId && c.environmentId).map((c: any) => c.environmentId as number)
		)];
		for (const envId of envIds) {
			if (!await auth.canAccessEnvironment(envId)) {
				return json({ error: 'Access denied to an environment using this destination' }, { status: 403 });
			}
		}
	}

	// 'prune' and 'check' map to canonical audit actions; the rest land on
	// 'update' so they're still recoverable from the log.
	const action = task === 'prune' ? 'prune' : task === 'check' ? 'verify' : 'update';

	// Stream restic output live into the shared job/log modal (same channel as
	// backup/restore). Guards above (auth, env-scope, allowlist) already ran; only
	// the restic run is wrapped. `createJobResponse` keeps the backward-compat
	// synchronous JSON path for `Accept: application/json` callers (tests/CLI).
	return createJobResponse(async (send) => {
		let result: Awaited<ReturnType<typeof runRepoTask>>;
		try {
			// `task` is validated against the allowed list above.
			result = await runRepoTask(destId, task as import('$lib/server/backups').RepoTask, {
				onProgress: (message) => send('progress', { message })
			});
		} catch (error) {
			// A genuine throw (unexpected). Audit as failed, then rethrow so the job
			// ends in 'error' state.
			const msg = error instanceof Error ? error.message : String(error);
			await auditBackupDestination(event, 'update', destId, dest.name, { task, success: false, error: msg });
			throw error instanceof Error ? error : new Error(msg);
		}
		// runRepoTask can resolve with { success: false, error } WITHOUT throwing
		// (e.g. repo unreachable / needs init). Derive the audited success/error
		// from the result rather than hardcoding success (audit #53).
		await auditBackupDestination(event, action, destId, dest.name, { task, success: result.success, error: result.error });
		send('result', result);
		if (!result.success) throw new Error(result.error || `${task} failed`);
	}, request);
};

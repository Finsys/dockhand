import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination, getBackupConfigs } from '$lib/server/db';
import { runRepoTask } from '$lib/server/backups';

export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

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

	try {
		// `task` is validated against the allowed list above.
		const result = await runRepoTask(destId, task as import('$lib/server/backups').RepoTask);
		// 'prune' and 'check' map to canonical audit actions; the rest land on
		// 'update' so they're still recoverable from the log.
		const action = task === 'prune' ? 'prune' : task === 'check' ? 'verify' : 'update';
		// runRepoTask can resolve with { success: false, error } WITHOUT throwing
		// (e.g. repo unreachable / needs init). Derive the audited success and
		// error from the result rather than hardcoding success (audit #53).
		await auditBackupDestination(event, action, destId, dest.name, { task, success: result.success, error: result.error });
		return json(result, { status: result.success ? 200 : 500 });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		await auditBackupDestination(event, 'update', destId, dest.name, { task, success: false, error: msg });
		return json({ error: msg }, { status: 500 });
	}
};

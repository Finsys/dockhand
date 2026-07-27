import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackupDestination } from '$lib/server/audit';
import {
	getBackupDestination,
	updateBackupDestination,
	deleteBackupDestination,
	decryptBackupDestination,
	getBackupConfigs,
	getEnvironment
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { validatePolicySchedules, validateRepositoryForSave, validateFlags } from '$lib/server/backups/helpers';
import { destinationHasRunningBackup } from '$lib/server/backups';

// Inlined predicates (kept in sync with the config routes) — see
// configs/+server.ts. A local repo cannot back up a remote environment.
function isLocalRepo(repository: string): boolean {
	return repository.startsWith('/') || repository.startsWith('./');
}
function isRemoteEnv(connectionType?: string | null, host?: string | null): boolean {
	if (!connectionType) return false;
	if (connectionType === 'hawser-standard' || connectionType === 'hawser-edge') return true;
	if (connectionType === 'direct' && !!host) return true;
	return false;
}

/**
 * Single-destination response shape. envVars (decrypted cloud credentials) are
 * ONLY included for callers with backups:manage — the edit form that pre-fills
 * credential fields. A backups:view (Viewer) caller must never receive them
 * (audit #26/#29). The password is always stripped. The LIST endpoint omits
 * envVars entirely — see /api/backup/destinations/+server.ts.
 */
function prepareDestination(dest: any, includeSecrets: boolean): any {
	const result = { ...dest };
	delete result.password;
	if (includeSecrets) {
		result.envVars = decryptBackupDestination(dest).decryptedEnvVars;
	} else {
		delete result.envVars;
	}
	return result;
}

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const destination = await getBackupDestination(id);
	if (!destination) return json({ error: 'Destination not found' }, { status: 404 });

	// Only surface decrypted cloud credentials to users who can edit the
	// destination; Viewers get the row without secrets.
	const canManage = !auth.authEnabled || await auth.can('backups', 'manage');
	return json(prepareDestination(destination, canManage));
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const existing = await getBackupDestination(id);
	if (!existing) return json({ error: 'Destination not found' }, { status: 404 });

	const body = await request.json();

	// Changing the repo target or password while a backup is writing to this
	// destination would break the in-flight run. A policy/name-only edit is safe.
	if ((body.repository !== undefined || body.password !== undefined) && await destinationHasRunningBackup(id)) {
		return json({ error: 'A backup using this destination is currently running. Try again once it finishes.' }, { status: 409 });
	}

	// Validate any cron schedules in the supplied policies (audit #7)
	const policyCronError = validatePolicySchedules(body.policies);
	if (policyCronError) {
		return json({ error: policyCronError }, { status: 400 });
	}

	// (audit #7/#53) The PUT edit path previously never re-validated: validate the
	// repository scheme/SSRF host and restic flags when supplied, before persisting.
	if (body.repository !== undefined) {
		const repoError = validateRepositoryForSave(body.repository);
		if (repoError) return json({ error: repoError }, { status: 400 });
	}
	const flagError = validateFlags(body.flags);
	if (flagError) return json({ error: flagError }, { status: 400 });

	// (audit #8) Changing the repository to a LOCAL path bypasses the config-route
	// guard: refuse if any config on this destination targets a remote environment
	// (the restic helper runs on the remote daemon, which can't see Dockhand's fs).
	const effectiveRepository = body.repository !== undefined ? body.repository : existing.repository;
	if (body.repository !== undefined && isLocalRepo(effectiveRepository)) {
		const configs = await getBackupConfigs();
		const envIds = [...new Set(
			configs.filter((c: any) => c.destinationId === id && c.environmentId).map((c: any) => c.environmentId as number)
		)];
		const envs = await Promise.all(envIds.map((eid) => getEnvironment(eid)));
		const remote = envs.find((env) => env && isRemoteEnv(env.connectionType, env.host));
		if (remote) {
			return json({
				error: `Local repository cannot back up containers on remote environment "${remote.name}". Use S3, REST, or another non-local backend.`
			}, { status: 400 });
		}
	}

	try {
		const updated = await updateBackupDestination(id, {
			name: body.name,
			repository: body.repository,
			password: body.password,
			envVars: body.envVars !== undefined ? JSON.stringify(body.envVars) : undefined,
			flags: body.flags,
			hostPath: body.hostPath,
			policies: body.policies
		});
		if (!updated) return json({ error: 'Update failed' }, { status: 500 });

		// Re-register maintenance schedules only when the policies actually changed
		// (audit #22) — a metadata-only edit (rename, flags, etc.) shouldn't churn
		// the repo_prune/check/verify cron jobs.
		if (body.policies !== undefined) {
			try {
				await registerSchedule(id, 'repo_prune', null);
				await registerSchedule(id, 'repo_check', null);
				await registerSchedule(id, 'repo_verify', null);
			} catch {}
		}

		// Audit: don't log the new password — only the fact that it changed
		await auditBackupDestination(event, 'update', id, updated.name, {
			repositoryChanged: body.repository !== undefined && body.repository !== existing.repository,
			passwordChanged: body.password !== undefined,
			policiesChanged: body.policies !== undefined
		});

		// PUT caller already holds backups:manage — safe to echo secrets back.
		return json(prepareDestination(updated, true));
	} catch (error: any) {
		if (error.message?.includes('UNIQUE constraint')) {
			return json({ error: 'A destination with this name already exists' }, { status: 409 });
		}
		return json({ error: error.message }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const existing = await getBackupDestination(id);
	if (!existing) return json({ error: 'Destination not found' }, { status: 404 });

	// Don't delete a destination out from under a backup that's writing to its repo.
	if (await destinationHasRunningBackup(id)) {
		return json({ error: 'A backup using this destination is currently running. Try again once it finishes.' }, { status: 409 });
	}

	// Unregister all maintenance schedules for this destination
	unregisterSchedule(id, 'repo_prune');
	unregisterSchedule(id, 'repo_check');
	unregisterSchedule(id, 'repo_verify');

	// Tear down in-memory croner jobs for any backup configs that reference this
	// destination (audit #47). The config rows may cascade-delete, but the croner
	// jobs would otherwise stay registered as orphans. Mirrors env-delete teardown.
	try {
		const allConfigs = await getBackupConfigs();
		for (const config of allConfigs) {
			if (config.destinationId === id) {
				unregisterSchedule(config.id, 'backup');
			}
		}
	} catch (err) {
		console.error(`Failed to unregister backup schedules for destination "${existing.name}":`, err);
	}

	await deleteBackupDestination(id);
	await auditBackupDestination(event, 'delete', id, existing.name, { repository: existing.repository });
	return json({ success: true });
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackupDestination } from '$lib/server/audit';
import {
	getBackupDestination,
	updateBackupDestination,
	deleteBackupDestination,
	decryptBackupDestination,
	getBackupConfigs
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { validatePolicySchedules, validateRepositoryForSave, validateAndSerializeFlags, parseBackupFlags } from '$lib/server/backups/helpers';
import { destinationHasRunningBackup } from '$lib/server/backups';

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
	// TLS certs (PEM) are never sent to the client - not even the ciphertext, and not even
	// to a manage caller (like the password). The edit form only needs to know one IS set so
	// it can show "leave blank to keep", so expose booleans and strip the values.
	result.hasCacert = !!dest.cacert;
	result.hasTlsClientCert = !!dest.tlsClientCert;
	delete result.cacert;
	delete result.tlsClientCert;
	// Split the stored `flags` JSON into separate fields the edit form binds to (legacy
	// bare strings surface as backupFlags), so the UI never parses the string-vs-JSON column.
	const { backup, restore } = parseBackupFlags(dest.flags);
	result.backupFlags = backup;
	result.restoreFlags = restore;
	return result;
}

/**
 * GET /api/backup/destinations/{id} - Get a single backup destination
 *
 * @openapi
 * summary: Fetch a single backup destination; decrypted cloud-credential env vars are only included for callers who can manage backups, and the password is always stripped
 * description: Permission denial (403, "backups:view") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * resp-200: The backup destination object (envVars included only for "backups:manage" callers; password always stripped)
 * resp-400: Invalid id (not a number)
 * resp-404: Destination not found
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const id = parseInt(params.id);
	if (isNaN(id)) return json({ error: 'Invalid ID' }, { status: 400 });

	const destination = await getBackupDestination(id);
	if (!destination) return json({ error: 'Destination not found' }, { status: 404 });

	// Only surface decrypted cloud credentials to users who can edit the
	// destination; Viewers get the row without secrets.
	const canManage = !auth.authEnabled || await auth.can('backups', 'manage');
	return json(prepareDestination(destination, canManage));
};

/**
 * PUT /api/backup/destinations/{id} - Update a backup destination
 *
 * @openapi
 * summary: Update a backup destination, re-validating repository and flags when supplied and re-registering maintenance schedules when policies change
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * body: {name:string, repository:string, password:string, envVars:{}, flags:string, backupFlags:string, restoreFlags:string, hostPath:string, cacert:string, tlsClientCert:string, policies:string}
 * body-example: {"name":"S3 Offsite (renamed)","policies":"{\"pruneEnabled\":true,\"pruneSchedule\":\"0 0 1 * *\"}"}
 * resp-200: The updated backup destination object (password stripped, envVars echoed back to the managing caller)
 * resp-400: Invalid input — invalid id, unsupported/SSRF-blocked repository, invalid restic flags, invalid policy cron, or switching to a local repository used by a remote-environment config
 * resp-404: Destination not found
 * resp-409: A backup using this destination is currently running, or a destination with the new name already exists
 * resp-500: Update failed (persistence error)
 */
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

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
	// Flags: prefer the split shape; fall back to a legacy `flags` string. undefined for ALL
	// three means "don't touch flags". Validate+serialize to the JSON stored in `flags`.
	let flagsColumn: string | null | undefined = undefined;
	if (body.backupFlags !== undefined || body.restoreFlags !== undefined) {
		try { flagsColumn = validateAndSerializeFlags(body.backupFlags, body.restoreFlags); }
		catch (e) { return json({ error: e instanceof Error ? e.message : 'Invalid restic flags' }, { status: 400 }); }
	} else if (body.flags !== undefined) {
		try { flagsColumn = validateAndSerializeFlags(body.flags, ''); }
		catch (e) { return json({ error: e instanceof Error ? e.message : 'Invalid restic flags' }, { status: 400 }); }
	}

	// A local-path repo is allowed on any env; a wrong-host mount fails loud via
	// the helper's localRepoGuard at backup/restore time.

	try {
		const updated = await updateBackupDestination(id, {
			name: body.name,
			repository: body.repository,
			password: body.password,
			envVars: body.envVars !== undefined ? JSON.stringify(body.envVars) : undefined,
			flags: flagsColumn,
			hostPath: body.hostPath,
			cacert: body.cacert,
			tlsClientCert: body.tlsClientCert,
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

/**
 * DELETE /api/backup/destinations/{id} - Delete a backup destination
 *
 * @openapi
 * summary: Delete a backup destination and unregister all its maintenance and dependent backup-config schedules
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * resp-200: Returns { success: true } once the destination is deleted
 * resp-200-example: {"success":true}
 * resp-400: Invalid id (not a number)
 * resp-404: Destination not found
 * resp-409: A backup using this destination is currently running — try again once it finishes
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

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

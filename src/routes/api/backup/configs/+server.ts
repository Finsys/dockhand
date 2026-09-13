import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackup } from '$lib/server/audit';
import {
	getBackupConfigs,
	createBackupConfig
} from '$lib/server/db';
import { registerSchedule, isValidCron } from '$lib/server/scheduler';
import { assertStackBackupable } from '$lib/server/backups';
import { validateRetention, retentionToStore } from '$lib/server/backups/helpers';

/**
 * GET /api/backup/configs - List backup configurations
 *
 * @openapi
 * summary: List backup configurations, optionally filtered by type, target and environment (enterprise callers only see configs for environments they can access)
 * description: Permission denial (403, "backups:view") is produced by the shared requireBackups route guard.
 * query: type:string Filter by backup config type (e.g. "container", "stack")
 * query: target:string Filter by the backed-up target name (container or stack name)
 * query: env:integer Filter by environment id (from GET /api/environments)
 * resp-200: Array of backup configuration objects
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const type = url.searchParams.get('type') ?? undefined;
	const targetName = url.searchParams.get('target') ?? undefined;
	const envParam = url.searchParams.get('env');
	const environmentId = envParam ? parseInt(envParam) : undefined;

	let configs = await getBackupConfigs({
		type,
		targetName,
		environmentId
	});

	// (audit #40) Enterprise env scoping — the LIST read path never filtered by
	// accessible environments, leaking configs (targetName, destination, schedule,
	// status) for envs the caller can't access. getAccessibleEnvironmentIds()
	// returns null when the caller can see everything.
	if (auth.isEnterprise) {
		const allowed = await auth.getAccessibleEnvironmentIds();
		if (allowed !== null) {
			const allowedSet = new Set(allowed);
			configs = configs.filter((c: any) => c.environmentId == null || allowedSet.has(c.environmentId));
		}
	}

	return json(configs);
};

/**
 * POST /api/backup/configs - Create a backup configuration
 *
 * @openapi
 * summary: Create a backup configuration for a container or stack, optionally scheduled, and register its cron schedule when enabled
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard. A requested environmentId the caller can't access also 403s (enterprise). destinationId from GET /api/backup/destinations. environmentId from GET /api/environments.
 * body: {destinationId:integer!, targetName:string!, type:string, environmentId:integer, enabled:boolean, allVolumes:boolean, selectedVolumes:array<string>, stopBeforeBackup:boolean, schedule:string, retention:{keepLast:integer, keepDaily:integer, keepWeekly:integer, keepMonthly:integer, keepYearly:integer}, options:{}, tags:array<string>}
 * body-example: {"destinationId":3,"targetName":"nextcloud","type":"container","environmentId":1,"enabled":true,"allVolumes":true,"stopBeforeBackup":false,"schedule":"0 3 * * *","retention":{"keepDaily":7,"keepWeekly":4}}
 * resp-201: The created backup configuration object
 * resp-400: Invalid input — missing destinationId/targetName, invalid targetName, invalid cron expression, invalid retention, or a local repository paired with a remote environment / non-backupable stack
 * resp-403: Access denied to the requested environment (enterprise)
 * resp-500: Failed to create the backup configuration (persistence error)
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	const body = await request.json();

	if (!body.destinationId || !body.targetName) {
		return json({ error: 'Missing required fields: destinationId, targetName' }, { status: 400 });
	}

	// Light allowlist on targetName — it flows into paths/restic tags. Complements
	// the stack-path traversal guard (audit #43).
	if (typeof body.targetName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(body.targetName)) {
		return json({ error: 'Invalid targetName' }, { status: 400 });
	}

	// Validate cron schedule if provided (audit #7)
	if (typeof body.schedule === 'string' && body.schedule.trim() && !isValidCron(body.schedule.trim())) {
		return json({ error: `Invalid cron expression: ${body.schedule}` }, { status: 400 });
	}

	// Validate retention keep-* values before persisting (audit medium #13) — reject
	// negative/fractional/string/out-of-range so corrupt retention can't reach restic.
	const retentionCheck = validateRetention(body.retention);
	if (!retentionCheck.ok) {
		return json({ error: `Invalid retention: ${retentionCheck.reason}` }, { status: 400 });
	}

	// Environment access check (enterprise RBAC)
	if (body.environmentId && auth.isEnterprise && !await auth.canAccessEnvironment(body.environmentId)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// A local-path repo is allowed on any env; if the target daemon can't see the
	// repo (wrong-host mount) the backup fails loud via the helper's localRepoGuard.

	// External stacks (no known compose path) can't be backed up usefully —
	// see assertStackBackupable for the why.
	const stackCheck = await assertStackBackupable(body.type || 'container', body.targetName, body.environmentId);
	if (!stackCheck.ok) {
		return json({ error: stackCheck.reason }, { status: 400 });
	}

	try {
		const config = await createBackupConfig({
			type: body.type || 'container',
			targetName: body.targetName,
			environmentId: body.environmentId ?? null,
			destinationId: body.destinationId,
			enabled: body.enabled !== false,
			allVolumes: body.allVolumes ?? true,
			selectedVolumes: body.selectedVolumes ? JSON.stringify(body.selectedVolumes) : null,
			stopBeforeBackup: body.stopBeforeBackup ?? false,
			schedule: body.schedule ?? null,
			retention: retentionToStore(body.retention, body.schedule),
			options: body.options ? JSON.stringify(body.options) : null,
			tags: body.tags ? JSON.stringify(body.tags) : null
		});

		// Register schedule if enabled and has a cron expression
		if (config.enabled && config.schedule) {
			await registerSchedule(config.id, 'backup', config.environmentId);
		}

		await auditBackup(event, 'create', body.targetName, body.environmentId, { destinationId: body.destinationId, schedule: body.schedule });
		return json(config, { status: 201 });
	} catch (error: any) {
		return json({ error: error.message }, { status: 500 });
	}
};

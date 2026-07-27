import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackup } from '$lib/server/audit';
import {
	getBackupConfigs,
	createBackupConfig,
	getBackupDestination,
	getEnvironment
} from '$lib/server/db';
import { registerSchedule, isValidCron } from '$lib/server/scheduler';
import { assertStackBackupable } from '$lib/server/backups';
import { validateRetention, retentionToStore } from '$lib/server/backups/helpers';

// Inlined to avoid pulling lucide-svelte / svelte runtime into the server bundle
// via $lib/utils/backup. Keep in sync with that module if the predicates change.
function isLocalRepo(repository: string): boolean {
	return repository.startsWith('/') || repository.startsWith('./');
}
function isRemoteEnv(connectionType?: string | null, host?: string | null): boolean {
	if (!connectionType) return false;
	if (connectionType === 'hawser-standard' || connectionType === 'hawser-edge') return true;
	if (connectionType === 'direct' && !!host) return true;
	return false;
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

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

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

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

	// Refuse local repo + remote env: the restic helper runs on the REMOTE
	// daemon, which has no access to Dockhand's filesystem. The backup would
	// silently write to a wrong path on the remote host.
	if (body.environmentId) {
		const [dest, env] = await Promise.all([
			getBackupDestination(body.destinationId),
			getEnvironment(body.environmentId)
		]);
		if (dest && env && isRemoteEnv(env.connectionType, env.host) && isLocalRepo(dest.repository)) {
			return json({
				error: `Local repository "${dest.name}" cannot back up containers on remote environment "${env.name}". Use S3, REST, or another non-local backend.`
			}, { status: 400 });
		}
	}

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

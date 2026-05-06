import { json } from '@sveltejs/kit';
import {
	inspectContainer,
	removeContainer,
	getContainerLogs
} from '$lib/server/docker';
import { deleteAutoUpdateSchedule, getAutoUpdateSetting, getSecretKeysToMask, removePendingContainerUpdate } from '$lib/server/db';
import { getStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { unregisterSchedule } from '$lib/server/scheduler';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		const details = await inspectContainer(params.id, envIdNum);

		// Mask secret env vars for containers belonging to a Compose stack.
		// Uses compose file parsing to detect interpolation (e.g., MYSQL_PASSWORD=${db_secret}).
		const stackName = details.Config?.Labels?.['com.docker.compose.project'];
		if (stackName && Array.isArray(details.Config?.Env)) {
			const composeResult = await getStackComposeFile(stackName, envIdNum).catch(() => null);
			const secretKeys = await getSecretKeysToMask(stackName, envIdNum, composeResult?.content);
			if (secretKeys.size > 0) {
				details.Config.Env = details.Config.Env.map((entry: string) => {
					const eqIdx = entry.indexOf('=');
					if (eqIdx === -1) return entry;
					const key = entry.substring(0, eqIdx);
					if (secretKeys.has(key)) {
						return `${key}=***`;
					}
					return entry;
				});
			}
		}

		return json(details);
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error inspecting container:', error?.message || error);
		return json({ error: 'Failed to inspect container' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const force = url.searchParams.get('force') === 'true';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'remove', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		// Get container name before deletion for audit
		let containerName = params.id;
		try {
			const details = await inspectContainer(params.id, envIdNum);
			containerName = details.Name?.replace(/^\//, '') || params.id;
		} catch {
			// Container might not exist or other error, use ID
		}

		await removeContainer(params.id, force, envIdNum);

		// Audit log
		await auditContainer(event, 'delete', params.id, containerName, envIdNum, { force });

		// Clean up auto-update schedule if exists
		try {
			// Get the schedule ID before deleting
			const setting = await getAutoUpdateSetting(containerName, envIdNum);
			if (setting) {
				// Unregister from croner
				unregisterSchedule(setting.id, 'container_update');
				// Delete from database
				await deleteAutoUpdateSchedule(containerName, envIdNum);
			}
		} catch (error) {
			console.error('Failed to cleanup auto-update schedule:', error);
			// Don't fail the deletion if schedule cleanup fails
		}

		// Clean up pending container update if exists
		try {
			if (envIdNum) {
				await removePendingContainerUpdate(envIdNum, params.id);
			}
		} catch (error) {
			console.error('Failed to cleanup pending container update:', error);
			// Don't fail the deletion if cleanup fails
		}

		return json({ success: true });
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error removing container:', error?.message || error);
		return json({ error: 'Failed to remove container' }, { status: 500 });
	}
};

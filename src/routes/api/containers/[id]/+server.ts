import { json } from '@sveltejs/kit';
import {
	inspectContainer,
	removeContainer,
	getContainerLogs
} from '$lib/server/docker';
import { deleteAutoUpdateSchedule, getAutoUpdateSetting, removePendingContainerUpdate } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { unregisterSchedule } from '$lib/server/scheduler';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
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
		return json(details);
	} catch (error) {
		console.error('Error inspecting container:', error);
		return json({ error: 'Failed to inspect container' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
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
	} catch (error) {
		console.error('Error removing container:', error);
		return json({ error: 'Failed to remove container' }, { status: 500 });
	}
};

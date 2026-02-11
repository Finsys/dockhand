import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironment, updateEnvironment, deleteEnvironment, getEnvironmentPublicIps, setEnvironmentPublicIp, deleteEnvironmentPublicIp, deleteEnvUpdateCheckSettings, deleteImagePruneSettings, getGitStacksForEnvironmentOnly, deleteGitStack } from '$lib/server/db';
import { clearDockerClientCache } from '$lib/server/docker';
import { deleteGitStackFiles } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { auditEnvironment } from '$lib/server/audit';
import { refreshSubprocessEnvironments } from '$lib/server/subprocess-manager';
import { serializeLabels, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';
import { cleanPem } from '$lib/utils/pem';
import { unregisterSchedule } from '$lib/server/scheduler';
import { closeEdgeConnection } from '$lib/server/hawser';
import { computeAuditDiff } from '$lib/utils/diff';

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		const env = await getEnvironment(id);

		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		// Get public IP for this environment
		const publicIps = await getEnvironmentPublicIps();
		const publicIp = publicIps[id.toString()] || null;

		// Parse labels from JSON string to array
		return json({
			...env,
			labels: parseLabels(env.labels as string | null),
			publicIp
		});
	} catch (error) {
		console.error('Failed to get environment:', error);
		return json({ error: 'Failed to get environment' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Get old values before update for diff
		const oldEnv = await getEnvironment(id);
		if (!oldEnv) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const data = await request.json();

		// Clear cached Docker client before updating
		clearDockerClientCache(id);

		// Handle labels - only update if provided in the request
		const labels = data.labels !== undefined
			? serializeLabels(Array.isArray(data.labels) ? data.labels.slice(0, MAX_LABELS) : [])
			: undefined;

		const env = await updateEnvironment(id, {
			name: data.name,
			host: data.host,
			port: data.port,
			protocol: data.protocol,
			tlsCa: cleanPem(data.tlsCa),
			tlsCert: cleanPem(data.tlsCert),
			tlsKey: cleanPem(data.tlsKey),
			tlsSkipVerify: data.tlsSkipVerify,
			icon: data.icon,
			socketPath: data.socketPath,
			collectActivity: data.collectActivity,
			collectMetrics: data.collectMetrics,
			highlightChanges: data.highlightChanges,
			labels: labels,
			connectionType: data.connectionType,
			hawserToken: data.hawserToken
		});

		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		// Notify subprocesses if collectActivity or collectMetrics setting changed
		if (data.collectActivity !== undefined || data.collectMetrics !== undefined) {
			refreshSubprocessEnvironments();
		}

		// Handle public IP - update if provided in request
		if (data.publicIp !== undefined) {
			await setEnvironmentPublicIp(id, data.publicIp || null);
		}

		// Get current public IP for response
		const publicIps = await getEnvironmentPublicIps();
		const publicIp = publicIps[id.toString()] || null;

		// Compute diff for audit (exclude sensitive TLS fields)
		const diff = computeAuditDiff(oldEnv, env, {
			excludeFields: ['tlsCa', 'tlsCert', 'tlsKey', 'hawserToken', 'labels']
		});

		// Audit log
		await auditEnvironment(event, 'update', env.id, env.name, diff);

		// Parse labels from JSON string to array
		return json({
			...env,
			labels: parseLabels(env.labels as string | null),
			publicIp
		});
	} catch (error) {
		console.error('Failed to update environment:', error);
		return json({ error: 'Failed to update environment' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Get environment name before deletion for audit log
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		// Close Edge connection if this is a Hawser Edge environment
		// This rejects any pending requests and closes the WebSocket
		closeEdgeConnection(id);

		// Clear cached Docker client before deleting
		clearDockerClientCache(id);

		// Clean up git stacks for this environment
		const gitStacks = await getGitStacksForEnvironmentOnly(id);
		for (const stack of gitStacks) {
			// Unregister schedule if auto-update was enabled
			if (stack.autoUpdate) {
				unregisterSchedule(stack.id, 'git_stack_sync');
			}
			// Delete git stack files from filesystem
			await deleteGitStackFiles(stack.id, stack.stackName, stack.environmentId);
			// Delete git stack from database
			await deleteGitStack(stack.id);
		}

		const success = await deleteEnvironment(id);

		if (!success) {
			return json({ error: 'Cannot delete this environment' }, { status: 400 });
		}

		// Clean up public IP entry for this environment
		await deleteEnvironmentPublicIp(id);

		// Clean up update check settings and unregister schedule
		await deleteEnvUpdateCheckSettings(id);
		unregisterSchedule(id, 'env_update_check');

		// Clean up image prune settings and unregister schedule
		await deleteImagePruneSettings(id);
		unregisterSchedule(id, 'image_prune');

		// Notify subprocesses to stop collecting from deleted environment
		refreshSubprocessEnvironments();

		// Audit log
		await auditEnvironment(event, 'delete', id, env.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete environment:', error);
		return json({ error: 'Failed to delete environment' }, { status: 500 });
	}
};

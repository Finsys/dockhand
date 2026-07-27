import { json } from '@sveltejs/kit';
import { join } from 'path';
import { existsSync, rmSync, renameSync } from 'fs';
import type { RequestHandler } from './$types';
import { getEnvironment, updateEnvironment, deleteEnvironment, getEnvironmentPublicIps, setEnvironmentPublicIp, deleteEnvironmentPublicIp, deleteEnvUpdateCheckSettings, deleteImagePruneSettings, getGitStacksForEnvironmentOnly, deleteGitStack, getBackupConfigs } from '$lib/server/db';
import { clearDockerClientCache } from '$lib/server/docker';
import { deleteGitStackFiles, getGitReposDir } from '$lib/server/git';
import { getStacksDir } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditEnvironment } from '$lib/server/audit';
import { refreshSubprocessEnvironments } from '$lib/server/subprocess-manager';
import { serializeLabels, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';
import { cleanPem } from '$lib/utils/pem';
import { validateEnvName } from '$lib/utils/env-name';
import { unregisterSchedule } from '$lib/server/scheduler';
import { closeEdgeConnection } from '$lib/server/hawser';
import { computeAuditDiff } from '$lib/utils/diff';
import { deleteEnvironmentIcon } from '$lib/server/env-icons';

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

		// #1179: validate name if it's being changed. Existing invalid names are
		// not auto-corrected — only writes go through this check.
		const isRename = data.name !== undefined && data.name !== oldEnv.name;
		if (isRename) {
			const nameCheck = validateEnvName(data.name);
			if (!nameCheck.ok) {
				return json({ error: nameCheck.reason }, { status: 400 });
			}
		}

		// Rename on-disk directories BEFORE the DB write. If the fs rename
		// fails (cross-mount EXDEV, perm error, target exists), we surface a
		// 409 and leave the DB untouched — better than the previous behavior
		// of silently orphaning stacks under the old name.
		//
		// Applies to ALL connection types. For socket/direct envs the staging
		// dir IS the deployed dir, so containers need a redeploy after rename
		// (see client warning). For Hawser envs the agent owns the deployed
		// dir on the remote host and isn't affected, but Dockhand still keeps
		// a local staging copy under stacks/<envName>/<stackName>/ (for the
		// in-app editor) and ALL git stacks clone to git-repos/<envName>/
		// regardless of where they ultimately deploy — so the rename matters
		// locally for every env type.
		if (isRename) {
			const stacksDir = getStacksDir();
			const gitReposDir = getGitReposDir();
			const oldStacks = join(stacksDir, oldEnv.name);
			const newStacks = join(stacksDir, data.name);
			const oldRepos = join(gitReposDir, oldEnv.name);
			const newRepos = join(gitReposDir, data.name);

			// Refuse to overwrite a target dir that already holds someone
			// else's data.
			if (existsSync(oldStacks) && existsSync(newStacks)) {
				return json({
					error: `Cannot rename: ${newStacks} already exists. Pick a different name or move that directory out of the way.`
				}, { status: 409 });
			}
			if (existsSync(oldRepos) && existsSync(newRepos)) {
				return json({
					error: `Cannot rename: ${newRepos} already exists. Pick a different name or move that directory out of the way.`
				}, { status: 409 });
			}

			try {
				if (existsSync(oldStacks)) renameSync(oldStacks, newStacks);
				if (existsSync(oldRepos)) renameSync(oldRepos, newRepos);
			} catch (err: any) {
				// Best-effort rollback if the second rename failed after the first
				// succeeded. Avoids leaving the filesystem in a split state.
				try { if (existsSync(newStacks) && !existsSync(oldStacks)) renameSync(newStacks, oldStacks); } catch {}
				try { if (existsSync(newRepos) && !existsSync(oldRepos)) renameSync(newRepos, oldRepos); } catch {}
				const code = err?.code === 'EXDEV'
					? 'EXDEV: stacks dir is on a different filesystem from the rename target. Move it back to the same filesystem to rename this environment.'
					: (err?.message || 'Rename failed');
				return json({ error: code }, { status: 409 });
			}
		}

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

		// Notify event collectors if collectActivity or collectMetrics setting changed
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
		if (isNaN(id) || id <= 0) {
			return json({ error: 'Invalid environment ID' }, { status: 400 });
		}

		// Get environment name before deletion for audit log
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		// Safety: never delete directories if env name is empty/whitespace
		if (!env.name?.trim()) {
			return json({ error: 'Cannot delete environment with empty name' }, { status: 500 });
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

		// Clean up custom icon file if exists
		deleteEnvironmentIcon(id);

		// Clean up public IP entry for this environment
		await deleteEnvironmentPublicIp(id);

		// Clean up update check settings and unregister schedule
		await deleteEnvUpdateCheckSettings(id);
		unregisterSchedule(id, 'env_update_check');

		// Clean up image prune settings and unregister schedule
		await deleteImagePruneSettings(id);
		unregisterSchedule(id, 'image_prune');

		// Unregister backup config schedules for this environment (audit #10).
		// The config rows themselves cascade-delete with the environment, but the
		// in-memory croner jobs would otherwise stay registered as orphans.
		try {
			const envBackupConfigs = await getBackupConfigs({ environmentId: id });
			for (const config of envBackupConfigs) {
				unregisterSchedule(config.id, 'backup');
			}
		} catch (err) {
			console.error(`Failed to unregister backup schedules for environment "${env.name}":`, err);
		}

		// Clean up stack directory for this environment
		// Safety: only delete subdirectory named after the env, never the parent
		try {
			const stacksDir = getStacksDir();
			const envStackDir = join(stacksDir, env.name);
			if (envStackDir !== stacksDir && envStackDir.startsWith(stacksDir) && existsSync(envStackDir)) {
				rmSync(envStackDir, { recursive: true, force: true });
			}
		} catch (err) {
			console.error(`Failed to clean up stack directory for environment "${env.name}":`, err);
		}

		// Clean up git-repos directory for this environment
		try {
			const gitReposDir = getGitReposDir();
			const envGitDir = join(gitReposDir, env.name);
			if (envGitDir !== gitReposDir && envGitDir.startsWith(gitReposDir) && existsSync(envGitDir)) {
				rmSync(envGitDir, { recursive: true, force: true });
			}
		} catch (err) {
			console.error(`Failed to clean up git-repos directory for environment "${env.name}":`, err);
		}

		// Notify event collectors to stop collecting from deleted environment
		refreshSubprocessEnvironments();

		// Audit log
		await auditEnvironment(event, 'delete', id, env.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete environment:', error);
		return json({ error: 'Failed to delete environment' }, { status: 500 });
	}
};

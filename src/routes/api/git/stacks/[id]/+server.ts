import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack, updateGitStack, deleteGitStack, deleteStackSource, updateStackSourceName, updateStackEnvVarsName, setStackEnvVars, getStackEnvVars } from '$lib/server/db';
import { deleteGitStackFiles, deployGitStack } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { auditGitStack } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

// Stack name validation: must start with alphanumeric, can contain alphanumeric, hyphens, underscores
const STACK_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const gitStack = await getGitStack(id);
		if (!gitStack) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'view', gitStack.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		return json(gitStack);
	} catch (error) {
		console.error('Failed to get git stack:', error);
		return json({ error: 'Failed to get git stack' }, { status: 500 });
	}
};

export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const existing = await getGitStack(id);
		if (!existing) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'edit', existing.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		const data = await request.json();

		// Validate stack name if it's being changed
		if (data.stackName !== undefined) {
			const trimmedStackName = data.stackName.trim();
			if (!trimmedStackName) {
				return json({ error: 'Stack name is required' }, { status: 400 });
			}
			if (!STACK_NAME_REGEX.test(trimmedStackName)) {
				return json({ error: 'Stack name must start with a letter or number, and contain only letters, numbers, hyphens, and underscores' }, { status: 400 });
			}
			data.stackName = trimmedStackName;
		}

		const oldStackName = existing.stackName;
		const updated = await updateGitStack(id, {
			stackName: data.stackName,
			composePath: data.composePath,
			envFilePath: data.envFilePath,
			autoUpdate: data.autoUpdate,
			autoUpdateSchedule: data.autoUpdateSchedule,
			autoUpdateCron: data.autoUpdateCron,
			webhookEnabled: data.webhookEnabled,
			webhookSecret: data.webhookSecret
		});

		// If stack name changed, update related records
		if (data.stackName && data.stackName !== oldStackName) {
			await updateStackSourceName(oldStackName, data.stackName, existing.environmentId);
			await updateStackEnvVarsName(oldStackName, data.stackName, existing.environmentId);
		}

		// Register or unregister schedule with croner
		if (updated.autoUpdate && updated.autoUpdateCron) {
			await registerSchedule(id, 'git_stack_sync', updated.environmentId);
		} else {
			unregisterSchedule(id, 'git_stack_sync');
		}

		// Compute diff for audit (exclude sensitive fields)
		const diff = computeAuditDiff(existing, updated, {
			excludeFields: ['webhookSecret', 'createdAt', 'updatedAt', 'lastSync', 'lastCommit', 'syncStatus', 'syncError']
		});

		// Audit log
		await auditGitStack(event, 'update', updated.id, updated.stackName, updated.environmentId, diff);

		// Save environment variable overrides before deploying
		if (data.envVars && Array.isArray(data.envVars)) {
			const stackName = data.stackName || existing.stackName;
			const envId = updated.environmentId ?? null;

			// Get existing secrets to preserve masked values
			const existingVars = await getStackEnvVars(stackName, envId, false); // false = unmasked
			const existingByKey = new Map(existingVars.map(v => [v.key, v]));

			const varsToSave = data.envVars
				.filter((v: any) => v.key?.trim())
				.map((v: any) => {
					// Preserve existing secret value if submitted value is masked
					if (v.isSecret && v.value === '***') {
						const existingVar = existingByKey.get(v.key.trim());
						if (existingVar && existingVar.isSecret) {
							return {
								key: v.key.trim(),
								value: existingVar.value, // Use real value from DB
								isSecret: true
							};
						}
						// No existing secret found - skip this entry (shouldn't happen normally)
						return null;
					}
					return {
						key: v.key.trim(),
						value: v.value ?? '',
						isSecret: v.isSecret ?? false
					};
				})
				.filter(Boolean); // Remove nulls

			await setStackEnvVars(stackName, envId, varsToSave as any);
		}

		// If deployNow is set, deploy after saving
		if (data.deployNow) {
			const deployResult = await deployGitStack(id);
			await auditGitStack(event, 'deploy', updated.id, updated.stackName, updated.environmentId);
			return json({
				...updated,
				deployResult
			});
		}

		return json(updated);
	} catch (error: any) {
		console.error('Failed to update git stack:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'A git stack with this name already exists for this environment' }, { status: 400 });
		}
		return json({ error: 'Failed to update git stack' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);

	try {
		const id = parseInt(params.id);
		const existing = await getGitStack(id);
		if (!existing) {
			return json({ error: 'Git stack not found' }, { status: 404 });
		}

		// Permission check with environment context
		if (auth.authEnabled && !await auth.can('stacks', 'remove', existing.environmentId || undefined)) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}

		// Unregister schedule from croner
		unregisterSchedule(id, 'git_stack_sync');

		// Delete git files first
		await deleteGitStackFiles(id, existing.stackName, existing.environmentId);

		// Delete the stack_sources record to free up the stack name
		await deleteStackSource(existing.stackName, existing.environmentId);

		// Delete from database
		await deleteGitStack(id);

		// Audit log
		await auditGitStack(event, 'delete', id, existing.stackName, existing.environmentId);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete git stack:', error);
		return json({ error: 'Failed to delete git stack' }, { status: 500 });
	}
};

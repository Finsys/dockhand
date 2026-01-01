import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironments, createEnvironment, assignUserRole, getRoleByName, getEnvironmentPublicIps, setEnvironmentPublicIp, getEnvUpdateCheckSettings, getEnvironmentTimezone, type Environment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { refreshSubprocessEnvironments } from '$lib/server/subprocess-manager';
import { serializeLabels, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		let environments = await getEnvironments();

		// In enterprise mode, filter environments by user's accessible environments
		if (auth.authEnabled && auth.isEnterprise && auth.isAuthenticated && !auth.isAdmin) {
			const accessibleIds = await auth.getAccessibleEnvironmentIds();
			// accessibleIds is null if user has access to all environments
			if (accessibleIds !== null) {
				environments = environments.filter(env => accessibleIds.includes(env.id));
			}
		}

		// Get public IPs for all environments
		const publicIps = await getEnvironmentPublicIps();

		// Get update check settings for all environments
		const updateCheckSettingsMap = new Map<number, { enabled: boolean; autoUpdate: boolean }>();
		for (const env of environments) {
			const settings = await getEnvUpdateCheckSettings(env.id);
			if (settings && settings.enabled) {
				updateCheckSettingsMap.set(env.id, { enabled: true, autoUpdate: settings.autoUpdate });
			}
		}

		// Parse labels from JSON string to array, add public IPs, update check settings, and timezone
		const envWithParsedLabels = await Promise.all(environments.map(async env => {
			const updateSettings = updateCheckSettingsMap.get(env.id);
			const timezone = await getEnvironmentTimezone(env.id);
			return {
				...env,
				labels: parseLabels(env.labels as string | null),
				publicIp: publicIps[env.id.toString()] || null,
				updateCheckEnabled: updateSettings?.enabled || false,
				updateCheckAutoUpdate: updateSettings?.autoUpdate || false,
				timezone
			};
		}));

		return json(envWithParsedLabels);
	} catch (error) {
		console.error('Failed to get environments:', error);
		return json({ error: 'Failed to get environments' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		if (!data.name) {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		// Host is required for direct and hawser-standard connections
		const connectionType = data.connectionType || 'socket';
		if ((connectionType === 'direct' || connectionType === 'hawser-standard') && !data.host) {
			return json({ error: 'Host is required for this connection type' }, { status: 400 });
		}

		// Validate labels
		const labels = Array.isArray(data.labels) ? data.labels.slice(0, MAX_LABELS) : [];

		const env = await createEnvironment({
			name: data.name,
			host: data.host,
			port: data.port || 2375,
			protocol: data.protocol || 'http',
			tlsCa: data.tlsCa,
			tlsCert: data.tlsCert,
			tlsKey: data.tlsKey,
			tlsSkipVerify: data.tlsSkipVerify || false,
			icon: data.icon || 'globe',
			socketPath: data.socketPath || '/var/run/docker.sock',
			collectActivity: data.collectActivity !== false,
			collectMetrics: data.collectMetrics !== false,
			highlightChanges: data.highlightChanges !== false,
			labels: serializeLabels(labels),
			connectionType: connectionType,
			hawserToken: data.hawserToken
		});

		// Save public IP if provided
		if (data.publicIp) {
			await setEnvironmentPublicIp(env.id, data.publicIp);
		}

		// Notify subprocesses to pick up the new environment
		refreshSubprocessEnvironments();

		// Auto-assign Admin role to creator (Enterprise only)
		if (auth.isEnterprise && auth.authEnabled && auth.isAuthenticated && !auth.isAdmin) {
			const user = auth.user;
			if (user) {
				try {
					const adminRole = await getRoleByName('Admin');
					if (adminRole) {
						await assignUserRole(user.id, adminRole.id, env.id);
					}
				} catch (roleError) {
					// Log but don't fail - environment was created successfully
					console.error(`Failed to auto-assign Admin role to user ${user.id} for environment ${env.id}:`, roleError);
				}
			}
		}

		return json(env);
	} catch (error) {
		console.error('Failed to create environment:', error);
		const message = error instanceof Error ? error.message : 'Failed to create environment';
		return json({ error: message }, { status: 500 });
	}
};

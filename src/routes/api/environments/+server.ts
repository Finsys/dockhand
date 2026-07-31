import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironments, getEnvironmentByName, createEnvironment, assignUserRole, getRoleByName, getEnvironmentPublicIps, setEnvironmentPublicIp, getEnvUpdateCheckSettings, getEnvironmentTimezone, getImagePruneSettings, type Environment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditEnvironment } from '$lib/server/audit';
import { invalidateTokenCacheForUser } from '$lib/server/api-tokens';
import { refreshSubprocessEnvironments } from '$lib/server/subprocess-manager';
import { serializeLabels, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';
import { cleanPem } from '$lib/utils/pem';
import { validateEnvName } from '$lib/utils/env-name';
import {
	connectionInputFromRequest,
	findDuplicateDockerEnvironment
} from '$lib/server/environment-docker-validation';

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

		// Parse labels from JSON string to array, add public IPs, update check settings, image prune settings, and timezone
		const envWithParsedLabels = await Promise.all(environments.map(async env => {
			const updateSettings = updateCheckSettingsMap.get(env.id);
			const timezone = await getEnvironmentTimezone(env.id);
			const imagePruneSettings = await getImagePruneSettings(env.id);
			return {
				...env,
				labels: parseLabels(env.labels as string | null),
				publicIp: publicIps[env.id.toString()] || null,
				updateCheckEnabled: updateSettings?.enabled || false,
				updateCheckAutoUpdate: updateSettings?.autoUpdate || false,
				imagePruneEnabled: imagePruneSettings?.enabled || false,
				timezone
			};
		}));

		return json(envWithParsedLabels);
	} catch (error) {
		console.error('Failed to get environments:', error);
		return json({ error: 'Failed to get environments' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		const nameCheck = validateEnvName(data.name);
		if (!nameCheck.ok) {
			return json({ error: nameCheck.reason }, { status: 400 });
		}

		// Check if environment with this name already exists
		const existing = await getEnvironmentByName(data.name);
		if (existing) {
			return json({ error: 'An environment with this name already exists' }, { status: 409 });
		}

		// Validate connection type
		const validConnectionTypes = ['socket', 'direct', 'hawser-standard', 'hawser-edge'];
		const connectionType = data.connectionType || 'socket';
		if (!validConnectionTypes.includes(connectionType)) {
			return json({ error: `Invalid connection type: ${connectionType}` }, { status: 400 });
		}

		// Host is required for direct and hawser-standard connections
		if ((connectionType === 'direct' || connectionType === 'hawser-standard') && !data.host) {
			return json({ error: 'Host is required for this connection type' }, { status: 400 });
		}

		// Validate labels
		const labels = Array.isArray(data.labels) ? data.labels.slice(0, MAX_LABELS) : [];

		const connectionConfig = connectionInputFromRequest({
			connectionType,
			socketPath: data.socketPath,
			host: data.host,
			port: data.port,
			protocol: data.protocol,
			tlsCa: data.tlsCa,
			tlsCert: data.tlsCert,
			tlsKey: data.tlsKey,
			tlsSkipVerify: data.tlsSkipVerify,
			hawserToken: data.hawserToken
		});
		const duplicateCheck = await findDuplicateDockerEnvironment(connectionConfig);
		if (!duplicateCheck.ok) {
			return json({ error: duplicateCheck.error }, { status: 409 });
		}

		const env = await createEnvironment({
			name: data.name,
			host: data.host,
			port: data.port || 2375,
			protocol: data.protocol || 'http',
			tlsCa: cleanPem(data.tlsCa),
			tlsCert: cleanPem(data.tlsCert),
			tlsKey: cleanPem(data.tlsKey),
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

		// Notify event collectors to pick up the new environment
		refreshSubprocessEnvironments();

		// Auto-assign Admin role to creator (Enterprise only)
		if (auth.isEnterprise && auth.authEnabled && auth.isAuthenticated && !auth.isAdmin) {
			const user = auth.user;
			if (user) {
				try {
					const adminRole = await getRoleByName('Admin');
					if (adminRole) {
						await assignUserRole(user.id, adminRole.id, env.id);
						invalidateTokenCacheForUser(user.id);
					}
				} catch (roleError) {
					// Log but don't fail - environment was created successfully
					console.error(`Failed to auto-assign Admin role to user ${user.id} for environment ${env.id}:`, roleError);
				}
			}
		}

		// Audit log
		await auditEnvironment(event, 'create', env.id, env.name);

		return json(env);
	} catch (error) {
		console.error('Failed to create environment:', error);
		return json({ error: 'Failed to create environment' }, { status: 500 });
	}
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironments, getEnvironmentByName, createEnvironment, assignUserRole, getRoleByName, getEnvironmentPublicIps, setEnvironmentPublicIp, getEnvUpdateCheckSettings, getEnvironmentTimezone, getImagePruneSettings, type Environment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditEnvironment } from '$lib/server/audit';
import { invalidateTokenCacheForUser } from '$lib/server/api-tokens';
import { refreshSubprocessEnvironments } from '$lib/server/subprocess-manager';
import { resetHostDetection, detectHostDataDir } from '$lib/server/host-path';
import { serializeLabels, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';
import { cleanPem } from '$lib/utils/pem';
import { validateEnvName } from '$lib/utils/env-name';

/**
 * @openapi
 * summary: List all Docker environments (hosts) known to Dockhand
 * resp-200: array<{id:integer!, name:string!, connectionType:string!, host:string, port:integer, protocol:string, icon:string, publicIp:string, timezone:string}>
 * resp-200-desc: Environments accessible to the caller (filtered by RBAC in Enterprise mode; all environments in Free edition)
 * resp-200-example: [{"id":1,"name":"hhdocker01","connectionType":"socket","host":null,"port":2375,"protocol":"http","icon":"server","publicIp":"203.0.113.10","timezone":"Europe/Berlin"},{"id":2,"name":"hhdocker02","connectionType":"hawser-edge","host":null,"port":2375,"protocol":"http","icon":"server","publicIp":null,"timezone":"Europe/Berlin"}]
 * resp-403: Permission denied (RBAC 'environments:view' missing)
 * resp-500: Unexpected error while loading environments
 */
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

/**
 * @openapi
 * summary: Register a new Docker environment (host)
 * body: {name:string!, connectionType:string, host:string, port:integer, protocol:string, socketPath:string, icon:string, publicIp:string, labels:string}
 * body-example: {"name":"hhdocker03","connectionType":"socket","socketPath":"/var/run/docker.sock","icon":"server"}
 * resp-200: {id:integer!, name:string!, connectionType:string!}
 * resp-200-example: {"id":3,"name":"hhdocker03","connectionType":"socket"}
 * resp-400: Invalid name, invalid connectionType, or host missing for direct/hawser-standard
 * resp-403: Permission denied (RBAC 'environments:create' missing)
 * resp-409: An environment with this name already exists
 * resp-500: Unexpected error while creating the environment
 */
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

		// Re-run host detection: a socket-proxy deployment with no direct env at boot
		// can now reach Docker through this env without a restart (#1203). Fire-and-forget.
		resetHostDetection();
		void detectHostDataDir();

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

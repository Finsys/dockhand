import { json } from '@sveltejs/kit';
import { restartContainer, inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'restart', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		// Get container name for audit
		let containerName = params.id;
		try {
			const details = await inspectContainer(params.id, envIdNum);
			containerName = details.Name?.replace(/^\//, '') || params.id;
		} catch {
			// Use ID if can't get name
		}

		await restartContainer(params.id, envIdNum);

		// Audit log
		await auditContainer(event, 'restart', params.id, containerName, envIdNum);

		return json({ success: true });
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error restarting container:', error?.message || error);
		return json({ error: 'Failed to restart container' }, { status: 500 });
	}
};

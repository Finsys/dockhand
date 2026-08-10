import { json } from '@sveltejs/kit';
import { stopContainer, inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * POST /api/containers/{id}/stop - Stop a container
 *
 * @openapi
 * summary: Stop a running container
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-403: Permission denied, or (enterprise) no access to the requested environment
 * resp-404: Container not found
 * resp-500: Failed to stop the container
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'stop', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {

		const details = await inspectContainer(params.id, envIdNum);
		const containerName = details.Name.replace(/^\//, '');
		await stopContainer(params.id, envIdNum);

		// Audit log
		await auditContainer(event, 'stop', params.id, containerName, envIdNum);

		return json({ success: true });
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error stopping container:', error?.message || error);
		return json({ error: 'Failed to stop container' }, { status: 500 });
	}
};

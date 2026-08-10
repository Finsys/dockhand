import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { unpauseContainer, inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * POST /api/containers/{id}/unpause - Unpause a container
 *
 * @openapi
 * summary: Resume all processes in a paused container (requires the container 'start' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-403: Permission denied
 * resp-500: Failed to unpause the container
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (unpause uses 'start' permission)
	if (auth.authEnabled && !await auth.can('containers', 'start', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const details = await inspectContainer(params.id, envIdNum);
		const containerName = details.Name.replace(/^\//, '');
		await unpauseContainer(params.id, envIdNum);

		// Audit log
		await auditContainer(event, 'unpause', params.id, containerName, envIdNum);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to unpause container:', error);
		return json({ error: 'Failed to unpause container' }, { status: 500 });
	}
};

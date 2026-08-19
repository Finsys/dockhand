import { json } from '@sveltejs/kit';
import { inspectContainer, pullImage, updateContainer, type CreateContainerOptions } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { removePendingContainerUpdate } from '$lib/server/db';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * POST /api/containers/{id}/update - Recreate a container with new settings/image
 *
 * @openapi
 * summary: Recreate a container with updated create-options (optionally re-pulling the image first), preserving its configuration (requires the 'create' permission)
 * description: The body carries the container create-options (image, name, env, ports, volumes, …) alongside the two control flags below; `repullImage` pulls the image before recreation and `startAfterUpdate` starts the new container once created.
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * body: {image:string, name:string, repullImage:boolean, startAfterUpdate:boolean}
 * body-example: {"image":"nginx:latest","name":"web","repullImage":true,"startAfterUpdate":true}
 * resp-200: {success:boolean!, id:string!}
 * resp-200-example: {"success":true,"id":"3f4a1c2b9d8e"}
 * resp-403: Permission denied
 * resp-404: Container not found
 * resp-500: Failed to update the container (e.g. the image pull or recreation failed)
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (update requires create permission)
	if (auth.authEnabled && !await auth.can('containers', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { startAfterUpdate, repullImage, ...options } = body;

		// Resolve masked secret values (***) back to real values from the current container.
		// The GET endpoint masks secrets in Config.Env, so the edit modal sends *** for unchanged secrets.
		if (Array.isArray(options.env) && options.env.some((e: string) => e.endsWith('=***'))) {
			const currentData = await inspectContainer(params.id, envIdNum);
			const currentEnvMap = new Map<string, string>();
			for (const entry of currentData.Config?.Env || []) {
				const eqIdx = entry.indexOf('=');
				if (eqIdx !== -1) {
					currentEnvMap.set(entry.substring(0, eqIdx), entry.substring(eqIdx + 1));
				}
			}
			options.env = options.env.map((entry: string) => {
				const eqIdx = entry.indexOf('=');
				if (eqIdx === -1) return entry;
				const key = entry.substring(0, eqIdx);
				const value = entry.substring(eqIdx + 1);
				if (value === '***' && currentEnvMap.has(key)) {
					return `${key}=${currentEnvMap.get(key)}`;
				}
				return entry;
			});
		}

		if (repullImage) {
			console.log(`Pulling image...`);
			try {
				await pullImage(options.image, undefined, envIdNum);
				console.log(`Image pulled successfully`);
			} catch (pullError: any) {
				console.log(`Pull failed: ${pullError.message}`);
				throw pullError;
			}
		}

		console.log(`Updating container ${params.id} with name: ${options.name}`);

		const container = await updateContainer(params.id, options, startAfterUpdate, envIdNum);

		// Clear pending update indicator (if any) since container was just updated
		if (envIdNum) {
			await removePendingContainerUpdate(envIdNum, params.id).catch(() => {
				// Ignore errors - record may not exist
			});
		}

		// Audit log - include full options to see what was modified
		await auditContainer(event, 'update', container.id, options.name, envIdNum, { ...options, startAfterUpdate });

		return json({ success: true, id: container.id });
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error updating container:', error?.message || error);
		return json({ error: 'Failed to update container', details: error?.message || String(error) }, { status: 500 });
	}
};

import { json } from '@sveltejs/kit';
import { pullImage, updateContainer, type CreateContainerOptions } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { removePendingContainerUpdate } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const { params, request, url, cookies } = event;
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
	} catch (error) {
		console.error('Error updating container:', error);
		return json({ error: 'Failed to update container', details: String(error) }, { status: 500 });
	}
};

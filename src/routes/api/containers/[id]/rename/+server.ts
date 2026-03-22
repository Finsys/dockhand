import { json } from '@sveltejs/kit';
import { renameContainer, inspectContainer } from '$lib/server/docker';
import { renameAutoUpdateSchedule } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditContainer } from '$lib/server/audit';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const { params, request, url, cookies } = event;
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context (renaming requires create permission)
	if (auth.authEnabled && !await auth.can('containers', 'create', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { name } = await request.json();
		if (!name || typeof name !== 'string') {
			return json({ error: 'New name is required' }, { status: 400 });
		}

		// Get old container name before renaming
		let oldName = params.id;
		try {
			const details = await inspectContainer(params.id, envIdNum);
			oldName = details.Name?.replace(/^\//, '') || params.id;
		} catch {
			// Container might not exist or other error, use ID
		}

		await renameContainer(params.id, name, envIdNum);

		// Audit log
		await auditContainer(event, 'rename', params.id, name, envIdNum, { previousId: params.id, newName: name });

		// Update schedule if exists
		try {
			await renameAutoUpdateSchedule(oldName, name, envIdNum);
		} catch (error) {
			console.error('Failed to update schedule name:', error);
			// Don't fail the rename if schedule update fails
		}

		return json({ success: true });
	} catch (error: any) {
		if (error?.statusCode === 404) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error renaming container:', error?.message || error);
		return json({ error: 'Failed to rename container' }, { status: 500 });
	}
};

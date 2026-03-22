import { json } from '@sveltejs/kit';
import { deleteContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		if (!path) {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		await deleteContainerPath(params.id, path, envIdNum);

		return json({ success: true, path });
	} catch (error: any) {
		console.error('Error deleting path:', error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Path not found' }, { status: 404 });
		}
		if (msg.includes('Cannot delete critical')) {
			return json({ error: msg }, { status: 400 });
		}
		if (msg.includes('Read-only file system')) {
			return json({ error: 'File system is read-only' }, { status: 403 });
		}
		if (msg.includes('Directory not empty')) {
			return json({ error: 'Directory is not empty' }, { status: 400 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to delete: ${msg}` }, { status: 500 });
	}
};

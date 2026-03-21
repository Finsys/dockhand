import { json } from '@sveltejs/kit';
import { chmodContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'exec', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { path, mode, recursive } = body;

		if (!path || typeof path !== 'string') {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		if (!mode || typeof mode !== 'string') {
			return json({ error: 'Mode is required (e.g., "755" or "u+x")' }, { status: 400 });
		}

		await chmodContainerPath(params.id, path, mode, recursive === true, envIdNum);

		return json({ success: true, path, mode, recursive: recursive === true });
	} catch (error: any) {
		console.error('Error changing permissions:', error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Path not found' }, { status: 404 });
		}
		if (msg.includes('Invalid chmod mode')) {
			return json({ error: msg }, { status: 400 });
		}
		if (msg.includes('Read-only file system')) {
			return json({ error: 'File system is read-only' }, { status: 403 });
		}
		if (msg.includes('Operation not permitted')) {
			return json({ error: 'Operation not permitted' }, { status: 403 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to change permissions: ${msg}` }, { status: 500 });
	}
};

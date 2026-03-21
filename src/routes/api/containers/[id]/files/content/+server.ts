import { json } from '@sveltejs/kit';
import { readContainerFile, writeContainerFile } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

// Max file size for reading (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		if (!path) {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		const content = await readContainerFile(
			params.id,
			path,
			envIdNum
		);

		// Check if content is too large
		if (content.length > MAX_FILE_SIZE) {
			return json({ error: 'File is too large to edit (max 1MB)' }, { status: 413 });
		}

		return json({ content, path });
	} catch (error: any) {
		if (error?.statusCode === 404 && !error.message?.includes('No such file')) {
			return json({ error: error.json?.message || 'Container not found' }, { status: 404 });
		}
		console.error('Error reading container file:', error?.message || error);
		const msg = error.message || String(error);

		if (msg.includes('No such file or directory')) {
			return json({ error: 'File not found' }, { status: 404 });
		}
		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied to read this file' }, { status: 403 });
		}
		if (msg.includes('Is a directory')) {
			return json({ error: 'Cannot read a directory' }, { status: 400 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to read file: ${msg}` }, { status: 500 });
	}
};

export const PUT: RequestHandler = async ({ params, url, cookies, request }) => {
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

		const body = await request.json();
		if (typeof body.content !== 'string') {
			return json({ error: 'Content is required' }, { status: 400 });
		}

		// Check content size
		if (body.content.length > MAX_FILE_SIZE) {
			return json({ error: 'Content is too large (max 1MB)' }, { status: 413 });
		}

		await writeContainerFile(
			params.id,
			path,
			body.content,
			envIdNum
		);

		return json({ success: true, path });
	} catch (error: any) {
		console.error('Error writing container file:', error?.message || error);
		const msg = error.message || String(error);

		if (msg.includes('Permission denied')) {
			return json({ error: 'Permission denied to write this file' }, { status: 403 });
		}
		if (msg.includes('No such file or directory')) {
			return json({ error: 'Directory not found' }, { status: 404 });
		}
		if (msg.includes('Read-only file system')) {
			return json({ error: 'File system is read-only' }, { status: 403 });
		}
		if (msg.includes('No space left on device')) {
			return json({ error: 'No space left on device' }, { status: 507 });
		}
		if (msg.includes('container is not running')) {
			return json({ error: 'Container is not running' }, { status: 400 });
		}

		return json({ error: `Failed to write file: ${msg}` }, { status: 500 });
	}
};

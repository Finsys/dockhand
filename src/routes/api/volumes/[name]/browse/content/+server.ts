import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readVolumeFile } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

// Max file size for reading (1MB)
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * @openapi
 * summary: Read the content of a single file inside a Docker volume (files larger than 1MB are rejected)
 * path: name:string! Docker volume name (from GET /api/volumes)
 * query: path:string! File path inside the volume to read
 * query: env:integer Environment ID the volume belongs to (from GET /api/environments)
 * resp-200: {content:string!, path:string!}
 * resp-200-example: {"content":"hello world\n","path":"/data/readme.txt"}
 * resp-400: Path is required, or the path points to a directory
 * resp-403: Permission denied (requires volumes:inspect) or permission denied reading the file
 * resp-404: File not found
 * resp-413: File is too large to view (max 1MB)
 * resp-500: Failed to read file
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.name, 'volume');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		if (!path) {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		const content = await readVolumeFile(
			params.name,
			path,
			envIdNum
		);

		// Check if content is too large
		if (content.length > MAX_FILE_SIZE) {
			return json({ error: 'File is too large to view (max 1MB)' }, { status: 413 });
		}

		return json({ content, path });
	} catch (error: any) {
		console.error('Error reading volume file:', error);

		if (error.message?.includes('No such file or directory')) {
			return json({ error: 'File not found' }, { status: 404 });
		}
		if (error.message?.includes('Permission denied')) {
			return json({ error: 'Permission denied to read this file' }, { status: 403 });
		}
		if (error.message?.includes('Is a directory')) {
			return json({ error: 'Cannot read a directory' }, { status: 400 });
		}

		return json({ error: 'Failed to read file' }, { status: 500 });
	}
};

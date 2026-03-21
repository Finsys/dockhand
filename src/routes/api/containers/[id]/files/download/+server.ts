import { gzipSync } from 'node:zlib';
import { getContainerArchive, statContainerPath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const path = url.searchParams.get('path');
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'view', envIdNum)) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (!path) {
		return new Response(JSON.stringify({ error: 'Path is required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	try {
		// Get format from query parameter (defaults to tar)
		const format = url.searchParams.get('format') || 'tar';

		// Get stat info to determine filename
		let filename: string;
		try {
			const stat = await statContainerPath(params.id, path, envIdNum);
			filename = stat.name || path.split('/').pop() || 'download';
		} catch {
			filename = path.split('/').pop() || 'download';
		}

		// Get the archive from Docker
		const response = await getContainerArchive(
			params.id,
			path,
			envIdNum
		);

		// Prepare response based on format
		let body: ReadableStream<Uint8Array> | Uint8Array = response.body!;
		let contentType = 'application/x-tar';
		let extension = '.tar';

		if (format === 'tar.gz') {
			// Compress with gzip
			const tarData = new Uint8Array(await response.arrayBuffer());
			body = gzipSync(tarData);
			contentType = 'application/gzip';
			extension = '.tar.gz';
		}

		const headers: Record<string, string> = {
			'Content-Type': contentType,
			'Content-Disposition': `attachment; filename="${filename}${extension}"`
		};

		// Set content length for compressed data
		if (body instanceof Uint8Array) {
			headers['Content-Length'] = body.length.toString();
		} else {
			// Pass through content length for streaming tar
			const contentLength = response.headers.get('Content-Length');
			if (contentLength) {
				headers['Content-Length'] = contentLength;
			}
		}

		return new Response(body, { headers });
	} catch (error: any) {
		console.error('Error downloading container file:', error?.message || error);

		if (error.message?.includes('No such file or directory')) {
			return new Response(JSON.stringify({ error: 'File not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (error.message?.includes('Permission denied')) {
			return new Response(JSON.stringify({ error: 'Permission denied to access this path' }), {
				status: 403,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(JSON.stringify({ error: 'Failed to download file' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
};

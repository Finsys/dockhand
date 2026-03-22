import { gzipSync } from 'node:zlib';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getVolumeArchive } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.name, 'volume');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const path = url.searchParams.get('path') || '/';
	const format = url.searchParams.get('format') || 'tar';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('volumes', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		const { response } = await getVolumeArchive(params.name, path, envIdNum);

		// Determine filename
		const volumeName = params.name.replace(/[:/]/g, '_');
		const pathPart = path === '/' ? '' : `-${path.replace(/^\//, '').replace(/\//g, '-')}`;
		let filename = `${volumeName}${pathPart}`;
		let contentType = 'application/x-tar';
		let extension = '.tar';

		// Prepare response based on format
		let body: ReadableStream<Uint8Array> | Uint8Array = response.body!;

		if (format === 'tar.gz') {
			// Compress with gzip
			const tarData = new Uint8Array(await response.arrayBuffer());
			body = gzipSync(tarData);
			contentType = 'application/gzip';
			extension = '.tar.gz';
		}

		// Note: Helper container is cached and reused for subsequent requests.
		// Cache TTL handles cleanup automatically.

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
		console.error('Failed to export volume:', error);

		if (error.message?.includes('No such file or directory')) {
			return json({ error: 'Path not found' }, { status: 404 });
		}

		return json({
			error: 'Failed to export volume',
			details: error.message || String(error)
		}, { status: 500 });
	}
};

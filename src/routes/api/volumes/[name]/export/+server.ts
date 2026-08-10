import { gzipSync } from 'node:zlib';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getVolumeArchive, releaseVolumeHelperContainer, statVolumePath } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { extractFirstFileFromTar } from '$lib/server/tar-extract';
import { attachmentContentDisposition } from '$lib/server/content-disposition';

/**
 * @openapi
 * summary: Export a Docker volume (or a sub-path) as a downloadable archive — streaming tar, gzip-compressed tar.gz, or raw single-file bytes
 * path: name:string! Docker volume name (from GET /api/volumes)
 * query: env:integer Environment ID the volume belongs to (from GET /api/environments)
 * query: path:string Sub-path inside the volume to export (defaults to "/")
 * query: format:string Archive format: "tar" (default), "tar.gz", or "raw" (single file)
 * resp-200: Binary archive stream (Content-Disposition attachment); Content-Type is application/x-tar, application/gzip, or application/octet-stream depending on format
 * resp-403: Permission denied (requires volumes:inspect)
 * resp-404: Path not found
 * resp-500: Failed to export volume
 */
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
		// For format=raw, check if the path is a single file. Directories fall back to tar.
		let isDir = false;
		if (format === 'raw' && path !== '/') {
			try {
				const stat = await statVolumePath(params.name, path, envIdNum);
				isDir = stat.isDir === true;
			} catch {
				// Stat failure: let the archive call below produce the real error
			}
		} else if (format === 'raw') {
			isDir = true; // root path '/' is always a directory
		}

		const { response } = await getVolumeArchive(params.name, path, envIdNum);

		// Determine filename
		const volumeName = params.name.replace(/[:/]/g, '_');
		const pathPart = path === '/' ? '' : `-${path.replace(/^\//, '').replace(/\//g, '-')}`;
		let filename = `${volumeName}${pathPart}`;
		let contentType = 'application/x-tar';
		let extension = '.tar';

		// Prepare response based on format
		let body: ReadableStream<Uint8Array> | Uint8Array = response.body!;

		if (format === 'raw' && !isDir) {
			// Strip the tar wrapper and emit raw file bytes (#1180).
			const tarData = new Uint8Array(await response.arrayBuffer());
			body = extractFirstFileFromTar(tarData);
			// Use the file's basename, not the volume-derived path-joined name.
			filename = path.split('/').filter(Boolean).pop() || filename;
			contentType = 'application/octet-stream';
			extension = '';

			releaseVolumeHelperContainer(params.name, envIdNum).catch(() => {});
		} else if (format === 'tar.gz') {
			// Compress with gzip — fully consumes the archive stream
			const tarData = new Uint8Array(await response.arrayBuffer());
			body = gzipSync(tarData);
			contentType = 'application/gzip';
			extension = '.tar.gz';

			// Data fully read, release helper container immediately
			releaseVolumeHelperContainer(params.name, envIdNum).catch(() => {});
		} else {
			// For streaming tar, wrap the stream to release on completion
			const reader = body.getReader();
			body = new ReadableStream({
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
						releaseVolumeHelperContainer(params.name, envIdNum).catch(() => {});
					} else {
						controller.enqueue(value);
					}
				},
				cancel() {
					reader.cancel();
					releaseVolumeHelperContainer(params.name, envIdNum).catch(() => {});
				}
			});
		}

		const headers: Record<string, string> = {
			'Content-Type': contentType,
			'Content-Disposition': attachmentContentDisposition(`${filename}${extension}`)
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

		// Best-effort cleanup on error
		releaseVolumeHelperContainer(params.name, envIdNum).catch(() => {});

		if (error.message?.includes('No such file or directory')) {
			return json({ error: 'Path not found' }, { status: 404 });
		}

		return json({
			error: 'Failed to export volume',
			details: error.message || String(error)
		}, { status: 500 });
	}
};

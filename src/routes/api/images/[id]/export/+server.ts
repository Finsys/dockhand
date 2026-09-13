import { json } from '@sveltejs/kit';
import { exportImage, inspectImage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { createGzip } from 'zlib';
import { Readable } from 'stream';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';

/**
 * GET /api/images/{id}/export - Download an image as a tar (optionally gzipped)
 *
 * @openapi
 * summary: Export a Docker image as a downloadable tar (or tar.gz) stream
 * path: id:string! Image ID or name to export (from GET /api/images)
 * query: env:integer ID of the environment the image belongs to (from GET /api/environments)
 * query: compress:boolean Gzip the tar stream and serve it as .tar.gz (default false)
 * resp-200: The image tar (application/x-tar) or gzipped tar (application/gzip) as an attachment
 * resp-403: Permission denied
 * resp-500: Docker returned no response body, or the export failed
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'image');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const compress = url.searchParams.get('compress') === 'true';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'inspect', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {

		// Get image info for filename
		let imageName = params.id;
		try {
			const imageInfo = await inspectImage(params.id, envIdNum);
			if (imageInfo.RepoTags?.[0]) {
				// Use first tag, replace : and / with _ for filename safety
				imageName = imageInfo.RepoTags[0].replace(/[:/]/g, '_');
			} else {
				// Use short ID
				imageName = params.id.replace('sha256:', '').slice(0, 12);
			}
		} catch {
			// Use ID as fallback
			imageName = params.id.replace('sha256:', '').slice(0, 12);
		}

		// Get the tar stream from Docker
		const dockerResponse = await exportImage(params.id, envIdNum);

		if (!dockerResponse.body) {
			return json({ error: 'No response body from Docker' }, { status: 500 });
		}

		const extension = compress ? 'tar.gz' : 'tar';
		const filename = `${imageName}.${extension}`;
		const contentType = compress ? 'application/gzip' : 'application/x-tar';

		if (compress) {
			// Create a gzip stream and pipe the tar through it
			const gzip = createGzip();
			const nodeStream = Readable.fromWeb(dockerResponse.body as any);
			const compressedStream = nodeStream.pipe(gzip);

			// Convert back to web stream
			const webStream = Readable.toWeb(compressedStream) as ReadableStream;

			return new Response(webStream, {
				headers: {
					'Content-Type': contentType,
					'Content-Disposition': `attachment; filename="${filename}"`,
					'Cache-Control': 'no-cache'
				}
			});
		} else {
			// Return the tar stream directly
			return new Response(dockerResponse.body, {
				headers: {
					'Content-Type': contentType,
					'Content-Disposition': `attachment; filename="${filename}"`,
					'Cache-Control': 'no-cache'
				}
			});
		}
	} catch (error: any) {
		console.error('Error exporting image:', error);
		return json({ error: error.message || 'Failed to export image' }, { status: 500 });
	}
};

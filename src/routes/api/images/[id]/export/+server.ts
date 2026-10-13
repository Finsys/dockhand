import { json } from '@sveltejs/kit';
import { exportImage, inspectImage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { createGzip } from 'zlib';
import { Readable } from 'stream';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { exportFileStem, shortId, exportRefFor } from '$lib/server/image-export-name';
import type { RequestHandler } from './$types';

/**
 * GET /api/images/{id}/export - Download an image as a tar (optionally gzipped)
 *
 * @openapi
 * summary: Export a Docker image as a downloadable tar (or tar.gz) stream
 * path: id:string! Image ID to export (from GET /api/images); a name containing a slash cannot be used here, since it would split the route
 * query: env:integer ID of the environment the image belongs to (from GET /api/environments)
 * query: tag:string Which of the image's tags to name the download after (defaults to its first tag)
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

		// The tag the caller clicked, so an image with several tags is not always
		// named after the first one.
		const requestedTag = url.searchParams.get('tag');
		let imageName: string;
		let exportRef = params.id;
		try {
			const imageInfo = await inspectImage(params.id, envIdNum);
			imageName = exportFileStem(params.id, imageInfo.RepoTags, requestedTag);

			// Exported by tag rather than by id, because a tar saved by id carries
			// RepoTags: null and loads back as an unnamed image. The tag has to be one
			// the image really has - it is going to the daemon.
			exportRef = exportRefFor(params.id, imageInfo.RepoTags, requestedTag);
		} catch {
			imageName = shortId(params.id);
		}

		// Get the tar stream from Docker
		const dockerResponse = await exportImage(exportRef, envIdNum);

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
			// pipe() does not forward a source error, and the Response has already been
			// returned by the time a multi-GB export loses its host, so the failure
			// arrives on the event loop with nothing to catch it. Hand it to the
			// destination, which surfaces it as a truncated download.
			nodeStream.on('error', (err) => gzip.destroy(err));
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

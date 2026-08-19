import { json } from '@sveltejs/kit';
import { loadImage } from '$lib/server/images';
import { authorize } from '$lib/server/authorize';
import { auditImage } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * POST /api/images/load - load a Docker image from an uploaded tar (docker load),
 * for air-gapped hosts. The request BODY is the raw tar (Content-Type
 * application/x-tar); it is streamed straight to the daemon without buffering, so a
 * large image does not OOM.
 *
 * This is SYNCHRONOUS on purpose - it must NOT use the job-polling pattern. That
 * pattern returns immediately and runs the operation in the background, but the tar
 * lives in the request body, which is torn down once the response is sent; a
 * backgrounded read would hang on a dead stream. So we consume the body and stream it
 * to the daemon while the request is still open, then return the result.
 *
 * Local/socket and direct TCP only (loadImage rejects Hawser).
 *
 * @openapi
 * summary: Load a Docker image from an uploaded tar (docker load) for air-gapped hosts
 * description: The request body is the raw image tar (Content-Type application/x-tar), streamed straight to the daemon without buffering. Local/socket or direct TCP only; Hawser is rejected.
 * body-raw: application/x-tar The raw image tar, streamed to the daemon (docker load)
 * query: env:integer Target environment id
 * resp-200: {success:boolean!, loaded:string}
 * resp-200-desc: loaded echoes the daemon's final line, e.g. "Loaded image: alpine:3.20"
 * resp-400: Request body (an image tar) is required
 * resp-403: Permission denied (needs images:load), or access denied to this environment
 * resp-500: The daemon rejected the tar or the load failed
 */
export const POST: RequestHandler = async (event) => {
	const { request, url, cookies } = event;
	const auth = await authorize(cookies);

	const envIdParam = url.searchParams.get('env');
	const envId = envIdParam ? parseInt(envIdParam) : undefined;

	// Loading a foreign tar is a distinct, higher-trust operation than pulling from a
	// registry (no scan-on-pull, arbitrary user-supplied image), so it has its own
	// permission rather than reusing images:pull.
	if (auth.authEnabled && !(await auth.can('images', 'load', envId))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	if (envId && auth.isEnterprise && !(await auth.canAccessEnvironment(envId))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	if (!request.body) {
		return json({ error: 'Request body (an image tar) is required' }, { status: 400 });
	}
	const tar = request.body as ReadableStream<Uint8Array>;

	await auditImage(event, 'load', 'tar-upload', 'tar-upload', envId);

	try {
		let lastStream = '';
		await loadImage(
			tar,
			(data) => {
				// The daemon's final `stream` line is e.g. "Loaded image: alpine:3.20".
				if (data.stream) lastStream = data.stream.trim();
			},
			envId
		);
		return json({ success: true, loaded: lastStream });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[images/load] failed:', message);
		return json({ success: false, error: message }, { status: 500 });
	}
};

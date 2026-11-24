import { json, type RequestHandler } from '@sveltejs/kit';
import { scanImage, scanResultToDbFormat, type ScanProgress } from '$lib/server/scanner';
import { saveVulnerabilityScan, getLatestScanForImage } from '$lib/server/db';
import { inspectImage } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { authorizeVulnAccess } from '$lib/server/vuln-access';
import { createJobResponse } from '$lib/server/sse';

/**
 * POST /api/images/scan - Start a vulnerability scan (SSE progress)
 *
 * @openapi
 * summary: Start a vulnerability scan of an image and stream scan progress as Server-Sent Events, persisting the results
 * query: env:integer ID of the environment the image belongs to (from GET /api/environments)
 * body: {imageName:string!, scanner:string}
 * body-example: {"imageName":"nginx:latest","scanner":"grype"}
 * resp-200: A Server-Sent Events stream of scan progress, ending with a "result" event
 * resp-400: Image name is required
 * resp-403: Permission denied
 */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	const auth = await authorize(cookies);

	const envIdParam = url.searchParams.get('env');
	const envId = envIdParam ? parseInt(envIdParam) : undefined;

	// Permission check with environment context (Scanning is an inspect operation)
	if (auth.authEnabled && !await auth.can('images', 'inspect', envId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const body = await request.json();
	const { imageName, scanner: forceScannerType } = body;

	if (!imageName) {
		return json({ error: 'Image name is required' }, { status: 400 });
	}

	return createJobResponse(async (send) => {
		const sendProgress = (progress: ScanProgress) => {
			send('progress', progress);
		};

		try {
			const results = await scanImage(imageName, envId, sendProgress, forceScannerType);

			// Save results to database
			for (const result of results) {
				await saveVulnerabilityScan(scanResultToDbFormat(result, envId));
			}

			// Send final complete message with all results
			const completeProgress: ScanProgress = {
				stage: 'complete',
				message: `Scan complete - found ${results.reduce((sum, r) => sum + r.vulnerabilities.length, 0)} vulnerabilities`,
				progress: 100,
				result: results[0],
				results: results // Include all scanner results
			};
			send('result', completeProgress);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorProgress: ScanProgress = {
				stage: 'error',
				message: `Scan failed: ${errorMsg}`,
				error: errorMsg
			};
			send('result', errorProgress);
			throw error;
		}
	}, request);
};

/**
 * GET /api/images/scan - Cached scan results for an image
 *
 * @openapi
 * summary: Return the latest cached vulnerability scan for an image, resolving its tag to a SHA256 ID
 * query: image:string! Image name or ID to look up cached results for
 * query: scanner:string Restrict the lookup to a specific scanner (e.g. grype or trivy)
 * resp-200: {found:boolean!, result:object}
 * resp-200-desc: found=false when no cached scan exists; otherwise result holds the stored scan. Takes an env query param (from GET /api/environments); with app auth enabled it is required (400 otherwise) and scopes the lookup to that environment (403 when the caller cannot access it)
 * resp-200-example: {"found":true,"result":{"imageId":"sha256:abc123","scanner":"grype","summary":{"critical":0,"high":2}}}
 * resp-400: Image name is required, or env is required when app auth is enabled
 * resp-500: Failed to get scan results
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	// RBAC (images:view) + enterprise environment scoping, shared with the other
	// vuln endpoints. The same image SHA can be scanned in multiple environments, so
	// require a concrete env when auth is on - otherwise the scope check cannot run
	// and a user scoped to env A could read env B's scans by omitting env (CWE-639).
	const { envIdNum: envId, denied, authEnabled } = await authorizeVulnAccess(cookies, url);
	if (denied) return json({ error: denied.message }, { status: denied.status });
	if (authEnabled && envId === undefined) {
		return json({ error: 'env is required' }, { status: 400 });
	}

	const imageName = url.searchParams.get('image');
	const scanner = url.searchParams.get('scanner') as 'grype' | 'trivy' | undefined;

	if (!imageName) {
		return json({ error: 'Image name is required' }, { status: 400 });
	}

	try {
		// Resolve tag to SHA256 ID for reliable cache lookup
		let imageId = imageName;
		try {
			const info = await inspectImage(imageName, envId) as any;
			if (info.Id) imageId = info.Id;
		} catch {
			// Fall back to name if inspect fails
		}

		const result = await getLatestScanForImage(imageId, scanner, envId);
		if (!result) {
			return json({ found: false });
		}

		return json({
			found: true,
			result
		});
	} catch (error) {
		console.error('Failed to get scan results:', error);
		return json({ error: 'Failed to get scan results' }, { status: 500 });
	}
};

import { json, type RequestHandler } from '@sveltejs/kit';
import { scanImage, type ScanProgress, type ScanResult } from '$lib/server/scanner';
import { saveVulnerabilityScan, getLatestScanForImage } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { createJobResponse } from '$lib/server/sse';

// Helper to convert ScanResult to database format
function scanResultToDbFormat(result: ScanResult, envId?: number) {
	return {
		environmentId: envId ?? null,
		imageId: result.imageId || result.imageName, // Fallback to imageName if imageId is undefined
		imageName: result.imageName,
		scanner: result.scanner,
		scannedAt: result.scannedAt,
		scanDuration: result.scanDuration,
		criticalCount: result.summary.critical,
		highCount: result.summary.high,
		mediumCount: result.summary.medium,
		lowCount: result.summary.low,
		negligibleCount: result.summary.negligible,
		unknownCount: result.summary.unknown,
		vulnerabilities: JSON.stringify(result.vulnerabilities),
		error: result.error ?? null
	};
}

// POST - Start a scan (returns { jobId } for progress polling, or synchronous JSON for Accept: application/json)
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

// GET - Get cached scan results for an image
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const imageName = url.searchParams.get('image');
	const envIdParam = url.searchParams.get('env');
	const envId = envIdParam ? parseInt(envIdParam) : undefined;
	const scanner = url.searchParams.get('scanner') as 'grype' | 'trivy' | undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('images', 'view', envId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (!imageName) {
		return json({ error: 'Image name is required' }, { status: 400 });
	}

	try {
		// Note: getLatestScanForImage signature is (imageId, scanner, environmentId)
		const result = await getLatestScanForImage(imageName, scanner, envId);
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

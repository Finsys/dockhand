import { json, type RequestHandler } from '@sveltejs/kit';
import { scanImage, scanResultToDbFormat } from '$lib/server/scanner';
import { saveVulnerabilityScan, deleteScansForImageScanner } from '$lib/server/db';
import { listImages } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { createJobResponse } from '$lib/server/sse';

/**
 * Scan every image in the environment for vulnerabilities. Tagged images scan by
 * tag; untagged but digest-pinned images (e.g. renovate `@sha256:` pins) scan by
 * their repo digest so they aren't silently skipped (#1286).
 * Reuses the per-image scan flow, sequentially, reporting N/total progress.
 * A single image failing does not abort the batch.
 *
 * @openapi
 * summary: Scan every image in an environment for vulnerabilities, streaming per-image progress as Server-Sent Events
 * query: env:integer ID of the environment whose images to scan (from GET /api/environments)
 * resp-200: A Server-Sent Events stream of progress and per-image results, ending with a summary "result" event
 * resp-403: Permission denied, or (enterprise) no access to this environment
 */
export const POST: RequestHandler = async ({ request, url, cookies }) => {
	const auth = await authorize(cookies);

	const envIdParam = url.searchParams.get('env');
	const envId = envIdParam ? parseInt(envIdParam) : undefined;

	if (auth.authEnabled && !(await auth.can('images', 'inspect', envId))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	if (envId && auth.isEnterprise && !(await auth.canAccessEnvironment(envId))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	return createJobResponse(async (send, isCancelled) => {
		const images = await listImages(envId);

		// One scan target per image: prefer a usable tag; for untagged images
		// (digest-pinned via renovate etc.) fall back to a repo digest so they
		// aren't silently skipped (#1286). Truly dangling images — no tag AND no
		// digest — are left out; they're build cruft, not real scan targets.
		const targets = images
			.map((img) => {
				const tag = (img.tags || []).find((t) => t && !t.includes('<none>'));
				if (tag) return tag;
				return (img.repoDigests || []).find((d) => d && !d.includes('<none>')) || null;
			})
			.filter((t): t is string => !!t);
		// Dedupe (a repo can appear once per tag; scan each unique tag once)
		const uniqueTargets = Array.from(new Set(targets));

		const total = uniqueTargets.length;
		send('progress', { current: 0, total, imageName: '' });

		let scanned = 0;
		let failed = 0;
		let cancelled = false;

		for (let i = 0; i < uniqueTargets.length; i++) {
			if (isCancelled()) {
				cancelled = true;
				break;
			}
			const imageName = uniqueTargets[i];
			// Announce which image is about to be scanned.
			send('progress', { current: i, total, imageName });
			try {
				const results = await scanImage(imageName, envId);
				for (const result of results) {
					// Replace (not accumulate): drop this image+scanner's prior rows first,
					// so the DB holds only the latest scan per image. Nothing is lost on
					// cancel/failure since we only delete right before re-inserting.
					await deleteScansForImageScanner(result.imageId, result.scanner, envId ?? null);
					await saveVulnerabilityScan(scanResultToDbFormat(result, envId));
				}
				// Per-image findings: one entry per scanner that ran, with severity counts.
				const scanners = results.map((r) => ({
					scanner: r.scanner,
					critical: r.summary.critical,
					high: r.summary.high,
					medium: r.summary.medium,
					low: r.summary.low,
					durationMs: r.scanDuration
				}));
				send('scanned', { current: i + 1, total, imageName, scanners, ok: true });
				scanned++;
			} catch (error) {
				failed++;
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[scan-all] Failed to scan ${imageName}: ${msg}`);
				send('scanned', { current: i + 1, total, imageName, scanners: [], ok: false, error: msg });
			}
		}


		send('progress', { current: total, total, imageName: '' });
		send('result', { scanned, failed, total, cancelled });
	}, request);
};

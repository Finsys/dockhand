import { json } from '@sveltejs/kit';
import { getJob, cancelJob, canAccessJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/**
 * GET /api/jobs/[id]
 * Poll a job's status and accumulated lines.
 * Returns all lines every time — client tracks its own cursor locally.
 *
 * Authenticated via the global hook. Only the user who created the job (or an
 * admin) may read it; others get a 404 so a job's existence is not revealed.
 */
/**
 * @openapi
 * summary: Poll a background job's status and accumulated output lines (owner or admin only)
 * path: id:string! Job id (UUID)
 * resp-200: {id:string!, status:string!, lines:array<{event:string, data:{}}>!, result:{}}
 * resp-404: Job not found
 */
export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job || !canAccessJob(job)) {
		return json({ error: 'Job not found' }, { status: 404 });
	}

	return json({
		id: job.id,
		status: job.status,
		lines: job.lines,
		result: job.result ?? null
	});
};

/**
 * DELETE /api/jobs/[id]
 * Request cancellation of a running job. The job's operation polls the flag
 * between units of work and stops gracefully.
 *
 * Only the user who created the job (or an admin) may cancel it; others get a
 * 404 so a job's existence is not revealed.
 *
 * @openapi
 * summary: Request cancellation of a running background job (owner or admin only)
 * path: id:string! Job id (UUID)
 * resp-200: {cancelled:boolean!}
 * resp-404: Job not found
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job || !canAccessJob(job)) {
		return json({ error: 'Job not found' }, { status: 404 });
	}
	const cancelled = cancelJob(params.id);
	return json({ cancelled });
};

import { json } from '@sveltejs/kit';
import { getJob, cancelJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/**
 * GET /api/jobs/[id]
 * Poll a job's status and accumulated lines.
 * Returns all lines every time — client tracks its own cursor locally.
 */
/**
 * @openapi
 * summary: Poll a background job's status and accumulated output lines (no auth — job ids are unguessable UUIDs)
 * path: id:string! Job id (UUID)
 * resp-200: {id:string!, status:string!, lines:array<{event:string, data:{}}>!, result:{}}
 * resp-404: Job not found
 */
export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) {
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
 * @openapi
 * summary: Request cancellation of a running background job (no auth — job ids are unguessable UUIDs)
 * path: id:string! Job id (UUID)
 * resp-200: {cancelled:boolean!}
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const cancelled = cancelJob(params.id);
	return json({ cancelled });
};

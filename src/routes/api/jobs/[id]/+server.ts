import { json } from '@sveltejs/kit';
import { getJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/**
 * GET /api/jobs/[id]
 * Poll a job's status and accumulated lines.
 * Returns all lines every time — client tracks its own cursor locally.
 * No auth required: job IDs are UUIDs (unguessable), no sensitive data beyond what the initiating user triggered.
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

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitStack } from '$lib/server/db';
import { deployGitStackWithProgress } from '$lib/server/git';
import { authorize } from '$lib/server/authorize';
import { createJob, appendLine, completeJob, failJob } from '$lib/server/jobs';
import { prefersJSON, sseToJSON } from '$lib/server/sse';

export const POST: RequestHandler = async ({ params, cookies, request }) => {
	const auth = await authorize(cookies);

	const id = parseInt(params.id);
	const gitStack = await getGitStack(id);

	if (!gitStack) {
		return new Response(JSON.stringify({ error: 'Git stack not found' }), {
			status: 404,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'start', gitStack.environmentId || undefined)) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Backward compat: API clients sending Accept: application/json get synchronous SSE result
	if (prefersJSON(request)) {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				const sendEvent = (data: unknown) => {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				};
				try {
					await deployGitStackWithProgress(id, sendEvent);
				} catch (error: any) {
					sendEvent({ status: 'error', error: error.message || 'Unknown error' });
				} finally {
					controller.close();
				}
			}
		});
		const sseResponse = new Response(stream, {
			headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
		});
		return sseToJSON(sseResponse);
	}

	// Job pattern: fire and forget, return jobId immediately
	const job = createJob();

	deployGitStackWithProgress(id, (data: unknown) => {
		appendLine(job, { data });
	})
		.then(() => {
			const lastLine = job.lines[job.lines.length - 1];
			const lastData = lastLine?.data as any;
			completeJob(job, lastData ?? { status: 'complete' });
		})
		.catch((err: unknown) => {
			failJob(job, err instanceof Error ? err.message : String(err));
		});

	return json({ jobId: job.id });
};

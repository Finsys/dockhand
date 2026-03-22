import { json } from '@sveltejs/kit';
import { createJob, appendLine, completeJob, failJob } from '$lib/server/jobs';

/**
 * Check if the client prefers JSON over SSE.
 * Returns true when Accept header includes application/json but NOT text/event-stream.
 */
export function prefersJSON(request?: Request): boolean {
	const accept = request?.headers.get('accept') || '';
	return accept.includes('application/json') && !accept.includes('text/event-stream');
}

/**
 * Wrap an SSE Response for JSON-preferring clients.
 *
 * Consumes the SSE stream using proper event framing (blank-line delimited,
 * multi-line data joined with \n, CRLF stripped). Returns the `result` event
 * data as a JSON response, or a fallback if no result event was emitted.
 *
 * Usage:
 *   if (prefersJSON(request)) return sseToJSON(buildSSEResponse());
 *   return buildSSEResponse();
 */
export async function sseToJSON(sseResponse: Response): Promise<Response> {
	const reader = sseResponse.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let eventType = '';
	let dataLines: string[] = [];
	let resultData: unknown = null;

	const dispatch = () => {
		const data = dataLines.join('\n');
		const type = eventType || 'message';
		eventType = '';
		dataLines = [];
		if (type === 'result' && data) {
			try {
				resultData = JSON.parse(data);
			} catch {
				// keep previous resultData
			}
		}
	};

	const parseLine = (rawLine: string) => {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.startsWith(':')) return;
		if (line === '') { dispatch(); return; }
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let val = colon === -1 ? '' : line.slice(colon + 1);
		if (val.startsWith(' ')) val = val.slice(1);
		if (field === 'event') eventType = val || 'message';
		else if (field === 'data') dataLines.push(val);
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) parseLine(line);
		}

		// Flush remaining bytes and process trailing content
		buffer += decoder.decode();
		if (buffer) {
			for (const line of buffer.split('\n')) parseLine(line);
		}
		// Final dispatch for servers missing trailing blank line
		if (dataLines.length > 0) dispatch();
	} catch {
		// stream error, return what we have
	} finally {
		reader.releaseLock();
	}

	const body = resultData ?? { success: false, error: 'No result' };
	return new Response(JSON.stringify(body), {
		headers: { 'Content-Type': 'application/json' }
	});
}

/**
 * Job-based response for long-running operations.
 *
 * Backward compat: API clients that send `Accept: application/json` (and not
 * `text/event-stream`) get a synchronous JSON result directly.
 *
 * All other clients receive `{ jobId }` immediately. The operation runs in the
 * background and results accumulate in the job store. Clients poll /api/jobs/{id}.
 *
 * The send() callback stores lines with { event, data } so the polling client
 * can reconstruct the same event stream semantics used by the old SSE flow.
 */
export function createJobResponse(
	operation: (send: (event: string, data: unknown) => void) => Promise<void>,
	request?: Request
): Response {
	// Backward compat: synchronous JSON path for explicit application/json callers
	if (prefersJSON(request)) {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				let resultData: unknown = { success: false, error: 'No result' };
				const send = (_event: string, data: unknown) => {
					resultData = data;
				};
				try {
					await operation(send);
				} catch (error) {
					resultData = { success: false, error: String(error) };
				}
				controller.enqueue(encoder.encode(JSON.stringify(resultData)));
				controller.close();
			}
		});
		return new Response(stream, {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Fire and forget: create job, run operation in background, return jobId immediately
	const job = createJob();

	const send = (event: string, data: unknown) => {
		appendLine(job, { event, data });
	};

	operation(send)
		.then(() => {
			const resultLine = job.lines.findLast((l) => l.event === 'result');
			completeJob(job, resultLine?.data ?? { success: true });
		})
		.catch((err: unknown) => {
			failJob(job, err instanceof Error ? err.message : String(err));
		});

	return json({ jobId: job.id });
}

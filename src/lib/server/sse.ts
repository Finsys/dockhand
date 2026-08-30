import { json } from '@sveltejs/kit';
import { createJob, appendLine, completeJob, failJob } from '$lib/server/jobs';
import { prefersJSON } from '$lib/server/sse-parser';
import { shouldRecord } from '$lib/server/deploy-recorder';

// Re-export pure parsing utilities (no server deps) for backward compat
export { prefersJSON, sseToJSON } from '$lib/server/sse-parser';

/**
 * Optional hook that mirrors qualifying progress lines into a persisted run record and
 * is told how the run ended once it's done.
 *
 * Built in the ROUTE (see Task 10's deploy-run-record.ts), never here: constructing it
 * needs db.ts, and importing that here would make this module unimportable under Bun
 * (ERR_DLOPEN_FAILED) -- breaking every unit test that exercises createJobResponse
 * directly, this file's own included.
 */
export interface RunRecorder {
	/** Called for every send() whose (event, data) passes shouldRecord -- never raw. */
	line(line: string): void;
	/**
	 * Extends the redaction secret list with values that were not yet known when the
	 * recorder was constructed -- e.g. provider-resolved secrets (Bitwarden/1Password/
	 * etc. bulk pulls or inline refs) that deployStack() only resolves internally,
	 * strictly AFTER the caller built this recorder from the DB-only vars it had at the
	 * time. Callers MUST call this (if they have anything to add) before end(), which is
	 * the only method that reads the accumulated secret list -- see deploy-run-record.ts.
	 */
	addSecrets(values: string[]): void;
	/** Called exactly once, on every path out of the operation (success, failure, or throw). */
	end(ok: boolean, exitCode?: number, error?: string): Promise<void>;
}

/** Extracts the redacted line string from a shouldRecord-qualifying { type: 'line', line } payload. */
function extractLine(data: unknown): string | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const line = (data as { line?: unknown }).line;
	return typeof line === 'string' ? line : undefined;
}

/** Derives the RunRecorder.end() args from the JSON path's held-back result payload. */
function endFromResult(resultData: unknown): { ok: boolean; error?: string } {
	if (typeof resultData !== 'object' || resultData === null) return { ok: false };
	const obj = resultData as { success?: unknown; error?: unknown };
	if (obj.success === true) return { ok: true };
	const { error } = obj;
	if (error === undefined) return { ok: false };
	return { ok: false, error: typeof error === 'string' ? error : String(error) };
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
 *
 * `recorder` is optional and, if omitted, changes nothing about the above -- see
 * RunRecorder's doc comment for why it's built by the caller, not here. When given, it
 * is fed from BOTH send() implementations below (JSON path and streaming path) so that
 * every caller of createJobResponse, not just the ones on the streaming path, gets its
 * progress lines mirrored.
 */
export function createJobResponse(
	operation: (send: (event: string, data: unknown) => void, isCancelled: () => boolean) => Promise<void>,
	request?: Request,
	recorder?: RunRecorder
): Response {
	// Backward compat: synchronous JSON path for explicit application/json callers
	if (prefersJSON(request)) {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			async start(controller) {
				let resultData: unknown = { success: false, error: 'No result' };
				let sentResult = false;
				const send = (event: string, data: unknown) => {
					if (recorder && shouldRecord(event, data)) {
						const line = extractLine(data);
						if (line !== undefined) recorder.line(line);
					}
					// Keep the last 'result' payload as the response body. A handler
					// may send progress events and then throw (e.g. a backup that
					// returns { status: 'error' } and rethrows), so preserve the
					// structured result rather than replacing it with a bare error.
					if (event === 'result') { resultData = data; sentResult = true; }
					else if (!sentResult) resultData = data;
				};
				try {
					await operation(send, () => false);
				} catch (error) {
					if (!sentResult) resultData = { success: false, error: String(error) };
				} finally {
					// Awaited here, before enqueue/close: this async start() is the
					// only place on the JSON path where "the run is over" exists as a
					// moment in time, so the recorder's close is placed right on it.
					if (recorder) {
						const { ok, error } = endFromResult(resultData);
						await recorder.end(ok, undefined, error);
					}
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
		if (recorder && shouldRecord(event, data)) {
			const line = extractLine(data);
			if (line !== undefined) recorder.line(line);
		}
		appendLine(job, { event, data });
	};

	// Guards RunRecorder.end()'s "called exactly once" contract: if the .then()
	// branch below reaches its recorder.end() call and that call itself throws,
	// the rejection lands in .catch(), which must not call end() a second time.
	// Set right before invoking end() (not after it resolves), so a throwing
	// end() is still counted as "attempted" and never retried.
	let recorderEnded = false;

	operation(send, () => job.cancelRequested === true)
		.then(async () => {
			const resultLine = job.lines.findLast((l) => l.event === 'result');
			const resultData = resultLine?.data ?? { success: true };
			completeJob(job, resultData);
			// Nothing on this path awaits createJobResponse's return value (it already
			// returned { jobId } below), so this runs after the response has gone out.
			// The record is still closed reliably -- just not before the client sees it.
			//
			// A failed compose run does not throw: it sends `result: {success:false,
			// error}` and returns normally, landing HERE, not in .catch() below. This is
			// the path every browser call takes (neither +page.svelte nor StackModal.svelte
			// send an Accept header) -- reuse the JSON path's endFromResult() instead of
			// hardcoding end(true), or every such run was recorded as a success.
			if (recorder) {
				recorderEnded = true;
				const { ok, error } = endFromResult(resultData);
				await recorder.end(ok, undefined, error);
			}
		})
		.catch(async (err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			failJob(job, message);
			if (recorder && !recorderEnded) await recorder.end(false, undefined, message);
		});

	return json({ jobId: job.id });
}

/**
 * Job-polling wrapper for a read endpoint that just returns DATA (no progress lines):
 * run `fn`, deliver its value as the single `result`, and turn a thrown error into a
 * `{ error }` result (HTTP 200 + a failed-shaped payload the client reads back via
 * readJobResponse). Collapses the identical createJobResponse+try/catch boilerplate every
 * backup read endpoint (browse/preview/metadata/diff) had. The proxy sees {jobId} at once,
 * so a slow restic op can't be aborted mid-flight at the reverse-proxy's ~15s cap.
 */
export function jobResult<T>(request: Request | undefined, fn: () => Promise<T>): Response {
	return createJobResponse(async (send) => {
		try {
			send('result', await fn());
		} catch (error) {
			send('result', { error: error instanceof Error ? error.message : String(error) });
		}
	}, request);
}

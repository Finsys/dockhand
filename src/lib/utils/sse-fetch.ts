import type { JobLine } from '$lib/server/jobs';

/**
 * Reads a job-based response (POST returns { jobId }) and polls until complete.
 * Drop-in replacement for readSSEResponse when the endpoint has been migrated to jobs.
 *
 * Returns the job's final result (equivalent to the 'result' event data in SSE).
 */
export async function readJobResponse(
	response: Response
): Promise<{ success?: boolean; error?: string; [key: string]: unknown }> {
	// Fall through for non-JSON or error responses
	if (!response.ok) {
		try {
			return await response.json();
		} catch {
			return { success: false, error: `HTTP ${response.status}` };
		}
	}

	const data = await response.json();

	// If the response is a { jobId } shape, poll the job endpoint
	if (data && typeof data === 'object' && 'jobId' in data) {
		const result = await watchJob(data.jobId as string, () => {
			// readJobResponse callers don't need line-by-line updates
		});
		return result as { success?: boolean; error?: string; [key: string]: unknown };
	}

	// Fallback: response was already the final result (e.g. application/json sync path)
	return data;
}

const POLL_INTERVAL_MS = 500;

/**
 * Polls /api/jobs/{jobId} every 500ms. Calls onLine for each new line as they arrive.
 * Resolves with the job's final result when status is 'done' or 'error'.
 */
export async function watchJob(
	jobId: string,
	onLine: (line: JobLine) => void
): Promise<unknown> {
	let cursor = 0;

	while (true) {
		const res = await fetch(`/api/jobs/${jobId}`);
		if (!res.ok) {
			throw new Error(`Job poll failed: HTTP ${res.status}`);
		}

		const job = await res.json() as {
			id: string;
			status: 'running' | 'done' | 'error';
			lines: JobLine[];
			result: unknown;
		};

		// Deliver new lines since last poll
		const newLines = job.lines.slice(cursor);
		cursor = job.lines.length;
		for (const line of newLines) {
			onLine(line);
		}

		if (job.status !== 'running') {
			return job.result;
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

export interface JobPollingCallbacks {
	onDone?: () => void | Promise<void>;
	onError?: (error: string | undefined) => void | Promise<void>;
	onUnavailable?: () => void | Promise<void>;
}

export interface JobPollingHandle {
	stop: () => void;
}

/**
 * Poll a background job (/api/jobs/:id) until it finishes.
 * Polls immediately, then every `intervalMs` (default 1500).
 * `onUnavailable` fires when the job endpoint returns an error (e.g. job
 * purged while the server was restarted); polling stops in that case.
 * Network errors are ignored and polling continues silently.
 */
export function startJobPolling(
	jobId: string,
	{ onDone, onError, onUnavailable, intervalMs = 1500 }: JobPollingCallbacks & { intervalMs?: number } = {}
): JobPollingHandle {
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	const stop = () => {
		stopped = true;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	const poll = async () => {
		if (stopped) return;
		try {
			const res = await fetch(`/api/jobs/${jobId}`);
			if (stopped) return;
			if (!res.ok) {
				stop();
				onUnavailable?.();
				return;
			}
			const job = await res.json();
			if (stopped) return;
			if (job.status === 'done') {
				stop();
				onDone?.();
			} else if (job.status === 'error') {
				stop();
				onError?.((job.result as { error?: string } | null)?.error ?? undefined);
			}
			// status === 'running' → keep polling
		} catch {
			// Network error — keep polling silently
		}
	};

	poll();
	timer = setInterval(poll, intervalMs);

	return { stop };
}

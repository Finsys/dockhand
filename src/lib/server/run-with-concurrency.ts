/**
 * Run async tasks with a bounded concurrency limit (no extra dependency).
 * Preserves input order for the resolved results.
 */
export async function runWithConcurrency<T>(
	limit: number,
	tasks: Array<() => Promise<T>>
): Promise<T[]> {
	const results = new Array<T>(tasks.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		for (;;) {
			const index = nextIndex++;
			if (index >= tasks.length) return;
			results[index] = await tasks[index]();
		}
	}

	const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

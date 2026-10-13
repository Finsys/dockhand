/** Bound the whole advisory, including storage, daemon inspection and authentication.
 * Racing also bounds dependencies that cannot be cancelled; abort-aware I/O is stopped. */
export async function releaseAgeAdvisory<T>(lookup: (signal: AbortSignal) => Promise<T>, timeoutMs = 8000): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error('Image age lookup timed out');
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	try {
		return await Promise.race([Promise.resolve().then(() => lookup(controller.signal)), deadline]);
	} finally {
		clearTimeout(timer!);
	}
}

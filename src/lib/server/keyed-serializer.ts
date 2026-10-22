/** Thrown when a caller gives up waiting for its turn under a key. */
export class QueueTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QueueTimeoutError';
	}
}

/**
 * Run operations that share a resource one at a time, in arrival order.
 *
 * `run` chains onto the key's current tail, so a second caller waits for the
 * first to settle before starting. The tail always resolves, so a failed
 * operation cannot reject an unrelated one queued behind it.
 */
export class KeyedSerializer {
	// One tail promise per key. Callers use a small, bounded key space (a restic
	// repository, a CLI binary path), so the map is never pruned.
	private tails = new Map<string, Promise<void>>();

	/**
	 * `waitMs` bounds only the WAIT for the key to come free, never the operation
	 * itself: a long-running turn is the normal case and must not abort itself.
	 * On expiry the caller gets a QueueTimeoutError and its turn is skipped, so
	 * the queue keeps moving rather than stalling behind an abandoned slot.
	 */
	async run<T>(key: string | number, fn: () => Promise<T>, waitMs?: number): Promise<T> {
		const k = String(key);
		const prev = this.tails.get(k) ?? Promise.resolve();
		// Gate that opens when our turn is fully done, so the next caller waits.
		let opened!: () => void;
		const done = new Promise<void>((r) => {
			opened = r;
		});
		this.tails.set(k, prev.then(() => done));

		try {
			await this.awaitTurn(prev, k, waitMs); // prev never rejects
		} catch (error) {
			opened(); // give the slot up rather than holding the chain
			throw error;
		}

		try {
			return await fn();
		} finally {
			opened(); // release the next caller regardless of our outcome
		}
	}

	private async awaitTurn(prev: Promise<void>, key: string, waitMs?: number): Promise<void> {
		if (waitMs === undefined) return prev;

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				prev,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new QueueTimeoutError(`timed out waiting for "${key}" after ${waitMs}ms`)),
						waitMs
					);
				})
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

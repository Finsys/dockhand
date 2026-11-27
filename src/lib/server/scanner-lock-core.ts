// Per-type serial lock for scanner runs. Chaining each run on the previous one's
// tail promise serializes every caller (N queued callers run strictly one at a
// time), unlike a read-the-current-promise-once scheme, where every caller that
// arrives while one holds the lock reads the SAME promise and all resume together
// when it resolves - capping concurrency at N-1, not 1.

export interface ScannerLock {
	run<T>(type: string, fn: () => Promise<T>): Promise<T>;
	/** Number of types with a scan queued or running right now (0 when idle). */
	activeTypes(): number;
}

export function createScannerLock(): ScannerLock {
	// Per type: the tail of the chain.
	const tails = new Map<string, Promise<void>>();

	return {
		run<T>(type: string, fn: () => Promise<T>): Promise<T> {
			const prev = tails.get(type) ?? Promise.resolve();

			// Run after prev regardless of whether prev settled or rejected, so one
			// failed scan never blocks the queue behind it.
			const result = prev.then(fn, fn);

			// The stored tail swallows the result so a rejection does not poison the
			// chain, and drops the type once the last queued run has settled so
			// activeTypes() returns to 0 when idle.
			const settled = result.then(
				() => {},
				() => {}
			);
			const tail = settled.then(() => {
				if (tails.get(type) === tail) tails.delete(type);
			});
			tails.set(type, tail);

			// The caller still sees the real fulfilment or rejection of its own run.
			return result;
		},

		activeTypes(): number {
			return tails.size;
		}
	};
}

/**
 * Minimal promise-based semaphore — bounds concurrent execution of a global
 * resource (e.g. git subprocesses). No dependency.
 */
export class Semaphore {
	private count: number;
	private waiters: Array<() => void> = [];

	constructor(limit: number) {
		this.count = limit;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.count > 0) {
			this.count--;
		} else {
			// Queue. release() hands us a slot directly (shift, no count++), so
			// we must NOT decrement on wake — otherwise a new run() landing
			// between the wake and this continuation would see the same freed
			// slot and over-admit past the limit.
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	/**
	 * Run immediately when a slot is free; return null when at capacity
	 * (no queueing). Atomic — the capacity check and acquire share the same
	 * synchronous section, so concurrent callers cannot both pass the gate.
	 */
	tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
		if (this.count <= 0) return null;
		this.count--;
		return (async () => {
			try {
				return await fn();
			} finally {
				this.release();
			}
		})();
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) {
			// Hand the slot directly to the next waiter WITHOUT counting up, so a
			// concurrent run() cannot observe a phantom free slot and exceed the
			// limit. The slot is transferred by the shift.
			next();
		} else {
			this.count++;
		}
	}
}

/**
 * Generic coalescing runner — serializes concurrent async operations per key
 * into at most one in-flight + one trailing execution.
 */

export type CoalesceWaiter<TResult> = {
	resolve: (value: TResult) => void;
	reject: (reason?: unknown) => void;
};

export type CoalesceSlotKey = number | string;

export type CoalesceSlot<TOpts, TResult> = {
	done: boolean;
	trailing: { opts: TOpts; waiters: CoalesceWaiter<TResult>[] } | null;
	idle: Promise<void>;
	markIdle: () => void;
};

export function createCoalesceSlot<TOpts, TResult>(): CoalesceSlot<TOpts, TResult> {
	let markIdle!: () => void;
	const idle = new Promise<void>((resolve) => {
		markIdle = resolve;
	});
	return { done: false, trailing: null, idle, markIdle };
}

export async function runCoalesced<TOpts, TResult>(
	slots: Map<CoalesceSlotKey, CoalesceSlot<TOpts, TResult>>,
	key: CoalesceSlotKey,
	opts: TOpts,
	merge: (a: TOpts, b: TOpts) => TOpts,
	fn: (opts: TOpts) => Promise<TResult>
): Promise<TResult> {
	for (;;) {
		const existing = slots.get(key);
		if (existing && !existing.done) {
			if (!existing.trailing) {
				existing.trailing = { opts, waiters: [] };
			} else {
				existing.trailing.opts = merge(existing.trailing.opts, opts);
			}
			return new Promise<TResult>((resolve, reject) => {
				existing.trailing!.waiters.push({ resolve, reject });
			});
		}

		if (slots.has(key)) continue;
		const slot = createCoalesceSlot<TOpts, TResult>();
		slots.set(key, slot);

		let ownerResult!: TResult;
		let ownerError: unknown;
		let ownerFailed = false;
		let work: { opts: TOpts; waiters: CoalesceWaiter<TResult>[] | null } = {
			opts,
			waiters: null
		};

		try {
			for (;;) {
				try {
					const result = await fn(work.opts);
					if (work.waiters) {
						for (const w of work.waiters) w.resolve(result);
					} else {
						ownerResult = result;
					}
				} catch (e) {
					if (work.waiters) {
						for (const w of work.waiters) w.reject(e);
					} else {
						ownerFailed = true;
						ownerError = e;
					}
				}

				const trailing = slot.trailing;
				if (trailing) {
					slot.trailing = null;
					work = { opts: trailing.opts, waiters: trailing.waiters };
					continue;
				}

				slot.done = true;
				slots.delete(key);
				break;
			}
		} catch (e) {
			slot.done = true;
			if (slots.get(key) === slot) slots.delete(key);
			if (slot.trailing) {
				for (const w of slot.trailing.waiters) w.reject(e);
				slot.trailing = null;
			}
			slot.markIdle();
			throw e;
		}

		slot.markIdle();
		if (ownerFailed) throw ownerError;
		return ownerResult;
	}
}

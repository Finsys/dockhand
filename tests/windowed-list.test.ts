import { describe, test, expect } from 'bun:test';
import { windowOffsetFor, WindowedListCore, type WindowState } from '../src/lib/utils/windowed-list.svelte';

describe('windowOffsetFor', () => {
	test('centers the window on the target', () => {
		expect(windowOffsetFor(500, 400)).toBe(300); // 500 - 200
		expect(windowOffsetFor(1000, 100)).toBe(950); // 1000 - 50
	});
	test('clamps to 0 near the top', () => {
		expect(windowOffsetFor(0, 400)).toBe(0);
		expect(windowOffsetFor(50, 400)).toBe(0);
	});
	test('odd window sizes floor the half', () => {
		expect(windowOffsetFor(500, 401)).toBe(300);
	});
});

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe('WindowedListCore', () => {
	test('reset() fetches offset 0 at the window size and emits loaded state', async () => {
		const calls: { offset: number; limit: number }[] = [];
		let last: WindowState<number> | null = null;
		const core = new WindowedListCore<number>(
			{ windowSize: 400, fetchPage: async (offset, limit) => { calls.push({ offset, limit }); return { items: [1, 2], total: 2 }; } },
			(s) => (last = s)
		);
		await core.reset();
		expect(calls).toEqual([{ offset: 0, limit: 400 }]);
		expect(last!.items).toEqual([1, 2]);
		expect(last!.total).toBe(2);
		expect(last!.offset).toBe(0);
		expect(last!.loaded).toBe(true);
		expect(last!.loading).toBe(false);
	});

	test('shiftTo() centers the requested offset', async () => {
		const calls: number[] = [];
		const core = new WindowedListCore<number>(
			{ windowSize: 400, fetchPage: async (offset) => { calls.push(offset); return { items: [], total: 1000 }; } }
		);
		await core.shiftTo(600);
		expect(calls).toEqual([400]); // 600 - 200
	});

	test('sets loading=true while a fetch is in flight', async () => {
		const d = deferred<{ items: number[]; total: number }>();
		const states: boolean[] = [];
		const core = new WindowedListCore<number>(
			{ windowSize: 100, fetchPage: async () => d.promise },
			(s) => states.push(s.loading)
		);
		const p = core.reset();
		expect(states.at(-1)).toBe(true); // emitted loading=true synchronously
		d.resolve({ items: [1], total: 1 });
		await p;
		expect(states.at(-1)).toBe(false);
	});

	test('a superseded fetch is aborted and its late result is discarded', async () => {
		const first = deferred<{ items: number[]; total: number }>();
		const second = deferred<{ items: number[]; total: number }>();
		const signals: AbortSignal[] = [];
		let n = 0;
		let last: WindowState<number> | null = null;
		const core = new WindowedListCore<number>(
			{ windowSize: 100, fetchPage: async (_o, _l, signal) => { signals.push(signal); return n++ === 0 ? first.promise : second.promise; } },
			(s) => (last = s)
		);

		const p1 = core.shiftTo(0); // fetch #1
		const p2 = core.shiftTo(500); // supersedes #1

		expect(signals[0].aborted).toBe(true); // #1 aborted by #2
		expect(signals[1].aborted).toBe(false);

		first.resolve({ items: [1, 2, 3], total: 3 }); // stale — must be ignored
		second.resolve({ items: [9], total: 1000 });
		await Promise.all([p1, p2]);

		// Only the winning (second) result is applied.
		expect(last!.items).toEqual([9]);
		expect(last!.total).toBe(1000);
	});

	test('a repeat shiftTo to the same in-flight offset is deduped (fling guard)', async () => {
		const d = deferred<{ items: number[]; total: number }>();
		let fetchCount = 0;
		const core = new WindowedListCore<number>(
			{ windowSize: 400, fetchPage: async () => { fetchCount++; return d.promise; } }
		);
		const p1 = core.shiftTo(600); // desired offset 400
		const p2 = core.shiftTo(600); // same offset while #1 is loading → skipped
		expect(fetchCount).toBe(1);
		d.resolve({ items: [1], total: 1000 });
		await Promise.all([p1, p2]);
	});

	test('reset() forces a refetch even while an identical offset-0 fetch is in flight', async () => {
		// Regression: a filter/sort change maps to offset 0 like the in-flight load,
		// so the fling-dedupe used to drop it, leaving stale data. reset() must force.
		const first = deferred<{ items: number[]; total: number }>();
		const second = deferred<{ items: number[]; total: number }>();
		const signals: AbortSignal[] = [];
		let n = 0;
		let last: WindowState<number> | null = null;
		const core = new WindowedListCore<number>(
			{ windowSize: 400, fetchPage: async (_o, _l, s) => { signals.push(s); return n++ === 0 ? first.promise : second.promise; } },
			(s) => (last = s)
		);

		const p1 = core.reset(); // initial load, offset 0, in flight
		const p2 = core.reset(); // filter changed → same offset 0, must NOT be deduped
		expect(n).toBe(2); // second fetch actually started
		expect(signals[0].aborted).toBe(true); // first was aborted

		first.resolve({ items: [1, 2], total: 2 }); // stale — must be ignored
		second.resolve({ items: [9], total: 1 }); // new query result wins
		await Promise.all([p1, p2]);
		expect(last!.items).toEqual([9]);
		expect(last!.total).toBe(1);
	});

	test('a non-forced shiftTo to the same in-flight offset is still deduped (fling)', async () => {
		const d = deferred<{ items: number[]; total: number }>();
		let fetchCount = 0;
		const core = new WindowedListCore<number>(
			{ windowSize: 400, fetchPage: async () => { fetchCount++; return d.promise; } }
		);
		const p1 = core.shiftTo(600);
		const p2 = core.shiftTo(600); // same offset, not forced → deduped
		expect(fetchCount).toBe(1);
		d.resolve({ items: [1], total: 1000 });
		await Promise.all([p1, p2]);
	});

	test('shiftTo to a different offset still supersedes the in-flight fetch', async () => {
		const first = deferred<{ items: number[]; total: number }>();
		const second = deferred<{ items: number[]; total: number }>();
		let n = 0;
		const core = new WindowedListCore<number>(
			{ windowSize: 400, fetchPage: async () => (n++ === 0 ? first.promise : second.promise) }
		);
		const p1 = core.shiftTo(600); // offset 400
		const p2 = core.shiftTo(2000); // offset 1800 — different, must NOT be deduped
		expect(n).toBe(2);
		first.resolve({ items: [], total: 0 });
		second.resolve({ items: [], total: 0 });
		await Promise.all([p1, p2]);
	});

	test('fetchPage error is routed to onError, not thrown', async () => {
		let captured: unknown = null;
		const core = new WindowedListCore<number>(
			{ windowSize: 100, onError: (e) => (captured = e), fetchPage: async () => { throw new Error('boom'); } }
		);
		await core.reset();
		expect((captured as Error)?.message).toBe('boom');
	});

	test('AbortError is swallowed (not routed to onError)', async () => {
		let captured: unknown = null;
		const core = new WindowedListCore<number>(
			{ windowSize: 100, onError: (e) => (captured = e), fetchPage: async () => { const err = new Error('x'); err.name = 'AbortError'; throw err; } }
		);
		await core.reset();
		expect(captured).toBeNull();
	});

	test('clear() aborts in-flight and resets state', async () => {
		const d = deferred<{ items: number[]; total: number }>();
		const signals: AbortSignal[] = [];
		let last: WindowState<number> | null = null;
		const core = new WindowedListCore<number>(
			{ windowSize: 100, fetchPage: async (_o, _l, s) => { signals.push(s); return d.promise; } },
			(s) => (last = s)
		);
		const p = core.shiftTo(300);
		core.clear();
		expect(signals[0].aborted).toBe(true);
		expect(last!.items).toEqual([]);
		expect(last!.total).toBe(0);
		expect(last!.loading).toBe(false);
		d.resolve({ items: [1], total: 1 }); // late resolve must not reapply
		await p;
		expect(last!.items).toEqual([]);
	});
});

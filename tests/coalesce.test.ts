import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCoalesced, type CoalesceSlot } from '../src/lib/server/coalesce';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeSlots(): Map<number, CoalesceSlot<unknown, unknown>> {
	return new Map();
}

describe('runCoalesced', () => {
	it('runs a single call through to completion', async () => {
		const slots = makeSlots();
		const result = await runCoalesced(slots, 1, { force: false }, (a, b) => b, async () => 'done');

		assert.equal(result, 'done');
		assert.equal(slots.size, 0);
	});

	it('serializes concurrent calls into one in-flight and one trailing run', async () => {
		const slots = makeSlots();
		const first = deferred<void>();
		const calls: unknown[] = [];

		const p1 = runCoalesced(slots, 1, 'first', (a, b) => a + '+' + b, async (opts) => {
			calls.push(opts);
			await first.promise;
			return opts;
		});
		// Let the first call take ownership of the slot.
		await new Promise((r) => setTimeout(r, 10));
		const p2 = runCoalesced(slots, 1, 'second', (a, b) => a + '+' + b, async (opts) => {
			calls.push(opts);
			return opts;
		});
		const p3 = runCoalesced(slots, 1, 'third', (a, b) => a + '+' + b, async (opts) => {
			calls.push(opts);
			return opts;
		});
		// Let the trailing calls register while the owner is still in flight.
		await new Promise((r) => setTimeout(r, 10));
		first.resolve();
		first.promise; // owner continues

		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

		// First call: the owner result. Second + third merged into a single
		// trailing run: second+'third' = "second+third".
		assert.equal(r1, 'first');
		assert.equal(r2, 'second+third');
		assert.equal(r3, 'second+third');
		assert.deepEqual(calls, ['first', 'second+third']);
		assert.equal(slots.size, 0);
	});

	it('runs calls for different keys concurrently', async () => {
		const slots = makeSlots();
		const a = deferred<void>();
		const b = deferred<void>();
		let aRuns = 0;
		let bRuns = 0;

		const p1 = runCoalesced(slots, 1, null, (a, b) => b, async () => {
			aRuns++;
			await a.promise;
			return 'a';
		});
		const p2 = runCoalesced(slots, 2, null, (a, b) => b, async () => {
			bRuns++;
			await b.promise;
			return 'b';
		});
		await new Promise((r) => setTimeout(r, 10));
		a.resolve();
		b.resolve();

		const [r1, r2] = await Promise.all([p1, p2]);
		assert.equal(r1, 'a');
		assert.equal(r2, 'b');
		assert.equal(aRuns, 1);
		assert.equal(bRuns, 1);
	});

	it('propagates owner failures and rejects trailing waiters', async () => {
		const slots = makeSlots();
		const first = deferred<void>();
		const error = new Error('boom');

		const p1 = runCoalesced(slots, 1, null, (a, b) => b, async () => {
			await first.promise;
			throw error;
		});
		await new Promise((r) => setTimeout(r, 10));
		const p2 = runCoalesced(slots, 1, null, (a, b) => b, async () => 'unused');
		await new Promise((r) => setTimeout(r, 10));
		first.resolve();

		await assert.rejects(p1, error);
		await assert.rejects(p2, error);
		assert.equal(slots.size, 0);
	});
});

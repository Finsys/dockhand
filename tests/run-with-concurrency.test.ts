import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWithConcurrency } from '../src/lib/server/run-with-concurrency';

describe('runWithConcurrency', () => {
	it('runs all tasks and preserves input order', async () => {
		const results = await runWithConcurrency(2, [1, 2, 3, 4, 5].map((n) => async () => n * 10));
		assert.deepEqual(results, [10, 20, 30, 40, 50]);
	});

	it('never exceeds the concurrency limit', async () => {
		let active = 0;
		let peak = 0;
		await runWithConcurrency(3, Array.from({ length: 9 }, () => async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		}));
		assert.equal(peak, 3);
	});

	it('handles an empty task list', async () => {
		assert.deepEqual(await runWithConcurrency(4, []), []);
	});

	it('handles a limit larger than the task count', async () => {
		const results = await runWithConcurrency(10, [1, 2].map((n) => async () => n));
		assert.deepEqual(results, [1, 2]);
	});

	it('propagates task errors', async () => {
		await assert.rejects(
			runWithConcurrency(2, [
				async () => 1,
				async () => { throw new Error('boom'); }
			]),
			/boom/
		);
	});
});

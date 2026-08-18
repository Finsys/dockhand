import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Semaphore } from '../src/lib/server/semaphore';

describe('Semaphore', () => {
	it('never runs more than the limit concurrently', async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;
		await Promise.all(Array.from({ length: 6 }, () => sem.run(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		})));
		assert.equal(peak, 2);
		assert.equal(active, 0);
	});

	it('tryRun returns null at capacity and runs when free', async () => {
		const sem = new Semaphore(1);
		const first = sem.tryRun(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		assert.ok(first, 'first acquire succeeds');
		assert.equal(sem.tryRun(async () => {}), null, 'second acquire refuses');
		await first;
		const third = sem.tryRun(async () => 'ok');
		assert.equal(await third, 'ok');
	});

	it('propagates fn errors and releases the slot', async () => {
		const sem = new Semaphore(1);
		await assert.rejects(sem.run(async () => { throw new Error('boom'); }), /boom/);
		assert.equal(await sem.run(async () => 'free'), 'free');
	});
});

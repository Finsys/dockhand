import { describe, expect, test } from 'bun:test';
import { KeyedSerializer, QueueTimeoutError } from '../src/lib/server/keyed-serializer';

/**
 * Operations that share a resource must not overlap.
 *
 * The case this exists for: pass-cli keeps one session per user, so a stack
 * editor probe and a deploy logging in at the same moment make one of them wait
 * out its whole login timeout and fail.
 */

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('one at a time per key', () => {
	test('a second caller waits for the first to finish', async () => {
		const s = new KeyedSerializer();
		let live = 0;
		let peak = 0;
		const op = async () => {
			live++;
			peak = Math.max(peak, live);
			await tick(20);
			live--;
		};
		await Promise.all([s.run('cli', op), s.run('cli', op), s.run('cli', op)]);
		expect(peak).toBe(1);
	});

	test('different keys do not block each other', async () => {
		const s = new KeyedSerializer();
		let live = 0;
		let peak = 0;
		const op = async () => {
			live++;
			peak = Math.max(peak, live);
			await tick(20);
			live--;
		};
		await Promise.all([s.run('a', op), s.run('b', op)]);
		expect(peak).toBe(2);
	});

	test('turns are taken in arrival order', async () => {
		const s = new KeyedSerializer();
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3].map((n) => s.run('cli', async () => { order.push(n); await tick(5); }))
		);
		expect(order).toEqual([1, 2, 3]);
	});
});

describe('a failing operation', () => {
	test('rejects its own caller only', async () => {
		const s = new KeyedSerializer();
		const boom = s.run('cli', async () => { throw new Error('boom'); });
		expect(boom).rejects.toThrow('boom');
		// The queue must keep moving: a failure that poisoned the chain would take
		// every later operation on that key down with it.
		expect(await s.run('cli', async () => 'ok')).toBe('ok');
	});

	test('does not stop the next caller from starting', async () => {
		const s = new KeyedSerializer();
		const seen: string[] = [];
		const a = s.run('cli', async () => { seen.push('a'); throw new Error('x'); });
		const b = s.run('cli', async () => { seen.push('b'); return 1; });
		await a.catch(() => undefined);
		await b;
		expect(seen).toEqual(['a', 'b']);
	});
});

describe('the result', () => {
	test('each caller gets its own return value', async () => {
		const s = new KeyedSerializer();
		const out = await Promise.all([
			s.run('cli', async () => 'first'),
			s.run('cli', async () => 'second')
		]);
		expect(out).toEqual(['first', 'second']);
	});

});

describe('giving up on the wait', () => {
	test('a caller that waits too long is rejected, not left hanging', async () => {
		const s = new KeyedSerializer();
		const holding = s.run('cli', () => tick(300));
		const waiting = s.run('cli', async () => 'never runs', 50);
		expect(waiting).rejects.toThrow(QueueTimeoutError);
		await holding;
	});

	test('the operation itself is never cut short by the wait limit', async () => {
		// The limit bounds the QUEUE, not the work: a long turn that aborted itself
		// would break every slow-but-legitimate operation.
		const s = new KeyedSerializer();
		const out = await s.run('cli', async () => { await tick(120); return 'finished'; }, 20);
		expect(out).toBe('finished');
	});

	test('an abandoned wait does not stall the queue', async () => {
		const s = new KeyedSerializer();
		const holding = s.run('cli', () => tick(200));
		await s.run('cli', async () => 'gone', 20).catch(() => undefined);
		await holding;
		expect(await s.run('cli', async () => 'still working')).toBe('still working');
	});

	test('an abandoned turn never runs its operation', async () => {
		// Skipping the work matters: for pass-cli it would mean a second login
		// against a binary the caller already stopped waiting for.
		const s = new KeyedSerializer();
		let ran = false;
		const holding = s.run('cli', () => tick(200));
		await s.run('cli', async () => { ran = true; }, 20).catch(() => undefined);
		await holding;
		await tick(50);
		expect(ran).toBe(false);
	});

	test('no limit means wait as long as it takes', async () => {
		const s = new KeyedSerializer();
		const holding = s.run('cli', () => tick(100));
		expect(await s.run('cli', async () => 'patient')).toBe('patient');
		await holding;
	});
});

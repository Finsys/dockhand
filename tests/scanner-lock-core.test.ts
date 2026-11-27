import { describe, test, expect } from 'bun:test';
import { createScannerLock } from '../src/lib/server/scanner-lock-core';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` N times concurrently through the lock and report the peak concurrency. */
async function peakConcurrency(n: number, type = 'trivy'): Promise<number> {
	const lock = createScannerLock();
	let active = 0;
	let peak = 0;
	const fn = async () => {
		active++;
		peak = Math.max(peak, active);
		await delay(15);
		active--;
	};
	await Promise.all(Array.from({ length: n }, () => lock.run(type, fn)));
	return peak;
}

describe('createScannerLock - strict serialization', () => {
	test('two queued callers never overlap', async () => {
		expect(await peakConcurrency(2)).toBe(1);
	});

	// With 3 callers a read-once lock would cap concurrency at 2 (N-1); this asserts
	// strict serialization (peak 1).
	test('three queued callers still run strictly one at a time', async () => {
		expect(await peakConcurrency(3)).toBe(1);
	});

	test('ten queued callers still run strictly one at a time', async () => {
		expect(await peakConcurrency(10)).toBe(1);
	});
});

describe('createScannerLock - failure isolation', () => {
	test('a caller sees its own rejection', async () => {
		const lock = createScannerLock();
		await expect(
			lock.run('trivy', async () => {
				throw new Error('scan boom');
			})
		).rejects.toThrow('scan boom');
	});

	test('a failed run does not block or fail the runs queued behind it', async () => {
		const lock = createScannerLock();
		const order: string[] = [];
		const results = await Promise.allSettled([
			lock.run('trivy', async () => {
				await delay(10);
				order.push('a');
				throw new Error('a failed');
			}),
			lock.run('trivy', async () => {
				await delay(10);
				order.push('b');
				return 'b-ok';
			}),
			lock.run('trivy', async () => {
				await delay(10);
				order.push('c');
				return 'c-ok';
			})
		]);
		expect(results[0].status).toBe('rejected');
		expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'b-ok' });
		expect(results[2]).toMatchObject({ status: 'fulfilled', value: 'c-ok' });
		// serialized in submission order despite the first one throwing
		expect(order).toEqual(['a', 'b', 'c']);
	});
});

describe('createScannerLock - independent types', () => {
	test('different scanner types are not serialized against each other', async () => {
		const lock = createScannerLock();
		let active = 0;
		let peak = 0;
		const fn = async () => {
			active++;
			peak = Math.max(peak, active);
			await delay(15);
			active--;
		};
		await Promise.all([lock.run('trivy', fn), lock.run('grype', fn)]);
		expect(peak).toBe(2);
	});
});

describe('createScannerLock - activeTypes accounting', () => {
	test('zero when idle, counts a running type, returns to zero after it drains', async () => {
		const lock = createScannerLock();
		expect(lock.activeTypes()).toBe(0);

		const p = lock.run('trivy', () => delay(20));
		expect(lock.activeTypes()).toBe(1);

		await p;
		// allow the tail's cleanup .then to run
		await delay(0);
		expect(lock.activeTypes()).toBe(0);
	});

	test('one type stays counted once while several runs are queued on it', async () => {
		const lock = createScannerLock();
		const runs = [
			lock.run('trivy', () => delay(20)),
			lock.run('trivy', () => delay(20)),
			lock.run('trivy', () => delay(20))
		];
		expect(lock.activeTypes()).toBe(1);
		await Promise.all(runs);
		await delay(0);
		expect(lock.activeTypes()).toBe(0);
	});
});

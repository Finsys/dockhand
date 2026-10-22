import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { cancelReaderOnAbort } from '../src/lib/server/reader-abort-core';
import { toWebReadableStream } from '../src/lib/server/node-readable-stream';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function collectUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
	const seen: unknown[] = [];
	const onRejection = (err: unknown) => seen.push(err);
	process.on('unhandledRejection', onRejection);
	try {
		await fn();
		await tick();
	} finally {
		process.off('unhandledRejection', onRejection);
	}
	return seen;
}

describe('cancelReaderOnAbort', () => {
	test('cancels the reader when the signal aborts', async () => {
		let cancelled = 0;
		const ac = new AbortController();
		cancelReaderOnAbort({ cancel: async () => { cancelled++; } }, ac.signal);
		expect(cancelled).toBe(0);
		ac.abort();
		ac.abort();
		expect(cancelled).toBe(1);
	});

	test('swallows a rejected cancel() instead of leaving it unhandled', async () => {
		const unhandled = await collectUnhandled(async () => {
			const ac = new AbortController();
			cancelReaderOnAbort({ cancel: () => Promise.reject(new Error('aborted')) }, ac.signal);
			ac.abort();
		});
		expect(unhandled).toEqual([]);
	});

	test('abort after the underlying stream errored does not throw', async () => {
		const unhandled = await collectUnhandled(async () => {
			const src = new PassThrough();
			const reader = toWebReadableStream(src).getReader();
			const ac = new AbortController();
			cancelReaderOnAbort(reader, ac.signal);

			src.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
			await expect(reader.read()).rejects.toThrow('aborted');

			ac.abort();
		});
		expect(unhandled).toEqual([]);
	});

	test('no signal is a no-op', () => {
		expect(() => cancelReaderOnAbort({ cancel: async () => {} }, undefined)).not.toThrow();
	});
});

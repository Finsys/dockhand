import { describe, test, expect } from 'bun:test';
import { pumpWebStreamToWritable, type BackpressureWritable, type ChunkReader } from '../src/lib/server/stream-pump';

// A reader over a fixed list of chunks.
function readerOf(chunks: Uint8Array[]): ChunkReader {
	let i = 0;
	return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
}

// A writable whose write() returns false after `bufferLimit` bytes are "in flight" and only
// drains when we manually fire it — this models a slow socket applying backpressure.
function makeSlowWritable(bufferLimit: number) {
	const rec = { written: [] as number[], ended: false, destroyed: null as Error | null, drainWaiters: [] as (() => void)[], inFlight: 0 };
	const w: BackpressureWritable = {
		write(chunk) {
			rec.written.push(chunk.length);
			rec.inFlight += chunk.length;
			// Return false (backpressure) once the buffer is over the limit.
			return rec.inFlight < bufferLimit;
		},
		end() { rec.ended = true; },
		destroy(err) { rec.destroyed = err ?? new Error('destroyed'); },
		once(_event, cb) { rec.drainWaiters.push(cb); },
	};
	// Test helper: drain the buffer and wake one waiter.
	const drain = () => { rec.inFlight = 0; const cb = rec.drainWaiters.shift(); if (cb) cb(); };
	return { w, rec, drain };
}

describe('pumpWebStreamToWritable - backpressure', () => {
	test('writes all chunks and calls end() when the sink never backpressures', async () => {
		const { w, rec } = makeSlowWritable(Number.MAX_SAFE_INTEGER); // write() always returns true
		await pumpWebStreamToWritable(readerOf([new Uint8Array(10), new Uint8Array(20)]), w);
		expect(rec.written).toEqual([10, 20]);
		expect(rec.ended).toBe(true);
		expect(rec.destroyed).toBeNull();
	});

	test('STOPS reading and awaits drain when write() signals backpressure', async () => {
		const { w, rec, drain } = makeSlowWritable(15); // buffer fills after ~15 bytes
		const chunks = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)];
		const done = pumpWebStreamToWritable(readerOf(chunks), w);

		// After the first 10-byte write, inFlight=10 < 15 -> no backpressure, second write runs;
		// after the second write inFlight=20 >= 15 -> write() returned false -> pump must PAUSE
		// waiting for drain, NOT write the third chunk yet.
		await new Promise((r) => setTimeout(r, 10));
		expect(rec.written).toEqual([10, 10]);         // third chunk NOT written yet
		expect(rec.drainWaiters.length).toBe(1);       // pump is parked on drain
		expect(rec.ended).toBe(false);

		drain();                                        // socket flushed -> resume
		await done;
		expect(rec.written).toEqual([10, 10, 10]);      // now all three written
		expect(rec.ended).toBe(true);
	});

	test('destroys the writable and rethrows if the reader errors mid-stream', async () => {
		const { w, rec } = makeSlowWritable(Number.MAX_SAFE_INTEGER);
		let n = 0;
		const badReader: ChunkReader = {
			read: async () => { if (n++ === 0) return { done: false, value: new Uint8Array(5) }; throw new Error('read blew up'); },
		};
		await expect(pumpWebStreamToWritable(badReader, w)).rejects.toThrow('read blew up');
		expect(rec.destroyed).not.toBeNull();
		expect(rec.ended).toBe(false);
	});
});

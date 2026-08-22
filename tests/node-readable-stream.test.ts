import { describe, expect, test } from 'bun:test';
import { PassThrough, Readable } from 'node:stream';
import { toWebReadableStream } from '../src/lib/server/node-readable-stream';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('toWebReadableStream', () => {
	test('keeps a fast producer bounded behind a slow consumer', async () => {
		const totalChunks = 128;
		const chunkSize = 64 * 1024;
		let produced = 0;

		const source = new Readable({
			highWaterMark: 16 * 1024,
			read() {
				if (produced >= totalChunks) {
					this.push(null);
					return;
				}

				produced++;
				setImmediate(() => {
					if (!this.destroyed) this.push(Buffer.alloc(chunkSize));
				});
			}
		});

		const reader = toWebReadableStream(source).getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		expect(first.value?.byteLength).toBe(chunkSize);

		await delay(50);
		expect(produced).toBeLessThanOrEqual(4);

		let receivedBytes = first.value?.byteLength ?? 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
		}

		expect(produced).toBe(totalChunks);
		expect(receivedBytes).toBe(totalChunks * chunkSize);
	});

	test('destroys the Node stream when the Web reader is cancelled', async () => {
		const source = new PassThrough();
		const reader = toWebReadableStream(source).getReader();
		source.write(Buffer.from('chunk'));
		await reader.read();

		let cancelError: Error | undefined;
		source.once('error', (error) => {
			cancelError = error;
		});
		const closed = new Promise<void>((resolve) => source.once('close', resolve));

		await reader.cancel(new Error('cancelled'));
		await closed;

		expect(source.destroyed).toBe(true);
		expect(cancelError?.message).toBe('cancelled');
	});

	test('forwards Node stream errors to the Web reader', async () => {
		const source = new PassThrough();
		const reader = toWebReadableStream(source).getReader();
		const pendingRead = reader.read();

		source.destroy(new Error('source failed'));

		await expect(pendingRead).rejects.toThrow('source failed');
	});
});

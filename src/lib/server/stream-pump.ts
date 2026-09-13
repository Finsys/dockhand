/**
 * Pump a web ReadableStream into a node Writable (an http/https request) WITH backpressure.
 * Import-light (no server deps) so it's unit-testable.
 *
 * The bug this guards against: a naive `while (read()) req.write(value)` ignores write()'s
 * return value. write() returns false when the socket send-buffer is full; without awaiting
 * 'drain' before the next read, a fast disk source feeding a slow (mTLS) peer piles the WHOLE
 * payload into RAM (O(n) - measured 500MB -> +564MB RSS). Awaiting 'drain' bounds RAM to the
 * socket high-water mark (O(1), +5MB), matching what node's .pipe() does for free on the
 * socket/plain-http path.
 */

/** Minimal writable surface we depend on (http.ClientRequest satisfies this). */
export interface BackpressureWritable {
	write(chunk: Uint8Array): boolean;
	end(): void;
	destroy(err?: Error): void;
	once(event: 'drain', cb: () => void): void;
}

/** Minimal reader surface (a ReadableStreamDefaultReader satisfies this). */
export interface ChunkReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Await a single 'drain' from the writable. */
function waitDrain(w: BackpressureWritable): Promise<void> {
	return new Promise((resolve) => w.once('drain', resolve));
}

/**
 * Read every chunk and write it, awaiting 'drain' whenever write() signals backpressure.
 * Calls `end()` on completion. On any error, `destroy(err)` is called and the error rethrown.
 */
export async function pumpWebStreamToWritable(reader: ChunkReader, w: BackpressureWritable): Promise<void> {
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			if (!w.write(value)) await waitDrain(w);
		}
		w.end();
	} catch (err) {
		w.destroy(err as Error);
		throw err;
	}
}

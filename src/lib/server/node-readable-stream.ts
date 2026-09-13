import { Readable } from 'node:stream';

/**
 * Convert a Node readable to a Web stream while preserving Node backpressure.
 * Cancellation and source errors are forwarded by Node's native adapter.
 */
export function toWebReadableStream(source: Readable): ReadableStream<Uint8Array> {
	return Readable.toWeb(source) as ReadableStream<Uint8Array>;
}

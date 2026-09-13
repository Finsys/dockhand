/**
 * Pure Docker hijacked-stream decoding for the terminal WebSocket handlers.
 *
 * `docker exec` with a TTY returns a RAW byte stream, but `docker attach` to a
 * container started WITHOUT a tty returns a MULTIPLEXED stream: each frame is an
 * 8-byte header (stream type in byte 0, 32-bit big-endian payload size in bytes
 * 4-7) followed by the payload. The daemon may also chunk the HTTP body. This
 * module strips the HTTP response headers, decodes chunked transfer-encoding, and
 * demultiplexes the frames into plain output strings.
 *
 * No imports / no I/O so it is unit-testable in the bun runner and shared by BOTH
 * WebSocket servers (server.js in production, vite.config.ts in dev) instead of
 * being duplicated in each.
 */

export interface DockerStreamState {
	headersStripped: boolean;
	isChunked: boolean;
	headerBuffer: Buffer;
	chunkBuffer: Buffer;
	chunkSize: number | null;
	chunkEnded: boolean;
	multiplexed: boolean;
	streamBuffer: Buffer;
}

export function createDockerStreamState(multiplexed = false): DockerStreamState {
	return {
		headersStripped: false,
		isChunked: false,
		headerBuffer: Buffer.alloc(0),
		chunkBuffer: Buffer.alloc(0),
		chunkSize: null,
		chunkEnded: false,
		multiplexed,
		streamBuffer: Buffer.alloc(0)
	};
}

/** Decode HTTP chunked transfer-encoding into raw body buffers. */
export function decodeChunkedDockerBody(data: Buffer, state: DockerStreamState): Buffer[] {
	state.chunkBuffer = Buffer.concat([state.chunkBuffer, data]);
	const chunks: Buffer[] = [];

	while (!state.chunkEnded) {
		if (state.chunkSize === null) {
			const lineEnd = state.chunkBuffer.indexOf('\r\n');
			if (lineEnd < 0) break;

			const sizeText = state.chunkBuffer.slice(0, lineEnd).toString('ascii').split(';', 1)[0];
			const size = parseInt(sizeText, 16);
			if (!Number.isFinite(size) || size < 0) {
				// Malformed size line: surface what we have and stop parsing this body.
				state.chunkEnded = true;
				chunks.push(state.chunkBuffer);
				state.chunkBuffer = Buffer.alloc(0);
				break;
			}

			state.chunkBuffer = state.chunkBuffer.slice(lineEnd + 2);
			state.chunkSize = size;
			if (size === 0) {
				state.chunkEnded = true;
				state.chunkBuffer = Buffer.alloc(0);
				break;
			}
		}

		if (state.chunkBuffer.length < state.chunkSize + 2) break;
		chunks.push(state.chunkBuffer.slice(0, state.chunkSize));
		state.chunkBuffer = state.chunkBuffer.slice(state.chunkSize + 2);
		state.chunkSize = null;
	}

	return chunks;
}

/**
 * Feed one raw socket chunk through the decoder and return zero or more decoded
 * output strings. Strips HTTP headers on the first call, decodes chunked bodies,
 * and demultiplexes 8-byte-framed output; a non-multiplexed (TTY) stream passes
 * through unchanged. Falls back to raw if the framing looks wrong (a proxy that
 * didn't preserve it).
 */
export function processDockerStreamChunk(data: Buffer | Uint8Array | string, state: DockerStreamState): string[] {
	let buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
	if (!state.headersStripped) {
		state.headerBuffer = Buffer.concat([state.headerBuffer, buffer]);
		const headerEnd = state.headerBuffer.indexOf('\r\n\r\n');
		if (headerEnd < 0) return [];

		const headers = state.headerBuffer.slice(0, headerEnd).toString('ascii').toLowerCase();
		state.isChunked = headers.includes('transfer-encoding: chunked');
		buffer = state.headerBuffer.slice(headerEnd + 4);
		state.headerBuffer = Buffer.alloc(0);
		state.headersStripped = true;
	}

	const bodyChunks = state.isChunked ? decodeChunkedDockerBody(buffer, state) : [buffer];
	const output: string[] = [];
	for (const body of bodyChunks) {
		if (!body.length) continue;
		if (!state.multiplexed) {
			output.push(body.toString('utf-8'));
			continue;
		}

		state.streamBuffer = Buffer.concat([state.streamBuffer, body]);
		while (state.streamBuffer.length > 0) {
			if (state.streamBuffer.length < 8) break;

			const streamType = state.streamBuffer.readUInt8(0);
			const frameSize = state.streamBuffer.readUInt32BE(4);
			if (
				streamType > 2 ||
				state.streamBuffer[1] !== 0 ||
				state.streamBuffer[2] !== 0 ||
				state.streamBuffer[3] !== 0 ||
				frameSize > 10 * 1024 * 1024
			) {
				// TTY output is normally raw. Fall back to raw output if a Docker
				// proxy did not preserve the expected multiplexed framing.
				output.push(state.streamBuffer.toString('utf-8'));
				state.streamBuffer = Buffer.alloc(0);
				state.multiplexed = false;
				break;
			}

			if (state.streamBuffer.length < 8 + frameSize) break;
			if (streamType === 1 || streamType === 2) {
				output.push(state.streamBuffer.slice(8, 8 + frameSize).toString('utf-8'));
			}
			state.streamBuffer = state.streamBuffer.slice(8 + frameSize);
		}
	}

	return output;
}

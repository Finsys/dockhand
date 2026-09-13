// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import {
	createDockerStreamState,
	decodeChunkedDockerBody,
	processDockerStreamChunk
} from '../src/lib/server/docker-stream-core';

const HTTP_HEAD = 'HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n';
const HTTP_HEAD_CHUNKED = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n';

/** Build one 8-byte-framed multiplexed frame: type 1=stdout, 2=stderr. */
function frame(type: number, payload: string): Buffer {
	const body = Buffer.from(payload, 'utf-8');
	const header = Buffer.alloc(8);
	header.writeUInt8(type, 0);
	header.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, body]);
}

describe('processDockerStreamChunk - raw (TTY) stream', () => {
	test('passes raw body through once HTTP headers are stripped', () => {
		const st = createDockerStreamState(false);
		const out = processDockerStreamChunk(Buffer.from(HTTP_HEAD + 'hello world'), st);
		expect(out.join('')).toBe('hello world');
	});

	test('buffers until the full HTTP header terminator arrives', () => {
		const st = createDockerStreamState(false);
		// header split across two socket events - nothing emitted until \r\n\r\n seen
		expect(processDockerStreamChunk(Buffer.from('HTTP/1.1 200 OK\r\n'), st)).toEqual([]);
		const out = processDockerStreamChunk(Buffer.from('\r\nlate'), st);
		expect(out.join('')).toBe('late');
	});
});

describe('processDockerStreamChunk - multiplexed (non-TTY attach) stream', () => {
	test('demuxes stdout and stderr frames', () => {
		const st = createDockerStreamState(true);
		const data = Buffer.concat([Buffer.from(HTTP_HEAD), frame(1, 'out '), frame(2, 'err')]);
		expect(processDockerStreamChunk(data, st).join('')).toBe('out err');
	});

	test('reassembles a frame split across two socket events', () => {
		const st = createDockerStreamState(true);
		const f = frame(1, 'hello');
		// deliver the header + first 2 payload bytes, then the rest
		const first = Buffer.concat([Buffer.from(HTTP_HEAD), f.slice(0, 8 + 2)]);
		const second = f.slice(8 + 2);
		expect(processDockerStreamChunk(first, st)).toEqual([]); // incomplete frame -> nothing yet
		expect(processDockerStreamChunk(second, st).join('')).toBe('hello');
	});

	test('reassembles a frame whose 8-byte header itself is split', () => {
		const st = createDockerStreamState(true);
		const f = frame(2, 'x');
		const first = Buffer.concat([Buffer.from(HTTP_HEAD), f.slice(0, 4)]); // half the header
		const second = f.slice(4);
		expect(processDockerStreamChunk(first, st)).toEqual([]);
		expect(processDockerStreamChunk(second, st).join('')).toBe('x');
	});

	test('falls back to raw when the framing is not valid multiplexed (proxy stripped it)', () => {
		const st = createDockerStreamState(true);
		// a byte-0 stream type of 5 is invalid -> raw fallback, and stays raw after
		const bogus = Buffer.concat([Buffer.from(HTTP_HEAD), Buffer.from([5, 0, 0, 0, 0, 0, 0, 1]), Buffer.from('raw')]);
		const out = processDockerStreamChunk(bogus, st);
		expect(out.join('')).toContain('raw');
		expect(st.multiplexed).toBe(false);
		// subsequent bytes now pass through raw
		expect(processDockerStreamChunk(Buffer.from('more'), st).join('')).toBe('more');
	});
});

describe('decodeChunkedDockerBody', () => {
	test('decodes a chunked body and drops the framing', () => {
		const st = createDockerStreamState(false);
		// header says chunked; body: "5\r\nhello\r\n"
		const out = processDockerStreamChunk(Buffer.from(HTTP_HEAD_CHUNKED + '5\r\nhello\r\n'), st);
		expect(out.join('')).toBe('hello');
	});

	test('reassembles a chunk whose data is split across two events', () => {
		const st = createDockerStreamState(false);
		processDockerStreamChunk(Buffer.from(HTTP_HEAD_CHUNKED + '5\r\nhel'), st);
		const out = processDockerStreamChunk(Buffer.from('lo\r\n'), st);
		expect(out.join('')).toBe('hello');
	});

	test('the 0-size terminating chunk ends the body', () => {
		const st = createDockerStreamState(false);
		st.headersStripped = true;
		st.isChunked = true;
		const out = decodeChunkedDockerBody(Buffer.from('3\r\nabc\r\n0\r\n\r\n'), st);
		expect(Buffer.concat(out).toString()).toBe('abc');
		expect(st.chunkEnded).toBe(true);
	});
});

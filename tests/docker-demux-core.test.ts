import { describe, test, expect } from 'bun:test';
import { demuxDockerStream } from '../src/lib/server/docker-demux-core';

// Build a Docker multiplexed frame: 8-byte header (type, 3 zero bytes, BE32 size) + payload.
function frame(type: number, text: string): Buffer {
	const payload = Buffer.from(text, 'utf-8');
	const header = Buffer.alloc(8);
	header.writeUInt8(type, 0);
	header.writeUInt32BE(payload.length, 4);
	return Buffer.concat([header, payload]);
}

describe('demuxDockerStream', () => {
	test('separates stdout (type 1) from stderr (type 2)', () => {
		const buf = Buffer.concat([frame(1, 'out-a'), frame(2, 'err-x'), frame(1, 'out-b')]);
		const res = demuxDockerStream(buf, { separateStreams: true }) as { stdout: string; stderr: string };
		expect(res.stdout).toBe('out-aout-b');
		expect(res.stderr).toBe('err-x');
	});

	test('without separateStreams concatenates stdout first, then stderr', () => {
		const buf = Buffer.concat([frame(2, 'E'), frame(1, 'O')]);
		expect(demuxDockerStream(buf)).toBe('OE');
	});

	test('unknown stream type defaults to stdout', () => {
		const buf = frame(9, 'weird');
		const res = demuxDockerStream(buf, { separateStreams: true }) as { stdout: string; stderr: string };
		expect(res.stdout).toBe('weird');
		expect(res.stderr).toBe('');
	});

	test('a multi-byte UTF-8 char whole within one frame decodes correctly', () => {
		// The common case: the daemon does not split a character mid-frame.
		const res = demuxDockerStream(frame(1, 'café €'), { separateStreams: true }) as {
			stdout: string;
			stderr: string;
		};
		expect(res.stdout).toBe('café €');
	});

	test('an invalid/oversized frame falls back to control-stripped raw text', () => {
		// Header claims a huge frame size that overruns the buffer.
		const head = Buffer.alloc(8);
		head.writeUInt8(1, 0);
		head.writeUInt32BE(9999, 4);
		const buf = Buffer.concat([head, Buffer.from('short', 'utf-8')]);
		const res = demuxDockerStream(buf, { separateStreams: true }) as { stdout: string; stderr: string };
		expect(res.stdout).toContain('short');
		expect(res.stderr).toBe('');
	});

	test('empty buffer yields empty streams', () => {
		const res = demuxDockerStream(Buffer.alloc(0), { separateStreams: true }) as { stdout: string; stderr: string };
		expect(res).toEqual({ stdout: '', stderr: '' });
	});
});

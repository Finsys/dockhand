import { describe, test, expect } from 'bun:test';
import { parseLines, parseSnapshot } from '../src/lib/utils/log-entry';

// A logs snapshot from GET /api/containers/:id/logs (Docker timestamps, trailing newline).
const SNAPSHOT = '2026-08-20T05:52:23.440653630Z TLS material already present in /tls\n2026-08-20T05:52:24.000000001Z second line\n';

describe('parseLines', () => {
	test('a snapshot parsed without a carryover keeps every timestamp and adds no prefix', () => {
		const { entries, carryover } = parseLines(SNAPSHOT);
		expect(entries.map((e) => [e.timestamp, e.text])).toEqual([
			['2026-08-20T05:52:23.440653630Z', 'TLS material already present in /tls'],
			['2026-08-20T05:52:24.000000001Z', 'second line']
		]);
		expect(carryover).toBe('');
	});

	test('a partial line is carried into the next chunk', () => {
		const first = parseLines('2026-08-20T05:52:23Z start of a li', '');
		expect(first.entries).toEqual([]);
		const second = parseLines('ne\n', first.carryover);
		expect(second.entries.map((e) => [e.timestamp, e.text])).toEqual([['2026-08-20T05:52:23Z', 'start of a line']]);
	});
});

describe('parseSnapshot', () => {
	// Measured on Docker 29.8: a process that exits mid-line (printf without \n) leaves the
	// last line of GET /containers/:id/logs without a trailing newline.
	test('keeps a last line that has no trailing newline', () => {
		const entries = parseSnapshot('2026-11-13T12:01:25.300000000Z a\n2026-11-13T12:01:25.311825453Z no-newline-exit');
		expect(entries.map((e) => [e.timestamp, e.text])).toEqual([
			['2026-11-13T12:01:25.300000000Z', 'a'],
			['2026-11-13T12:01:25.311825453Z', 'no-newline-exit']
		]);
	});

	test('a snapshot ending in a newline gets no empty extra line', () => {
		expect(parseSnapshot(SNAPSHOT).map((e) => e.text)).toEqual(['TLS material already present in /tls', 'second line']);
		expect(parseSnapshot('')).toEqual([]);
	});

	test('a whitespace or bare carriage-return last line is kept like the same line mid-snapshot', () => {
		expect(parseSnapshot('a\n ').map((e) => e.text)).toEqual(['a', ' ']);
		expect(parseSnapshot('a\r\n\r').map((e) => e.text)).toEqual(['a\r', '\r']);
		expect(parseLines(' \na\n', '').entries.map((e) => e.text)).toEqual([' ', 'a']);
	});

	test('the grouped view fields reach every entry, the last unterminated line too', () => {
		const extra = { containerId: 'c1', containerName: 'web', color: '#f00' };
		const entries = parseSnapshot('2026-11-13T12:00:00Z one\n2026-11-13T12:00:01Z two', extra);
		expect(entries.map((e) => [e.containerId, e.containerName, e.color])).toEqual([
			['c1', 'web', '#f00'],
			['c1', 'web', '#f00']
		]);
	});
});

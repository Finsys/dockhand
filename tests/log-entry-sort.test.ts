import { describe, test, expect } from 'bun:test';
import { sortByTimestampStable, type LogEntry } from '../src/lib/utils/log-entry';

function entry(partial: Partial<LogEntry> & { id: number }): LogEntry {
	return { text: `line-${partial.id}`, ...partial };
}

describe('sortByTimestampStable', () => {
	test('interleaves two containers by ISO timestamp, oldest first', () => {
		const input: LogEntry[] = [
			entry({ id: 0, containerId: 'A', timestamp: '2026-08-13T10:00:03Z' }),
			entry({ id: 1, containerId: 'A', timestamp: '2026-08-13T10:00:05Z' }),
			entry({ id: 2, containerId: 'B', timestamp: '2026-08-13T10:00:01Z' }),
			entry({ id: 3, containerId: 'B', timestamp: '2026-08-13T10:00:04Z' })
		];
		const out = sortByTimestampStable(input);
		expect(out.map((e) => e.timestamp)).toEqual([
			'2026-08-13T10:00:01Z',
			'2026-08-13T10:00:03Z',
			'2026-08-13T10:00:04Z',
			'2026-08-13T10:00:05Z'
		]);
	});

	test('is order-independent: same result whichever container arrives first', () => {
		const a: LogEntry[] = [
			entry({ id: 10, containerId: 'A', timestamp: '2026-08-13T10:00:03Z' }),
			entry({ id: 11, containerId: 'B', timestamp: '2026-08-13T10:00:01Z' })
		];
		// same logical lines, reversed arrival order (ids reflect arrival)
		const b: LogEntry[] = [
			entry({ id: 20, containerId: 'B', timestamp: '2026-08-13T10:00:01Z' }),
			entry({ id: 21, containerId: 'A', timestamp: '2026-08-13T10:00:03Z' })
		];
		expect(sortByTimestampStable(a).map((e) => e.timestamp))
			.toEqual(sortByTimestampStable(b).map((e) => e.timestamp));
		// the reported bug: clicking cycles order — this proves the sort is deterministic
		expect(sortByTimestampStable(a).map((e) => e.containerId)).toEqual(['B', 'A']);
		expect(sortByTimestampStable(b).map((e) => e.containerId)).toEqual(['B', 'A']);
	});

	test('continuation line (no timestamp) stays glued under its parent from the same container', () => {
		const input: LogEntry[] = [
			entry({ id: 0, containerId: 'A', timestamp: '2026-08-13T10:00:05Z', text: 'stacktrace header' }),
			entry({ id: 1, containerId: 'A', text: '  at frame 1' }),          // continuation, no ts
			entry({ id: 2, containerId: 'A', text: '  at frame 2' }),          // continuation, no ts
			entry({ id: 3, containerId: 'B', timestamp: '2026-08-13T10:00:02Z', text: 'earlier B line' })
		];
		const out = sortByTimestampStable(input);
		// B (10:00:02) sorts before A's block; the two continuation lines inherit
		// A's 10:00:05 and remain directly under the header, in id order.
		expect(out.map((e) => e.text)).toEqual([
			'earlier B line',
			'stacktrace header',
			'  at frame 1',
			'  at frame 2'
		]);
	});

	test('equal timestamps fall back to id (stable, arrival order preserved)', () => {
		const ts = '2026-08-13T10:00:00Z';
		const input: LogEntry[] = [
			entry({ id: 5, containerId: 'A', timestamp: ts }),
			entry({ id: 2, containerId: 'B', timestamp: ts }),
			entry({ id: 9, containerId: 'A', timestamp: ts })
		];
		expect(sortByTimestampStable(input).map((e) => e.id)).toEqual([2, 5, 9]);
	});

	test('entries with no timestamp at all keep arrival order (id) and sort before timestamped ones', () => {
		const input: LogEntry[] = [
			entry({ id: 3, containerId: 'A', timestamp: '2026-08-13T10:00:01Z' }),
			entry({ id: 1, containerId: 'C', text: 'no ts at all' }),
			entry({ id: 2, containerId: 'D', text: 'also no ts' })
		];
		const out = sortByTimestampStable(input);
		// '' (no ts) < any ISO string, and id breaks the '' vs '' tie
		expect(out.map((e) => e.id)).toEqual([1, 2, 3]);
	});
});

import { describe, expect, test } from 'bun:test';
import { formatRunStatus } from '../src/lib/utils/run-status';

describe('formatRunStatus', () => {
	test('reports success with a duration', () => {
		expect(formatRunStatus({ running: false, ok: true, ms: 6200 })).toBe('Succeeded · 6.2s');
	});

	test('reports failure with the exit code when one is known', () => {
		expect(formatRunStatus({ running: false, ok: false, ms: 900, exitCode: 1 }))
			.toBe('Failed · exit 1 · 0.9s');
	});

	test('says nothing about duration while still running', () => {
		expect(formatRunStatus({ running: true })).toBe('Running…');
	});
});

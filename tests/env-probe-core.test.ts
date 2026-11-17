import { describe, it, expect } from 'bun:test';
import {
	DEFAULT_LIST_TIMEOUT_MS,
	LIST_TIMEOUT_MS,
	parseTimeoutMs,
	outcomeAfterContainerTimeout
} from '../src/lib/server/env-probe-core';

describe('parseTimeoutMs', () => {
	it('falls back on a missing or unusable budget', () => {
		for (const raw of [undefined, null, '', '  ', '30s', 'abc', '0', '-1', 'Infinity']) {
			expect(parseTimeoutMs(raw as string | undefined | null, 10_000)).toBe(10_000);
		}
	});

	it('accepts a positive millisecond value', () => {
		expect(parseTimeoutMs('30000', 10_000)).toBe(30_000);
		expect(parseTimeoutMs('2500.9', 10_000)).toBe(2500);
	});
});

describe('outcomeAfterContainerTimeout', () => {
	it('an alive-but-slow host stays online and is reported as slow', () => {
		const outcome = outcomeAfterContainerTimeout(true, 10_000);
		expect(outcome.online).toBe(true);
		expect(outcome.error).toContain('longer than 10s');
	});

	it('a host that also fails the ping is offline with the previous wording', () => {
		const outcome = outcomeAfterContainerTimeout(false, 10_000);
		expect(outcome).toEqual({ online: false, error: 'Connection timeout' });
	});
});

describe('LIST_TIMEOUT_MS', () => {
	it('is a usable budget by default', () => {
		expect(LIST_TIMEOUT_MS).toBeGreaterThan(0);
		expect(DEFAULT_LIST_TIMEOUT_MS).toBe(10_000);
	});
});

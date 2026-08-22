// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { helperWaitCapMs, helperWaitDeadline } from '../src/lib/server/helper-wait-core';

describe('helperWaitCapMs', () => {
	test('a positive timeout is the cap', () => {
		expect(helperWaitCapMs(600_000)).toBe(600_000);
		expect(helperWaitCapMs(1)).toBe(1);
	});
	test('0 means unbounded (cap 0) - the #1382 case', () => {
		// The backup helper passes 0 on purpose. The old `timeout || 3_600_000` turned this
		// into 60 minutes and killed healthy backups; the cap here must stay 0.
		expect(helperWaitCapMs(0)).toBe(0);
	});
	test('undefined means unbounded (cap 0)', () => {
		expect(helperWaitCapMs(undefined)).toBe(0);
	});
	test('a negative timeout is treated as unbounded, not a past cap', () => {
		expect(helperWaitCapMs(-5)).toBe(0);
	});
});

describe('helperWaitDeadline', () => {
	const NOW = 1_000_000;
	test('a positive timeout yields now + timeout', () => {
		expect(helperWaitDeadline(600_000, NOW)).toBe(NOW + 600_000);
	});
	test('0 yields Infinity (unbounded) - never a 1h wall clock', () => {
		expect(helperWaitDeadline(0, NOW)).toBe(Infinity);
	});
	test('undefined yields Infinity (unbounded)', () => {
		expect(helperWaitDeadline(undefined, NOW)).toBe(Infinity);
	});
	test('Date.now() < Infinity always holds, so the poll loop never times out when unbounded', () => {
		expect(NOW < helperWaitDeadline(0, NOW)).toBe(true);
		expect(Number.MAX_SAFE_INTEGER < helperWaitDeadline(undefined, 0)).toBe(true);
	});
});

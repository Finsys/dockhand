import { describe, test, expect } from 'bun:test';
import { Cron } from 'croner';
import { getNextRun, isValidCron } from '../src/lib/server/scheduler/cron-utils';

/**
 * Tests that our cron utilities use AND logic for day-of-month + day-of-week,
 * matching user expectations ("first Saturday") rather than Vixie cron OR logic.
 */

describe('getNextRun: AND logic for day-of-month + day-of-week', () => {
	test('first Saturday of the month: 0 3 1-7 * 6', () => {
		const next = getNextRun('0 3 1-7 * 6');
		expect(next).not.toBeNull();
		expect(next!.getDay()).toBe(6); // Saturday
		expect(next!.getDate()).toBeGreaterThanOrEqual(1);
		expect(next!.getDate()).toBeLessThanOrEqual(7);
	});

	test('first Monday of the month: 0 9 1-7 * 1', () => {
		const next = getNextRun('0 9 1-7 * 1');
		expect(next).not.toBeNull();
		expect(next!.getDay()).toBe(1); // Monday
		expect(next!.getDate()).toBeGreaterThanOrEqual(1);
		expect(next!.getDate()).toBeLessThanOrEqual(7);
	});

	test('1st of month AND Monday: 0 0 1 * 1', () => {
		const next = getNextRun('0 0 1 * 1');
		expect(next).not.toBeNull();
		expect(next!.getDate()).toBe(1);
		expect(next!.getDay()).toBe(1);
	});

	test('day-of-week only: 0 3 * * 1 — next run is a Monday', () => {
		const next = getNextRun('0 3 * * 1');
		expect(next).not.toBeNull();
		expect(next!.getDay()).toBe(1);
	});

	test('day-of-month only: 0 3 15 * * — next run is the 15th', () => {
		const next = getNextRun('0 3 15 * *');
		expect(next).not.toBeNull();
		expect(next!.getDate()).toBe(15);
	});

	test('daily at 3am: 0 3 * * *', () => {
		const next = getNextRun('0 3 * * *');
		expect(next).not.toBeNull();
		expect(next!.getHours()).toBe(3);
		expect(next!.getMinutes()).toBe(0);
	});

	test('every 30 minutes: */30 * * * *', () => {
		const next = getNextRun('*/30 * * * *');
		expect(next).not.toBeNull();
		const mins = next!.getMinutes();
		expect(mins === 0 || mins === 30).toBe(true);
	});

	test('invalid expression returns null', () => {
		expect(getNextRun('not a cron')).toBeNull();
	});

	test('timezone parameter works', () => {
		const next = getNextRun('0 3 * * *', 'Europe/Warsaw');
		expect(next).not.toBeNull();
	});
});

describe('isValidCron', () => {
	test('valid 5-field expressions', () => {
		expect(isValidCron('0 3 * * *')).toBe(true);
		expect(isValidCron('*/30 * * * *')).toBe(true);
		expect(isValidCron('0 3 1-7 * 6')).toBe(true);
		expect(isValidCron('0 0 1 * 1')).toBe(true);
		expect(isValidCron('5 4 * * 0')).toBe(true);
	});

	test('valid 6-field expressions (with seconds)', () => {
		expect(isValidCron('0 0 3 * * *')).toBe(true);
		expect(isValidCron('30 */5 * * * *')).toBe(true);
		expect(isValidCron('0 0 0 1 * *')).toBe(true);
	});

	test('invalid expressions', () => {
		expect(isValidCron('not a cron')).toBe(false);
		expect(isValidCron('* * *')).toBe(false);
		expect(isValidCron('60 * * * *')).toBe(false);
		expect(isValidCron('* 25 * * *')).toBe(false);
	});
});

describe('Schedule type detection from cron expression', () => {
	// Mirrors logic from api/auto-update/[containerName]/+server.ts
	function detectScheduleType(cronExpression: string): 'daily' | 'weekly' | 'custom' {
		const parts = cronExpression.split(' ');
		if (parts.length === 5) {
			const [, , day, month, dow] = parts;
			if (dow !== '*' && day === '*' && month === '*') return 'weekly';
			if (day === '*' && month === '*' && dow === '*') return 'daily';
		}
		return 'custom';
	}

	test('detects daily schedule', () => {
		expect(detectScheduleType('0 3 * * *')).toBe('daily');
		expect(detectScheduleType('30 12 * * *')).toBe('daily');
	});

	test('detects weekly schedule', () => {
		expect(detectScheduleType('0 3 * * 1')).toBe('weekly');
		expect(detectScheduleType('0 0 * * 0')).toBe('weekly');
		expect(detectScheduleType('0 3 * * 6')).toBe('weekly');
	});

	test('6-field expression is always custom', () => {
		expect(detectScheduleType('0 0 3 * * *')).toBe('custom');
		expect(detectScheduleType('30 0 3 * * 1')).toBe('custom');
	});

	test('monthly expressions are custom', () => {
		expect(detectScheduleType('0 3 1 * *')).toBe('custom');
		expect(detectScheduleType('0 0 15 6 *')).toBe('custom');
	});

	test('combined day-of-month and day-of-week is custom', () => {
		expect(detectScheduleType('0 3 1-7 * 6')).toBe('custom');
	});

	test('every-N-minutes is daily (all day fields are wildcard)', () => {
		expect(detectScheduleType('*/30 * * * *')).toBe('daily');
	});
});

describe('AND vs OR verification', () => {
	test('getNextRun produces different result than croner default for combined fields', () => {
		// croner default (legacyMode:true) uses OR — our getNextRun should use AND
		// With OR, "0 3 1-7 * 6" fires on days 1-7 OR any Saturday (~11/month)
		// With AND, it fires only on Saturdays that are also days 1-7 (~1/month)
		const orJob = new Cron('0 3 1-7 * 6'); // default = OR logic
		const orRuns = orJob.nextRuns(12);
		orJob.stop();

		// Our getNextRun uses AND — verify all 12 runs satisfy both constraints
		// We can't call getNextRun 12 times (it always returns the same next),
		// but we can verify the single next run satisfies AND
		const andNext = getNextRun('0 3 1-7 * 6');
		expect(andNext).not.toBeNull();
		expect(andNext!.getDay()).toBe(6);
		expect(andNext!.getDate()).toBeGreaterThanOrEqual(1);
		expect(andNext!.getDate()).toBeLessThanOrEqual(7);

		// OR logic produces runs that are NOT all Saturdays
		const nonSaturdayOrRuns = orRuns.filter((d) => d.getDay() !== 6);
		expect(nonSaturdayOrRuns.length).toBeGreaterThan(0);
	});
});

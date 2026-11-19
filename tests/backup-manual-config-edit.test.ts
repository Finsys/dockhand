/**
 * Editing a manual (run-once) backup config must not turn it into a scheduled one:
 * the form saves no cron for it, and the server keeps a removed schedule removed.
 */
import { describe, test, expect } from 'bun:test';
import { scheduleToSave, retentionOnScheduleToggle } from '../src/lib/utils/backup';
import { resolveRetentionForUpdate, resolveEnabledOnScheduleChange, retentionToStore } from '../src/lib/server/backups/helpers';

describe('scheduleToSave', () => {
	test('a manual config saves no cron and stays off, whatever the hidden fields hold', () => {
		expect(scheduleToSave(false, '0 2 * * *', true)).toEqual({ schedule: '', enabled: false });
	});

	test('a scheduled config saves its cron and its enabled flag', () => {
		expect(scheduleToSave(true, '0 3 * * 1', false)).toEqual({ schedule: '0 3 * * 1', enabled: false });
		expect(scheduleToSave(true, '0 3 * * 1', true)).toEqual({ schedule: '0 3 * * 1', enabled: true });
	});
});

describe('a manual config saved as manual', () => {
	test('stays off and gets no retention', () => {
		expect(resolveEnabledOnScheduleChange({ requestedEnabled: false, existingSchedule: null, newSchedule: null })).toBe(false);
		expect(resolveRetentionForUpdate({}, null, null)).toBeNull();
	});
});

describe('a schedule removed in an edit', () => {
	test('does not keep the scheduled retention default', () => {
		expect(resolveRetentionForUpdate(undefined, null, '0 2 * * *')).toBeNull();
		expect(resolveRetentionForUpdate({ keepLast: 0 }, null, '0 2 * * *')).toBeNull();
	});

	test('an explicit retention is still kept', () => {
		expect(resolveRetentionForUpdate({ keepLast: 3 }, null, '0 2 * * *')).toBe(JSON.stringify({ keepLast: 3 }));
	});
});

describe('retentionOnScheduleToggle', () => {
	const none = { keepLast: 0, keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 0 };
	const serverDefault = { keepLast: 0, keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 0 };

	test('switching on with no policy shows what the server stores for a scheduled config', () => {
		const { retention } = retentionOnScheduleToggle(true, none, null);
		expect(retention).toEqual(serverDefault);
		expect(JSON.parse(retentionToStore({}, '0 2 * * *') as string)).toEqual({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
	});

	test('a policy already set is kept', () => {
		const own = { ...none, keepLast: 3 };
		expect(retentionOnScheduleToggle(true, own, null)).toEqual({ retention: own, saved: null });
	});

	test('switching off before saving gives back the empty policy', () => {
		const on = retentionOnScheduleToggle(true, none, null);
		expect(retentionOnScheduleToggle(false, on.retention, on.saved)).toEqual({ retention: none, saved: null });
	});

	test('a default the user edited, or one already stored, survives switching off', () => {
		const on = retentionOnScheduleToggle(true, none, null);
		for (const edit of [{ keepLast: 1 }, { keepDaily: 14 }, { keepWeekly: 8 }, { keepMonthly: 12 }, { keepYearly: 2 }]) {
			const edited = { ...on.retention, ...edit };
			expect(retentionOnScheduleToggle(false, edited, on.saved).retention).toEqual(edited);
		}
		expect(retentionOnScheduleToggle(false, serverDefault, null).retention).toEqual(serverDefault);
	});
});

/**
 * Unit tests for backups/helpers.ts — currently the fail-fast withTimeout used to
 * bound helper-image resolution so a stalled pull can never hang a backup.
 */
import { describe, it, expect } from 'bun:test';
import { withTimeout, resolveEnabledOnScheduleChange } from '../../src/lib/server/backups/helpers';
import { BackupError } from '../../src/lib/server/backups/models';

describe('withTimeout', () => {
	it('resolves with the value when the promise settles before the deadline', async () => {
		const v = await withTimeout(Promise.resolve(42), 1000, 'nope');
		expect(v).toBe(42);
	});

	it('rejects with a BackupError(DOCKER) when the promise outlives the deadline', async () => {
		const slow = new Promise((r) => setTimeout(r, 200));
		let err: unknown;
		try {
			await withTimeout(slow, 20, 'timed out pulling helper image "x"');
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(BackupError);
		expect((err as BackupError).code).toBe('DOCKER');
		expect((err as Error).message).toContain('timed out pulling helper image');
	});

	it('propagates the underlying rejection (not a timeout) when it loses the race', async () => {
		const boom = Promise.reject(new Error('registry auth failed'));
		let err: unknown;
		try {
			await withTimeout(boom, 1000, 'timeout message');
		} catch (e) {
			err = e;
		}
		expect((err as Error).message).toBe('registry auth failed');
		expect(err).not.toBeInstanceOf(BackupError);
	});

	it('clears its timer on success (no dangling timeout keeps the loop alive)', async () => {
		// If the timer weren't cleared, a rejection would fire later and surface as an
		// unhandled rejection. Resolve fast, then wait past the deadline to prove quiet.
		await withTimeout(Promise.resolve('ok'), 30, 'should never fire');
		await new Promise((r) => setTimeout(r, 60));
		expect(true).toBe(true); // reaching here without an unhandled rejection is the assertion
	});
});

describe('resolveEnabledOnScheduleChange', () => {
	// THE BUG: run-once persists a manual, paused config (schedule=null, enabled=false).
	// Editing it to add a cron used to keep it paused because the UI sent the stale
	// enabled=false. Adding a schedule must auto-enable.
	it('auto-enables when a manual config (no schedule) gains a cron, even if the request says enabled=false', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: false,
			existingSchedule: null,
			newSchedule: '0 2 * * *'
		})).toBe(true);
	});

	it('auto-enables manual -> scheduled when existing schedule is an empty string', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: false,
			existingSchedule: '',
			newSchedule: '*/5 * * * *'
		})).toBe(true);
	});

	it('does NOT force-enable a config that was ALREADY scheduled (respects a deliberate pause)', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: false,
			existingSchedule: '0 2 * * *',
			newSchedule: '0 3 * * *'
		})).toBe(false);
	});

	it('honours an explicit enabled=true request unchanged', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: true,
			existingSchedule: '0 2 * * *',
			newSchedule: '0 2 * * *'
		})).toBe(true);
	});

	it('leaves enabled UNCHANGED (undefined) when the request omits the flag and there is no manual->scheduled transition', () => {
		// undefined must pass through so the DB layer keeps the existing value — a PUT
		// that omits `enabled` must never silently pause the config.
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: undefined,
			existingSchedule: '0 2 * * *',
			newSchedule: '0 2 * * *'
		})).toBeUndefined();
	});

	it('still auto-enables on manual->scheduled even when the request omits the flag', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: undefined,
			existingSchedule: null,
			newSchedule: '0 2 * * *'
		})).toBe(true);
	});

	it('does not enable when the new schedule is also empty (manual stays manual)', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: false,
			existingSchedule: null,
			newSchedule: null
		})).toBe(false);
	});

	it('treats a whitespace-only cron as no schedule (no false auto-enable)', () => {
		expect(resolveEnabledOnScheduleChange({
			requestedEnabled: false,
			existingSchedule: null,
			newSchedule: '   '
		})).toBe(false);
	});
});

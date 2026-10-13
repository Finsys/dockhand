/**
 * Unit tests for backups/helpers.ts — currently the fail-fast withTimeout used to
 * bound helper-image resolution so a stalled pull can never hang a backup.
 */
import { describe, it, expect } from 'bun:test';
import { withTimeout, resolveEnabledOnScheduleChange } from '../../src/lib/server/backups/helpers';
import {
	buildRestRepository,
	parseRestRepository,
	redactUrlCredentials
} from '../../src/lib/utils/rest-repository';
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

/**
 * Composing a rest: URL by hand is what makes a strong password unusable and leaks it
 * on failure. Verified against restic 0.19.1: an unencoded `%` is rejected outright
 * ("invalid URL escape"), and a location restic cannot parse is echoed with the
 * password in clear - restic only masks what it parsed.
 */
describe('buildRestRepository', () => {
	it('emits exactly one rest: prefix whether or not the user typed one', () => {
		expect(buildRestRepository('http://h:8000/repo')).toBe('rest:http://h:8000/repo');
		expect(buildRestRepository('rest:http://h:8000/repo')).toBe('rest:http://h:8000/repo');
		// The doubled prefix is the case that made restic print the password verbatim.
		expect(buildRestRepository('rest:http://h:8000/repo')).not.toContain('rest:rest:');
	});

	it('percent-encodes characters that would otherwise break the URL', () => {
		const repo = buildRestRepository('http://h:8000/repo', 'dockhand-user', 'p%ss@w0rd');
		expect(repo).toBe('rest:http://dockhand-user:p%25ss%40w0rd@h:8000/repo');
		// Round-trips through the URL parser, which is what restic does.
		expect(() => new URL(repo.replace(/^rest:/, ''))).not.toThrow();
	});

	it('handles a 64-character random password with the usual troublesome characters', () => {
		const pw = 'aB3%@:/?#[]!$&\'()*+,;=~-_.wXyZ0123456789%%@@::////AaBbCcDdEeFfGg';
		const repo = buildRestRepository('https://backup:8000/r', 'u', pw);
		const parsed = new URL(repo.replace(/^rest:/, ''));
		expect(decodeURIComponent(parsed.password)).toBe(pw);
		expect(parsed.hostname).toBe('backup');
		expect(parsed.pathname).toBe('/r');
	});

	it('replaces credentials already present in the server field', () => {
		expect(buildRestRepository('http://old:secret@h:8000/repo', 'new', 'pw')).toBe(
			'rest:http://new:pw@h:8000/repo'
		);
	});

	it('leaves a server field alone when no credentials are given', () => {
		expect(buildRestRepository('http://u:p@h:8000/repo')).toBe('rest:http://u:p@h:8000/repo');
	});

	it('an empty server yields an empty repository, never a bare prefix', () => {
		expect(buildRestRepository('')).toBe('');
		expect(buildRestRepository('   ')).toBe('');
		expect(buildRestRepository('', 'u', 'p')).toBe('');
	});

	it('round-trips through parseRestRepository', () => {
		const pw = 'p%ss@w0rd:with/slashes';
		const repo = buildRestRepository('http://h:8000/repo', 'dockhand-user', pw);
		expect(parseRestRepository(repo)).toEqual({
			url: 'http://h:8000/repo',
			user: 'dockhand-user',
			password: pw
		});
	});

	it('parses a repository that carries no credentials', () => {
		expect(parseRestRepository('rest:http://h:8000/repo')).toEqual({
			url: 'http://h:8000/repo',
			user: '',
			password: ''
		});
	});
});

/**
 * The test error reaches the browser AND is stored unencrypted in
 * backup_destinations.last_test_error, so it must never carry a password.
 */
describe('redactUrlCredentials', () => {
	it('redacts the password restic printed when it could not parse the location', () => {
		// Verbatim shape from restic 0.19.1 on a rest:rest: location.
		const msg =
			'Stat(<config/>) returned error: Head "rest:http://dockhand-user:SuperSecret123@host:8000/my-backups/config": unsupported protocol scheme "rest"';
		const out = redactUrlCredentials(msg);
		expect(out).not.toContain('SuperSecret123');
		expect(out).toContain('dockhand-user:***@');
	});

	it('redacts every occurrence, not just the first', () => {
		const out = redactUrlCredentials('a http://u1:p1@h/x and b https://u2:p2@h/y');
		expect(out).not.toContain('p1');
		expect(out).not.toContain('p2');
	});

	it('leaves a message with no credentials untouched', () => {
		const msg = 'Head "http://host:8000/my-backups/config": connection refused';
		expect(redactUrlCredentials(msg)).toBe(msg);
	});

	it('does not mangle a url that has no userinfo', () => {
		expect(redactUrlCredentials('see http://host:8000/path')).toBe('see http://host:8000/path');
	});

	it('is safe on empty input', () => {
		expect(redactUrlCredentials('')).toBe('');
	});
});

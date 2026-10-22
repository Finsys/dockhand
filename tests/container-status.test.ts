/**
 * formatUptime / parseUptimeToSeconds: reading uptime out of a Docker status.
 *
 * The statuses here are the real shapes go-units HumanDuration produces,
 * including the three phrasings that carry no digit - the class of value a
 * digit-anchored pattern drops.
 */
import { describe, test, expect } from 'bun:test';
import { formatUptime, parseUptimeToSeconds } from '../src/lib/utils/container-status';

describe('formatUptime', () => {
	test('running containers', () => {
		expect(formatUptime('Up 2 hours')).toBe('2 hours');
		expect(formatUptime('Up 3 hours (healthy)')).toBe('3 hours');
		expect(formatUptime('Up About an hour')).toBe('About an hour');
		expect(formatUptime('Up Less than a second')).toBe('Less than a second');
	});

	test('exited containers, with and without an exit code', () => {
		expect(formatUptime('Exited (0) 5 minutes ago')).toBe('5 minutes ago');
		expect(formatUptime('Exited 5 minutes ago')).toBe('5 minutes ago');
		expect(formatUptime('Exited (1) 3 weeks ago')).toBe('3 weeks ago');
	});

	test('digitless exited phrasings render instead of collapsing to a dash', () => {
		expect(formatUptime('Exited (137) About an hour ago')).toBe('About an hour ago');
		expect(formatUptime('Exited (0) About a minute ago')).toBe('About a minute ago');
		expect(formatUptime('Exited (0) Less than a second ago')).toBe('Less than a second ago');
	});

	test('restarting containers show their duration, not a dash', () => {
		expect(formatUptime('Restarting (1) 5 seconds ago')).toBe('5 seconds ago');
		expect(formatUptime('Restarting (1) About a minute ago')).toBe('About a minute ago');
		expect(formatUptime('Restarting (255) 2 hours ago')).toBe('2 hours ago');
	});

	test('statuses that carry no uptime', () => {
		expect(formatUptime('')).toBe('-');
		expect(formatUptime('Created')).toBe('-');
		expect(formatUptime('Dead')).toBe('-');
	});
});

describe('parseUptimeToSeconds', () => {
	test('running containers are positive and ordered by real duration', () => {
		expect(parseUptimeToSeconds('Up 45 seconds')).toBe(45);
		expect(parseUptimeToSeconds('Up About a minute')).toBe(60);
		expect(parseUptimeToSeconds('Up About an hour')).toBe(3600);
		expect(parseUptimeToSeconds('Up 2 hours')).toBe(7200);
	});

	test('an hour-old container outranks a seconds-old one', () => {
		expect(parseUptimeToSeconds('Up About an hour')).toBeGreaterThan(
			parseUptimeToSeconds('Up 45 seconds')
		);
	});

	test('exited containers are negative, so they sort after every running one', () => {
		expect(parseUptimeToSeconds('Exited (0) 5 minutes ago')).toBe(-300);
		expect(parseUptimeToSeconds('Exited (137) About an hour ago')).toBe(-3600);
		expect(parseUptimeToSeconds('Up Less than a second')).toBeGreaterThan(
			parseUptimeToSeconds('Exited (0) 5 minutes ago')
		);
	});

	test('a digitless exited status keeps its magnitude instead of sinking to -Infinity', () => {
		const hour = parseUptimeToSeconds('Exited (137) About an hour ago');
		const week = parseUptimeToSeconds('Exited (0) 1 week ago');
		expect(Number.isFinite(hour)).toBe(true);
		// More recently exited sorts above the older one.
		expect(hour).toBeGreaterThan(week);
	});

	test('a restarting container keeps its magnitude instead of sinking below everything', () => {
		// A crash-looping container is what an operator sorts by uptime to find, so
		// it must rank against the other non-running rows, not below all of them.
		const restarting = parseUptimeToSeconds('Restarting (1) 5 seconds ago');
		expect(Number.isFinite(restarting)).toBe(true);
		expect(restarting).toBe(-5);
		expect(restarting).toBeGreaterThan(parseUptimeToSeconds('Exited (0) 5 minutes ago'));
		expect(restarting).toBeGreaterThan(parseUptimeToSeconds('Dead'));
	});

	test('every status shape Docker emits is classified', () => {
		// moby container/state.go String(): Up, Up (Paused), Up (health),
		// Restarting, Removal In Progress, Dead, Exited.
		expect(parseUptimeToSeconds('Up 2 hours')).toBe(7200);
		expect(parseUptimeToSeconds('Up 2 hours (Paused)')).toBe(7200);
		expect(parseUptimeToSeconds('Up 2 hours (healthy)')).toBe(7200);
		expect(parseUptimeToSeconds('Restarting (1) 30 seconds ago')).toBe(-30);
		expect(parseUptimeToSeconds('Exited (0) 30 seconds ago')).toBe(-30);
		// These two carry no duration, so last is the right place for them.
		expect(parseUptimeToSeconds('Removal In Progress')).toBe(-Infinity);
		expect(parseUptimeToSeconds('Dead')).toBe(-Infinity);
	});

	test('unrecognised statuses sort last', () => {
		expect(parseUptimeToSeconds('')).toBe(-Infinity);
		expect(parseUptimeToSeconds('Created')).toBe(-Infinity);
	});

	test('a full grid sorts in real chronological order', () => {
		const statuses = [
			'Exited (0) 5 minutes ago',
			'Up About an hour',
			'Up 45 seconds',
			'Created',
			'Up 2 days'
		];
		const sorted = [...statuses].sort((a, b) => parseUptimeToSeconds(b) - parseUptimeToSeconds(a));
		expect(sorted).toEqual([
			'Up 2 days',
			'Up About an hour',
			'Up 45 seconds',
			'Exited (0) 5 minutes ago',
			'Created'
		]);
	});
});

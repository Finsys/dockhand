/**
 * Which user a container is shown as running.
 *
 * `Config.User` is what the image asked for; an image that drops privileges at
 * runtime leaves it empty, so showing it alone reports root for a container whose
 * application runs as somebody else. The /top rows below are verbatim from a live
 * daemon, including the init process that legitimately stays root.
 */
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import {
	effectiveContainerUid,
	containerProcessUids,
	displayContainerUser
} from '../src/lib/utils/effective-container-user';

// Measured: fnsys/dockhand:486089d8 with PUID=PGID=1001. tini stays root and drops
// privileges; node and the collector run as 1001.
const WITH_PUID = {
	Titles: ['UID', 'PID', 'PPID', 'COMMAND'],
	Processes: [
		['0', '736091', '736068', 'tini'],
		['1001', '736180', '736091', 'MainThread'],
		['1001', '736327', '736180', 'collection-work']
	]
};

// Same image with no PUID: everything is root, and that is the honest answer.
const ALL_ROOT = {
	Titles: ['UID', 'PID', 'PPID', 'COMMAND'],
	Processes: [
		['0', '289237', '289151', 'tini'],
		['0', '289364', '289237', 'MainThread'],
		['0', '289612', '289364', 'collection-work']
	]
};

describe('effectiveContainerUid', () => {
	test('skips the init process and reports the workload uid', () => {
		expect(effectiveContainerUid(WITH_PUID)).toBe('1001');
	});

	test('reports root when the workload really is root', () => {
		expect(effectiveContainerUid(ALL_ROOT)).toBe('0');
	});

	test('a single-process container reports its own uid', () => {
		expect(effectiveContainerUid({
			Titles: ['UID', 'PID', 'COMMAND'],
			Processes: [['1000', '42', 'nginx']]
		})).toBe('1000');
	});

	// Returning null matters: a caller that guessed "root" here would reproduce the
	// very bug this replaces.
	test('an unreadable table yields null rather than a guess', () => {
		expect(effectiveContainerUid(null)).toBeNull();
		expect(effectiveContainerUid(undefined)).toBeNull();
		expect(effectiveContainerUid({ Titles: [], Processes: [] })).toBeNull();
		expect(effectiveContainerUid({ Titles: ['PID', 'COMMAND'], Processes: [['1', 'sh']] })).toBeNull();
	});

	test('the UID column is found wherever it sits', () => {
		expect(effectiveContainerUid({
			Titles: ['PID', 'PPID', 'UID', 'COMMAND'],
			Processes: [['1', '0', '0', 'tini'], ['7', '1', '1001', 'node']]
		})).toBe('1001');
	});

	// Docker reports HOST pids, so pid 1 is often absent from the table entirely.
	test('with no pid 1 in the table, the first row is treated as init', () => {
		expect(effectiveContainerUid(WITH_PUID)).toBe('1001');
	});

	test('with pid 1 present, it is skipped by pid rather than by position', () => {
		expect(effectiveContainerUid({
			Titles: ['UID', 'PID', 'COMMAND'],
			Processes: [['1001', '7', 'node'], ['0', '1', 'tini']]
		})).toBe('1001');
	});
});

describe('displayContainerUser', () => {
	test('an explicit Config.User wins, since that is what was asked for', () => {
		expect(displayContainerUser('1000:1000', WITH_PUID)).toBe('1000:1000');
		expect(displayContainerUser('nobody', WITH_PUID)).toBe('nobody');
	});

	test('an empty Config.User falls back to the effective uid', () => {
		expect(displayContainerUser('', WITH_PUID)).toBe('1001 (effective)');
		expect(displayContainerUser(null, WITH_PUID)).toBe('1001 (effective)');
		expect(displayContainerUser(undefined, WITH_PUID)).toBe('1001 (effective)');
	});

	test('root is reported as root, not dressed up', () => {
		expect(displayContainerUser('', ALL_ROOT)).toBe('0 (effective)');
	});

	test('with no table at all it still says root, as before', () => {
		expect(displayContainerUser('', null)).toBe('root');
		expect(displayContainerUser('')).toBe('root');
	});
});

/**
 * The case that makes a single uid a lie: the application dropped privileges, but
 * something beside it kept root. Naming only the application would be a more
 * convincing untruth than the stale `root` this replaces, and it sits in a panel
 * labelled Security.
 */
describe('containerProcessUids', () => {
	const T = ['UID', 'PID', 'PPID', 'COMMAND'];

	test('one uid for the ordinary case', () => {
		expect(containerProcessUids(WITH_PUID)).toEqual(['1001']);
		expect(containerProcessUids(ALL_ROOT)).toEqual(['0']);
	});

	test('every uid when processes differ, init excluded', () => {
		const mixed = {
			Titles: T,
			Processes: [['0', '1', '0', 'tini'], ['1001', '7', '1', 'node'], ['0', '9', '1', 'cron']]
		};
		expect(containerProcessUids(mixed)).toEqual(['1001', '0']);
		expect(displayContainerUser('', mixed)).toBe('1001, 0 (effective)');
	});

	test('a repeated uid is listed once', () => {
		expect(containerProcessUids({
			Titles: T,
			Processes: [['0', '1', '0', 'tini'], ['1001', '7', '1', 'a'], ['1001', '9', '7', 'b']]
		})).toEqual(['1001']);
	});

	test('a single-process container keeps its own uid rather than being skipped', () => {
		expect(containerProcessUids({ Titles: ['UID', 'PID'], Processes: [['1000', '1']] })).toEqual(['1000']);
	});

	test('an unreadable table yields nothing to show', () => {
		expect(containerProcessUids(null)).toEqual([]);
		expect(containerProcessUids({ Titles: ['PID'], Processes: [['1']] })).toEqual([]);
	});
});

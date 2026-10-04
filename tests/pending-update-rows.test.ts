/**
 * What a persisted pending-update row means.
 *
 * The rule that matters: a container whose update is HELD by the minimum image
 * age must never be offered for a bulk update - the cooldown is exactly what
 * would block it. The server aggregation and the client store both read these
 * functions, so a disagreement between "shown as waiting" and "offered for
 * update" is impossible by construction.
 */

import { describe, expect, test } from 'bun:test';
import {
	coolingDown,
	isWorthPersisting,
	rowsToPersist,
	splitPendingUpdates,
	updatableIds,
	type PendingUpdateRow
} from '../src/lib/utils/pending-update-rows';

const digest = (id: string): PendingUpdateRow => ({ containerId: id, hasImageUpdate: true });
const held = (id: string, hours: number): PendingUpdateRow => ({
	containerId: id,
	hasImageUpdate: false,
	releaseAgeRemainingHours: hours
});
const semver = (id: string): PendingUpdateRow => ({
	containerId: id,
	hasImageUpdate: false,
	newerVersion: { tag: '2.0.0', bump: 'major' }
});

describe('a held update is never offered for a bulk update', () => {
	test('it is reported as waiting, not as updatable', () => {
		const rows = [digest('a'), held('b', 41)];
		expect(updatableIds(rows)).toEqual(['a']);
		expect([...coolingDown(rows).keys()]).toEqual(['b']);
	});

	test('a page of only held updates offers nothing to update', () => {
		const rows = [held('a', 1), held('b', 720)];
		expect(updatableIds(rows)).toEqual([]);
		expect(coolingDown(rows).size).toBe(2);
	});

	test('the two sets never overlap', () => {
		const rows = [digest('a'), held('b', 5), semver('c'), digest('d')];
		const updatable = new Set(updatableIds(rows));
		for (const id of coolingDown(rows).keys()) expect(updatable.has(id)).toBe(false);
	});

	test('the hours left are carried through', () => {
		expect(coolingDown([held('a', 41), held('b', 1)])).toEqual(
			new Map([['a', 41], ['b', 1]])
		);
	});
});

describe('turning the cooldown off stops the indicators at once', () => {
	// Rows outlive the setting: they are only rewritten by the next check, which may
	// be a day away on a daily cron. Until then a held row would otherwise keep
	// claiming a wait that no longer exists.
	const rows = [held('a', 41), held('b', 7), digest('c')];

	test('no hours configured means nothing is waiting', () => {
		expect(coolingDown(rows, 0).size).toBe(0);
	});

	test('the updates themselves are unaffected', () => {
		expect(updatableIds(rows)).toEqual(['c']);
	});

	test('a cooldown still in force keeps reporting them', () => {
		expect(coolingDown(rows, 72).size).toBe(2);
	});

	test('any non-zero cooldown counts, not just the one that stored the row', () => {
		// The stored hours were written under some earlier setting; what matters is
		// only whether a cooldown applies at all.
		expect(coolingDown(rows, 1).size).toBe(2);
	});

	test('an absent argument keeps the old behaviour', () => {
		expect(coolingDown(rows).size).toBe(2);
	});
});

describe('a row carrying both a digest update and a stale cooldown', () => {
	// hasImageUpdate only turns true once the cooldown has elapsed, so a row with
	// both is a ready update next to a leftover number. Reporting it as held would
	// hide an update the user can actually apply.
	const both: PendingUpdateRow = {
		containerId: 'a',
		hasImageUpdate: true,
		releaseAgeRemainingHours: 12
	};

	test('counts as updatable', () => {
		expect(updatableIds([both])).toEqual(['a']);
	});

	test('and not as held', () => {
		expect(coolingDown([both]).size).toBe(0);
	});
});

describe('zero hours is not a cooldown', () => {
	// A zero means the wait is over, not that a wait exists. It must not light up
	// an indicator that says "waiting".
	const zero: PendingUpdateRow = {
		containerId: 'a',
		hasImageUpdate: false,
		releaseAgeRemainingHours: 0
	};

	test('is not reported as held', () => {
		expect(coolingDown([zero]).size).toBe(0);
	});

	test('and is not worth a row on its own', () => {
		expect(isWorthPersisting(zero)).toBe(false);
	});
});

describe('what a finished check persists', () => {
	const result = (over: Record<string, unknown> = {}) => ({
		containerId: 'a',
		containerName: 'web',
		imageName: 'nginx:latest',
		...over
	});

	test('a held update is recorded with its hours and NOT as an available update', () => {
		const rows = rowsToPersist([result({ hasUpdate: false, releaseAgeRemainingHours: 41 })]);
		expect(rows).toHaveLength(1);
		expect(rows[0].options.releaseAgeRemainingHours).toBe(41);
		// the half that keeps it out of every bulk update
		expect(rows[0].options.hasImageUpdate).toBe(false);
	});

	test('an available update is recorded without a cooldown', () => {
		const rows = rowsToPersist([result({ hasUpdate: true })]);
		expect(rows[0].options.hasImageUpdate).toBe(true);
		expect(rows[0].options.releaseAgeRemainingHours).toBeNull();
	});

	test('a container with nothing to report is not recorded at all', () => {
		expect(rowsToPersist([result({ hasUpdate: false })])).toEqual([]);
	});

	test('system and update-disabled containers are never recorded', () => {
		expect(rowsToPersist([result({ hasUpdate: true, systemContainer: 'dockhand' })])).toEqual([]);
		expect(rowsToPersist([result({ hasUpdate: true, updateDisabled: true })])).toEqual([]);
		// not even when they are the ones being held
		expect(rowsToPersist([result({ releaseAgeRemainingHours: 5, systemContainer: 'dockhand' })])).toEqual([]);
	});

	test('the identity carried into the row is the container the check saw', () => {
		const rows = rowsToPersist([result({ hasUpdate: true })]);
		expect(rows[0]).toMatchObject({ containerId: 'a', containerName: 'web', imageName: 'nginx:latest' });
	});
});

describe('splitting a pending-updates response for the UI', () => {
	const row = (over: Record<string, unknown>) => ({ containerId: 'a', containerName: 'web', ...over });

	test('a held row becomes a cooldown, never an updatable container', () => {
		const split = splitPendingUpdates({
			pendingUpdates: [row({ hasImageUpdate: false, releaseAgeRemainingHours: 41 })],
			minimumReleaseAgeHours: 72
		});
		expect(split.updatable).toEqual([]);
		expect([...split.coolingDown]).toEqual([['a', 41]]);
	});

	test('the cooldown comes from the RESPONSE, so turning it off empties the map', () => {
		const data = { pendingUpdates: [row({ hasImageUpdate: false, releaseAgeRemainingHours: 41 })] };
		expect(splitPendingUpdates({ ...data, minimumReleaseAgeHours: 72 }).coolingDown.size).toBe(1);
		expect(splitPendingUpdates({ ...data, minimumReleaseAgeHours: 0 }).coolingDown.size).toBe(0);
	});

	test('a server that does not report the setting keeps the stored row visible', () => {
		const split = splitPendingUpdates({
			pendingUpdates: [row({ hasImageUpdate: false, releaseAgeRemainingHours: 41 })]
		});
		expect(split.coolingDown.size).toBe(1);
	});

	test('an available update survives the split with its name', () => {
		const split = splitPendingUpdates({
			pendingUpdates: [row({ hasImageUpdate: true })],
			minimumReleaseAgeHours: 0
		});
		expect(split.updatable).toEqual([{ containerId: 'a', containerName: 'web' }]);
	});

	test('a newer-version row is reported separately from both', () => {
		const split = splitPendingUpdates({
			pendingUpdates: [row({ hasImageUpdate: false, newerVersion: { tag: '2.0.0' } })],
			minimumReleaseAgeHours: 24
		});
		expect(split.updatable).toEqual([]);
		expect(split.coolingDown.size).toBe(0);
		expect(split.newerVersions.get('a')).toEqual({ tag: '2.0.0' });
	});

	test('an empty response clears everything rather than throwing', () => {
		const split = splitPendingUpdates({});
		expect(split.updatable).toEqual([]);
		expect(split.newerVersions.size).toBe(0);
		expect(split.coolingDown.size).toBe(0);
	});
});

describe('which rows are worth persisting', () => {
	test('a digest update is', () => {
		expect(isWorthPersisting({ hasImageUpdate: true })).toBe(true);
	});

	test('a newer-version suggestion is, even with no digest update', () => {
		expect(isWorthPersisting({ hasImageUpdate: false, newerVersion: { tag: '2.0.0' } })).toBe(true);
	});

	test('a held update is - without it the indicator would not survive a reload', () => {
		expect(isWorthPersisting({ hasImageUpdate: false, releaseAgeRemainingHours: 41 })).toBe(true);
	});

	test('a row with none of the three is not', () => {
		expect(isWorthPersisting({ hasImageUpdate: false })).toBe(false);
		expect(isWorthPersisting({ hasImageUpdate: false, newerVersion: null })).toBe(false);
		expect(isWorthPersisting({ hasImageUpdate: false, releaseAgeRemainingHours: null })).toBe(false);
		expect(isWorthPersisting({})).toBe(false);
	});
});

describe('missing and malformed fields', () => {
	test('an absent cooldown field is not a cooldown', () => {
		expect(coolingDown([{ containerId: 'a', hasImageUpdate: false }]).size).toBe(0);
	});

	test('a null cooldown is not a cooldown', () => {
		expect(coolingDown([{ containerId: 'a', releaseAgeRemainingHours: null }]).size).toBe(0);
	});

	test('an empty list yields empty results rather than throwing', () => {
		expect(updatableIds([])).toEqual([]);
		expect(coolingDown([]).size).toBe(0);
	});

	test('a semver-only row is neither updatable nor held', () => {
		expect(updatableIds([semver('a')])).toEqual([]);
		expect(coolingDown([semver('a')]).size).toBe(0);
	});
});

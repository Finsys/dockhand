/**
 * Unit tests for backups/retention.ts — pure retention planning. Proves the two
 * safety properties: retention is OFF by default, and a policy that would delete
 * every snapshot is refused.
 */
import { describe, it, expect } from 'bun:test';
import {
	parseRetention,
	retentionActive,
	buildForgetArgs,
	checkWouldWipe,
	NO_RETENTION,
} from '../../src/lib/server/backups/retention';

describe('parseRetention — safe default is "none"', () => {
	it('null / empty / garbage → none', () => {
		expect(parseRetention(null)).toEqual(NO_RETENTION);
		expect(parseRetention(undefined)).toEqual(NO_RETENTION);
		expect(parseRetention('')).toEqual(NO_RETENTION);
		expect(parseRetention('   ')).toEqual(NO_RETENTION);
		expect(parseRetention('not json')).toEqual(NO_RETENTION);
		expect(parseRetention('{}')).toEqual(NO_RETENTION);
		expect(parseRetention({})).toEqual(NO_RETENTION);
	});
	it('all-zero / non-positive values → none (never prune on a broken config)', () => {
		expect(parseRetention({ keepLast: 0 })).toEqual(NO_RETENTION);
		expect(parseRetention({ keepDaily: -1, keepWeekly: 0 })).toEqual(NO_RETENTION);
		expect(parseRetention({ keepLast: 'abc' })).toEqual(NO_RETENTION);
	});
	it('keepLast → keep-last mode', () => {
		expect(parseRetention({ keepLast: 5 })).toEqual({ mode: 'keep-last', last: 5 });
		expect(parseRetention('{"keepLast":3}')).toEqual({ mode: 'keep-last', last: 3 });
	});
	it('time buckets → time mode, only positive fields kept', () => {
		expect(parseRetention({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 2 }))
			.toEqual({ mode: 'time', daily: 7, weekly: 4, monthly: 6, yearly: 2 });
		expect(parseRetention({ keepDaily: 7, keepWeekly: 0 })).toEqual({ mode: 'time', daily: 7 });
	});
	it('keepLast takes precedence when both present', () => {
		expect(parseRetention({ keepLast: 5, keepDaily: 7 })).toEqual({ mode: 'keep-last', last: 5 });
	});
});

describe('retentionActive', () => {
	it('is false only for none', () => {
		expect(retentionActive(NO_RETENTION)).toBe(false);
		expect(retentionActive({ mode: 'keep-last', last: 1 })).toBe(true);
		expect(retentionActive({ mode: 'time', daily: 1 })).toBe(true);
	});
});

describe('buildForgetArgs', () => {
	const filter = 'dockhand:instance=i,dockhand:configid=7';

	it('returns null for none (nothing to prune)', () => {
		expect(buildForgetArgs(NO_RETENTION, filter)).toBeNull();
	});
	it('builds a keep-last forget scoped by the config tag, WITHOUT --prune', () => {
		const args = buildForgetArgs({ mode: 'keep-last', last: 5 }, filter);
		// NO --prune: post-backup retention only drops snapshot references (fast). Reclaiming
		// space is a separate scheduled prune, so a backup never hangs on "Applying retention".
		// --retry-lock is short (1m): forget runs inside the per-repo serializer, so the
		// only lock it can meet is an orphan (dead helper) or another instance sharing
		// the repo — waiting 5m for either was the cause of the 300s backup-test timeout.
		expect(args).toEqual([
			'forget', '--retry-lock', '1m', '--group-by', '', '--tag', filter, '--keep-last', '5',
		]);
		expect(args).not.toContain('--prune');
	});
	it('builds a time prune with only the set buckets', () => {
		const args = buildForgetArgs({ mode: 'time', daily: 7, monthly: 6 }, filter);
		expect(args).toContain('--keep-daily');
		expect(args).toContain('7');
		expect(args).toContain('--keep-monthly');
		expect(args).toContain('6');
		expect(args).not.toContain('--keep-weekly');
		expect(args).not.toContain('--keep-yearly');
	});
	it('dry-run mode adds --dry-run and --json, omits --prune', () => {
		const args = buildForgetArgs({ mode: 'keep-last', last: 1 }, filter, { dryRun: true, json: true })!;
		expect(args).toContain('--dry-run');
		expect(args).toContain('--json');
		expect(args).not.toContain('--prune');
	});
	it('always scopes by the config tag filter and uses empty group-by', () => {
		const args = buildForgetArgs({ mode: 'keep-last', last: 1 }, filter)!;
		const tagIdx = args.indexOf('--tag');
		expect(args[tagIdx + 1]).toBe(filter);
		const gIdx = args.indexOf('--group-by');
		expect(args[gIdx + 1]).toBe('');
	});
});

describe('checkWouldWipe — refuse a delete-everything policy', () => {
	it('flags a policy that keeps nothing and removes everything', () => {
		const dryRun = JSON.stringify([{ keep: [], remove: [{ id: 'a' }, { id: 'b' }] }]);
		expect(checkWouldWipe(dryRun)).toEqual({ wouldWipe: true, keep: 0, remove: 2, total: 2 });
	});
	it('does NOT flag a normal prune (keeps some)', () => {
		const dryRun = JSON.stringify([{ keep: [{ id: 'a' }], remove: [{ id: 'b' }] }]);
		expect(checkWouldWipe(dryRun)).toEqual({ wouldWipe: false, keep: 1, remove: 1, total: 2 });
	});
	it('does NOT flag when nothing is old enough to remove', () => {
		const dryRun = JSON.stringify([{ keep: [{ id: 'a' }], remove: [] }]);
		expect(checkWouldWipe(dryRun).wouldWipe).toBe(false);
	});
	it('sums across multiple groups', () => {
		const dryRun = JSON.stringify([
			{ keep: [], remove: [{ id: 'a' }] },
			{ keep: [], remove: [{ id: 'b' }] },
		]);
		expect(checkWouldWipe(dryRun)).toEqual({ wouldWipe: true, keep: 0, remove: 2, total: 2 });
	});
	it('empty / garbage / non-array → not a wipe (fail safe: no false positive)', () => {
		expect(checkWouldWipe('').wouldWipe).toBe(false);
		expect(checkWouldWipe('not json').wouldWipe).toBe(false);
		expect(checkWouldWipe('{"not":"array"}').wouldWipe).toBe(false);
	});
});

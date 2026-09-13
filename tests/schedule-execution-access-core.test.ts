import { describe, test, expect } from 'bun:test';
import {
	resourceForScheduleType,
	viewableScheduleTypes
} from '../src/lib/server/schedule-execution-access-core';

// Mirror of ALL_SCHEDULE_TYPES (db.ts) -- kept local so this stays a pure test
// with no DB import. If the union grows, the db.ts exhaustiveness guard catches it.
const ALL = [
	'container_update',
	'git_stack_sync',
	'system_cleanup',
	'env_update_check',
	'image_prune',
	'backup',
	'restore',
	'stack_deploy',
	'deploy_log_reconcile'
];

describe('resourceForScheduleType', () => {
	test('stack deploy + git sync map to stacks', () => {
		expect(resourceForScheduleType('stack_deploy')).toBe('stacks');
		expect(resourceForScheduleType('git_stack_sync')).toBe('stacks');
	});

	test('backup + restore map to backups', () => {
		expect(resourceForScheduleType('backup')).toBe('backups');
		expect(resourceForScheduleType('restore')).toBe('backups');
	});

	test('other known types map to schedules', () => {
		for (const t of [
			'container_update',
			'env_update_check',
			'image_prune',
			'system_cleanup',
			'deploy_log_reconcile'
		]) {
			expect(resourceForScheduleType(t)).toBe('schedules');
		}
	});

	test('an unknown/new type falls back to schedules (never a weaker resource)', () => {
		expect(resourceForScheduleType('something_new')).toBe('schedules');
		expect(resourceForScheduleType('')).toBe('schedules');
	});
});

describe('viewableScheduleTypes', () => {
	test('all three resources viewable -> null (no filter needed)', () => {
		expect(viewableScheduleTypes({ schedules: true, stacks: true, backups: true }, ALL)).toBeNull();
	});

	test('schedules only -> excludes stack_deploy/git_stack_sync/backup/restore', () => {
		const allowed = viewableScheduleTypes({ schedules: true, stacks: false, backups: false }, ALL)!;
		expect(allowed).toContain('container_update');
		expect(allowed).toContain('system_cleanup');
		expect(allowed).not.toContain('stack_deploy');
		expect(allowed).not.toContain('git_stack_sync');
		expect(allowed).not.toContain('backup');
		expect(allowed).not.toContain('restore');
	});

	test('stacks only -> only stack types (never generic/backup)', () => {
		const allowed = viewableScheduleTypes({ schedules: false, stacks: true, backups: false }, ALL)!;
		expect(allowed).toEqual(['git_stack_sync', 'stack_deploy']);
	});

	test('backups only -> only backup types', () => {
		const allowed = viewableScheduleTypes({ schedules: false, stacks: false, backups: true }, ALL)!;
		expect(allowed.sort()).toEqual(['backup', 'restore']);
	});

	test('no resource viewable -> empty allow-list (caller sees nothing)', () => {
		expect(viewableScheduleTypes({ schedules: false, stacks: false, backups: false }, ALL)).toEqual([]);
	});

	test('schedules + backups (not stacks) -> generic + backup, no stack_deploy', () => {
		const allowed = viewableScheduleTypes({ schedules: true, stacks: false, backups: true }, ALL)!;
		expect(allowed).toContain('container_update');
		expect(allowed).toContain('backup');
		expect(allowed).not.toContain('stack_deploy');
	});
});

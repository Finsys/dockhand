/**
 * Scheduled container start and stop: schedule times, the labels, what a label sync
 * changes, and the refusal to schedule Dockhand or Hawser themselves.
 */
import { describe, test, expect } from 'bun:test';
import {
	actionTimeToCron,
	labelActionTimes,
	planLabelSync,
	actionDecision,
	START_AT_LABEL,
	STOP_AT_LABEL,
	type LabelSyncRow
} from '../src/lib/server/scheduled-actions-core';

describe('actionTimeToCron', () => {
	test('HH:MM is every day at that time', () => {
		expect(actionTimeToCron('07:00')).toEqual({ cron: '0 7 * * *' });
		expect(actionTimeToCron('7:05')).toEqual({ cron: '5 7 * * *' });
		expect(actionTimeToCron(' 23:59 ')).toEqual({ cron: '59 23 * * *' });
		expect(actionTimeToCron('00:00')).toEqual({ cron: '0 0 * * *' });
	});

	test('a five-field cron expression is taken as written', () => {
		expect(actionTimeToCron('0 7 * * 1-5')).toEqual({ cron: '0 7 * * 1-5' });
	});

	test('anything else is refused with a reason', () => {
		for (const bad of ['24:00', '12:60', '7', '7:5', '0 7 * *', '0 7 * * * *', '99 7 * * *', 'tonight', '', 'x 07:00', '07:00 x', '07:000']) {
			expect('error' in actionTimeToCron(bad)).toBe(true);
		}
	});
});

describe('labelActionTimes', () => {
	test('reads both labels and ignores a blank one', () => {
		expect(labelActionTimes({ [START_AT_LABEL]: '07:00', [STOP_AT_LABEL]: ' ' })).toEqual({ startAt: '07:00', stopAt: null, errors: [] });
	});

	test('an invalid label is reported and not used', () => {
		const times = labelActionTimes({ [STOP_AT_LABEL]: '25:00' });
		expect(times.stopAt).toBe(null);
		expect(times.errors[0]).toContain(STOP_AT_LABEL);
	});

	test('no labels, nothing set', () => {
		expect(labelActionTimes(undefined)).toEqual({ startAt: null, stopAt: null, errors: [] });
	});
});

describe('planLabelSync', () => {
	const row = (over: Partial<LabelSyncRow>): LabelSyncRow => ({ id: 1, containerName: 'app', source: 'label', startAt: '07:00', stopAt: '23:00', ...over });
	const app = (labels: Record<string, string>, image = 'nginx:alpine') => ({ name: 'app', image, labels });

	test('a labelled container gets a row', () => {
		expect(planLabelSync([app({ [STOP_AT_LABEL]: '23:00' })], [])).toEqual({
			upserts: [{ containerName: 'app', startAt: null, stopAt: '23:00' }],
			deletes: [],
			warnings: []
		});
	});

	test('the label wins over a schedule set in the UI', () => {
		const plan = planLabelSync([app({ [STOP_AT_LABEL]: '23:00' })], [row({ source: 'ui', startAt: '06:00', stopAt: '22:00' })]);
		expect(plan.upserts).toEqual([{ containerName: 'app', startAt: null, stopAt: '23:00' }]);
	});

	test('changing one label time updates the row', () => {
		expect(planLabelSync([app({ [START_AT_LABEL]: '07:00', [STOP_AT_LABEL]: '22:00' })], [row({})]).upserts)
			.toEqual([{ containerName: 'app', startAt: '07:00', stopAt: '22:00' }]);
		expect(planLabelSync([app({ [START_AT_LABEL]: '06:00', [STOP_AT_LABEL]: '23:00' })], [row({})]).upserts)
			.toEqual([{ containerName: 'app', startAt: '06:00', stopAt: '23:00' }]);
	});

	test('labels take over a UI row even when the times are the same', () => {
		const plan = planLabelSync([app({ [START_AT_LABEL]: '07:00', [STOP_AT_LABEL]: '23:00' })], [row({ source: 'ui' })]);
		expect(plan.upserts).toEqual([{ containerName: 'app', startAt: '07:00', stopAt: '23:00' }]);
	});

	test('an unlabelled system container is not reported, and its UI row is not touched', () => {
		expect(planLabelSync([app({}, 'fnsys/dockhand:latest')], [])).toEqual({ upserts: [], deletes: [], warnings: [] });
		const plan = planLabelSync([app({ [STOP_AT_LABEL]: '23:00' }, 'fnsys/dockhand:latest')], [row({ id: 3, source: 'ui' })]);
		expect(plan.deletes).toEqual([]);
	});

	test('an unchanged label row is left alone', () => {
		const plan = planLabelSync([app({ [START_AT_LABEL]: '07:00', [STOP_AT_LABEL]: '23:00' })], [row({})]);
		expect(plan).toEqual({ upserts: [], deletes: [], warnings: [] });
	});

	test('a label row goes when its container drops the labels, a UI row stays', () => {
		expect(planLabelSync([app({})], [row({ id: 4 })]).deletes).toEqual([4]);
		expect(planLabelSync([app({})], [row({ id: 4, source: 'ui' })]).deletes).toEqual([]);
	});

	test('a label row goes with its container, a UI row stays', () => {
		expect(planLabelSync([], [row({ id: 4 })]).deletes).toEqual([4]);
		expect(planLabelSync([], [row({ id: 4, source: 'ui' })]).deletes).toEqual([]);
	});

	test('system containers are never scheduled from labels', () => {
		for (const image of ['fnsys/dockhand:latest', 'ghcr.io/finsys/hawser:latest']) {
			const plan = planLabelSync([app({ [STOP_AT_LABEL]: '23:00' }, image)], [row({ id: 9 })]);
			expect(plan.upserts).toEqual([]);
			expect(plan.deletes).toEqual([9]);
			expect(plan.warnings[0]).toContain('system containers');
		}
	});

	test('an invalid label is warned about and the valid one still applies', () => {
		const plan = planLabelSync([app({ [START_AT_LABEL]: 'later', [STOP_AT_LABEL]: '23:00' })], []);
		expect(plan.upserts).toEqual([{ containerName: 'app', startAt: null, stopAt: '23:00' }]);
		expect(plan.warnings[0]).toContain(START_AT_LABEL);
	});
});

describe('actionDecision', () => {
	test('a stop runs for every state with a live process', () => {
		for (const state of ['running', 'restarting', 'paused']) expect(actionDecision('stop', state)).toBe('run');
		for (const state of ['exited', 'created', 'dead']) expect(actionDecision('stop', state)).toBe('already');
	});

	test('a start runs only for a container that is down', () => {
		for (const state of ['running', 'restarting', 'paused']) expect(actionDecision('start', state)).toBe('already');
		for (const state of ['exited', 'created', 'dead']) expect(actionDecision('start', state)).toBe('run');
	});
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleFrequencyRank, pickScheduleWinner, type GitStackScheduleLike } from '../src/lib/server/git-schedule-ranking';

function stack(id: number, cron: string | null, schedule: string | null = 'custom'): GitStackScheduleLike {
	return { id, autoUpdateCron: cron, autoUpdateSchedule: schedule };
}

describe('runtime backfill: schedule ranking (ported from 0010)', () => {
	it('promotes the most frequent stack schedule', () => {
		const winner = pickScheduleWinner([
			stack(1, '0 3 * * 0'), // weekly
			stack(2, '0 * * * *'), // hourly
			stack(3, '0 3 * * *', 'daily') // daily
		]);
		assert.equal(winner?.id, 2);
		assert.equal(winner?.autoUpdateCron, '0 * * * *');
	});

	it('prefers a sub-hourly schedule over hourly, daily and weekly', () => {
		const winner = pickScheduleWinner([
			stack(1, '0 3 * * *', 'daily'),
			stack(2, '*/5 * * * *'), // sub-hourly
			stack(3, '0 * * * *') // hourly
		]);
		assert.equal(winner?.autoUpdateCron, '*/5 * * * *');
	});

	it('breaks ties on equal-frequency schedules by the lowest stack id', () => {
		const winner = pickScheduleWinner([
			stack(9, '0 3 * * 0'),
			stack(2, '0 3 * * 0')
		]);
		assert.equal(winner?.id, 2);
		assert.equal(winner?.autoUpdateCron, '0 3 * * 0');
	});

	it('returns undefined for an empty list', () => {
		assert.equal(pickScheduleWinner([]), undefined);
	});

	it('ranks daily above weekly', () => {
		assert.ok(scheduleFrequencyRank(stack(1, '0 3 * * *', 'daily')) > scheduleFrequencyRank(stack(1, '0 3 * * 0')));
	});
});

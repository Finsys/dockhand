// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { mapActionToEventType, withoutSubscribersOf } from '../src/lib/server/notifications/events-core';

describe('mapActionToEventType', () => {
	// The full docker-action -> notification-event decision table. This is what turns a
	// raw Docker event into a notification type; a wrong or missing row silently drops a
	// notification the user asked for.
	const cases: [string, string | null][] = [
		['start', 'container_started'],
		['stop', 'container_stopped'],
		['restart', 'container_restarted'],
		['die', 'container_exited'],
		['kill', 'container_exited'],
		['oom', 'container_oom'],
		['health_status: unhealthy', 'container_unhealthy'],
		['health_status: healthy', 'container_healthy'],
		['pull', 'image_pulled']
	];

	for (const [action, expected] of cases) {
		test(`"${action}" -> ${expected}`, () => {
			expect(mapActionToEventType(action)).toBe(expected);
		});
	}

	test('an unknown action maps to null (no notification)', () => {
		expect(mapActionToEventType('create')).toBeNull();
		expect(mapActionToEventType('destroy')).toBeNull();
		expect(mapActionToEventType('')).toBeNull();
	});

	// Docker has no "update" action - an image update surfaces as die/kill then start.
	// So there is deliberately NO 'update' row here; container_updated is raised from the
	// recreate flow instead (#1424). This asserts we don't accidentally add a bogus one.
	test('there is no "update" docker action mapping', () => {
		expect(mapActionToEventType('update')).toBeNull();
	});
});

describe('withoutSubscribersOf', () => {
	// A git deploy's stack_deployed goes only to channels that will not get git_sync_success.
	const stackOnly = { name: 'stack-only', eventTypes: ['stack_deployed'] };
	const both = { name: 'both', eventTypes: ['stack_deployed', 'git_sync_success'] };
	const failedOnly = { name: 'git-failed-only', eventTypes: ['stack_deployed', 'git_sync_failed'] };
	const unset = { name: 'unset', eventTypes: null };

	test('drops the channels subscribed to the covering event', () => {
		expect(withoutSubscribersOf([stackOnly, both, failedOnly, unset], 'git_sync_success').map((c) => c.name))
			.toEqual(['stack-only', 'git-failed-only', 'unset']);
	});

	test('keeps every channel when nothing covers the event', () => {
		expect(withoutSubscribersOf([stackOnly, both], undefined)).toEqual([stackOnly, both]);
	});
});

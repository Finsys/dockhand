// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { mapActionToEventType, withoutSubscribersOf, deliveryLogLine, coveredLogLine } from '../src/lib/server/notifications/events-core';

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

describe('notification log lines', () => {
	test('a delivery that went out', () => {
		expect(deliveryLogLine('stack_deployed', 'ops', 'apprise', { success: true }))
			.toBe('[Notifications] stack_deployed -> ops (apprise): sent');
	});

	test('a failed delivery carries the sender error, capped at 300 characters', () => {
		const line = deliveryLogLine('stack_deployed', 'ops', 'smtp', { success: false, error: 'SMTP error: ' + 'x'.repeat(500) });
		expect(line.startsWith('[Notifications] stack_deployed -> ops (smtp): failed: SMTP error: ')).toBe(true);
		expect(line.length).toBe('[Notifications] stack_deployed -> ops (smtp): failed: '.length + 300);
	});

	test('a failed delivery without an error text says so', () => {
		expect(deliveryLogLine('stack_deployed', 'ops', 'apprise', { success: false }))
			.toBe('[Notifications] stack_deployed -> ops (apprise): failed: no error given');
	});

	test('names the channels skipped because the covering event reaches them', () => {
		expect(coveredLogLine('stack_deployed', 'git_sync_success', ['both', 'gitok']))
			.toBe('[Notifications] stack_deployed: skipped both, gitok (subscribed to git_sync_success, which they get instead)');
	});

	test('nothing to log when no channel was skipped', () => {
		expect(coveredLogLine('stack_deployed', 'git_sync_success', [])).toBeNull();
		expect(coveredLogLine('stack_deployed', undefined, [])).toBeNull();
	});
});

// index.ts loads the database, so bun cannot import it; this pins that both send loops
// log each delivery and that both paths log the channels a coveredBy skipped.
describe('notification sends are wired to the log lines', () => {
	const { readFileSync } = require('node:fs') as typeof import('node:fs');
	const src = readFileSync(new URL('../src/lib/server/notifications/index.ts', import.meta.url), 'utf8');

	test('both send loops log each delivery', () => {
		expect(src).toContain('logDelivery(eventType, notif.channelName, notif.channelType, result);');
		expect(src).toContain('logDelivery(eventType, channel.channel_name, channel.channel_type, result);');
	});

	test('both paths log the skipped channels, the global one after the event filter', () => {
		expect(src).toContain('logCovered(eventType, coveredBy, envNotifications.filter(n => !kept.includes(n)).map(n => n.channelName));');
		expect(src).toContain('logCovered(eventType, coveredBy, subscribed.filter(s => !kept.includes(s)).map(s => s.name));');
		expect(src).toMatch(/\.filter\(s => s\.eventTypes\?\.includes\(eventType\)\);\s*const kept = withoutSubscribersOf\(subscribed, coveredBy\);/);
	});
});

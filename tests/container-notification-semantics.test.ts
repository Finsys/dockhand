import { describe, expect, test } from 'bun:test';
import {
createContainerNotificationTracker
} from '../src/lib/server/notifications/container-events';

describe('container notification semantics', () => {
test('normal docker stop produces only container_stopped', () => {
const tracker = createContainerNotificationTracker();

expect(tracker.shouldNotify(1, 'abc', 'kill')).toBe(false);
expect(tracker.shouldNotify(1, 'abc', 'stop')).toBe(true);
expect(tracker.shouldNotify(1, 'abc', 'die')).toBe(false);
});

test('unexpected die produces container_exited notification', () => {
const tracker = createContainerNotificationTracker();

expect(tracker.shouldNotify(1, 'abc', 'die')).toBe(true);
});

test('docker kill is reported once through the following die event', () => {
const tracker = createContainerNotificationTracker();

expect(tracker.shouldNotify(1, 'abc', 'kill')).toBe(false);
expect(tracker.shouldNotify(1, 'abc', 'die')).toBe(true);
});

test('oom is reported once and suppresses the following die event', () => {
const tracker = createContainerNotificationTracker();

expect(tracker.shouldNotify(1, 'abc', 'oom')).toBe(true);
expect(tracker.shouldNotify(1, 'abc', 'die')).toBe(false);
});

test('state is isolated per environment and container', () => {
const tracker = createContainerNotificationTracker();

expect(tracker.shouldNotify(1, 'abc', 'stop')).toBe(true);

expect(tracker.shouldNotify(1, 'def', 'die')).toBe(true);
expect(tracker.shouldNotify(2, 'abc', 'die')).toBe(true);

expect(tracker.shouldNotify(1, 'abc', 'die')).toBe(false);
});
test('docker restart is coalesced into a single container_restarted notification', async () => {
	const notifications: string[] = [];

	const tracker = createContainerNotificationTracker({
		delayMs: 20
	});

	tracker.dispatch(1, 'abc', 'kill', () => notifications.push('container_exited'));
	tracker.dispatch(1, 'abc', 'stop', () => notifications.push('container_stopped'));
	tracker.dispatch(1, 'abc', 'die', () => notifications.push('container_exited'));
	tracker.dispatch(1, 'abc', 'start', () => notifications.push('container_started'));
	tracker.dispatch(1, 'abc', 'restart', () => notifications.push('container_restarted'));

	await new Promise(resolve => setTimeout(resolve, 50));

	expect(notifications).toEqual([
		'container_restarted'
	]);
});

test('plain stop is emitted after the coalescing window', async () => {
	const notifications: string[] = [];

	const tracker = createContainerNotificationTracker({
		delayMs: 20
	});

	tracker.dispatch(1, 'abc', 'kill', () => notifications.push('container_exited'));
	tracker.dispatch(1, 'abc', 'stop', () => notifications.push('container_stopped'));
	tracker.dispatch(1, 'abc', 'die', () => notifications.push('container_exited'));

	expect(notifications).toEqual([]);

	await new Promise(resolve => setTimeout(resolve, 50));

	expect(notifications).toEqual([
		'container_stopped'
	]);
});

test('plain start is emitted after the coalescing window', async () => {
	const notifications: string[] = [];

	const tracker = createContainerNotificationTracker({
		delayMs: 20
	});

	tracker.dispatch(1, 'abc', 'start', () => notifications.push('container_started'));

	expect(notifications).toEqual([]);

	await new Promise(resolve => setTimeout(resolve, 50));

	expect(notifications).toEqual([
		'container_started'
	]);
});
});

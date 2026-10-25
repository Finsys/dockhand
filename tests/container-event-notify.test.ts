/**
 * The one notify decision both container-event paths (collector and Hawser edge)
 * use: an event Dockhand caused on purpose, or one from a container that opted out,
 * does not notify.
 */
import { describe, test, expect } from 'bun:test';
import { shouldNotifyContainerEvent } from '../src/lib/server/container-event-notify';
import { expectedEvents } from '../src/lib/server/expected-events-core';

describe('shouldNotifyContainerEvent', () => {
	test('an ordinary stop notifies', () => {
		expect(shouldNotifyContainerEvent('c-plain', 'stop', {})).toBe(true);
	});

	test('a stop Dockhand caused does not', () => {
		expectedEvents.markExpected('c-update', Date.now(), 30_000);
		expect(shouldNotifyContainerEvent('c-update', 'stop', {})).toBe(false);
		expect(shouldNotifyContainerEvent('c-update', 'die', {})).toBe(false);
	});

	test('a scheduled start does not, its later stop does', () => {
		expectedEvents.markExpected('c-start', Date.now(), 30_000, ['start']);
		expect(shouldNotifyContainerEvent('c-start', 'start', {})).toBe(false);
		expect(shouldNotifyContainerEvent('c-start', 'stop', {})).toBe(true);
	});

	test('dockhand.notify=false opts a container out', () => {
		expect(shouldNotifyContainerEvent('c-quiet', 'stop', { 'dockhand.notify': 'false' })).toBe(false);
	});
});

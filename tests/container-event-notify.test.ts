/**
 * The one notify decision both container-event paths (collector and Hawser edge)
 * use: an event Dockhand caused on purpose, or one from a container that opted out,
 * does not notify.
 */
import { describe, test, expect } from 'bun:test';
import { shouldNotifyContainerEvent, isNonTerminatingKillSignal } from '../src/lib/server/container-event-notify';
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

	test('a kill event carrying a non-terminating signal does NOT notify (SIGWINCH resize spam)', () => {
		// Docker emits `kill` for any delivered signal; an interactive container gets SIGWINCH
		// (28) on every terminal resize. These must not fire a "container exited" notification.
		expect(shouldNotifyContainerEvent('c-tty', 'kill', { signal: '28' })).toBe(false); // SIGWINCH
		expect(shouldNotifyContainerEvent('c-tty', 'kill', { signal: '23' })).toBe(false); // SIGURG
	});

	test('a kill event with a TERMINATING signal still notifies', () => {
		expect(shouldNotifyContainerEvent('c-tty', 'kill', { signal: '15' })).toBe(true); // SIGTERM
		expect(shouldNotifyContainerEvent('c-tty', 'kill', { signal: '9' })).toBe(true);  // SIGKILL
		// a kill with no signal attribute is treated as alarm-worthy (cannot prove it harmless).
		expect(shouldNotifyContainerEvent('c-tty', 'kill', {})).toBe(true);
	});
});

describe('isNonTerminatingKillSignal', () => {
	test('true only for a kill action with a known non-terminating signal', () => {
		// The real decimal strings Docker emits (verified: SIGWINCH->28, SIGURG->23).
		for (const s of ['28', '23', '18', '17']) {
			expect(isNonTerminatingKillSignal('kill', { signal: s })).toBe(true);
		}
		// Symbolic forms, any case / SIG-prefix, for daemons that send names.
		for (const s of ['SIGWINCH', 'winch', 'SIGCONT', 'URG']) {
			expect(isNonTerminatingKillSignal('kill', { signal: s })).toBe(true);
		}
		// Surrounding whitespace is trimmed before the lookup.
		for (const s of [' 28 ', '\tSIGWINCH\n']) {
			expect(isNonTerminatingKillSignal('kill', { signal: s })).toBe(true);
		}
	});

	test('false for terminating signals and near-misses', () => {
		expect(isNonTerminatingKillSignal('kill', { signal: '9' })).toBe(false);   // SIGKILL
		expect(isNonTerminatingKillSignal('kill', { signal: '15' })).toBe(false);  // SIGTERM
		expect(isNonTerminatingKillSignal('kill', { signal: '2' })).toBe(false);   // SIGINT
		expect(isNonTerminatingKillSignal('kill', {})).toBe(false);                // no signal
		expect(isNonTerminatingKillSignal('kill', { signal: '' })).toBe(false);
		expect(isNonTerminatingKillSignal('kill', { signal: '280' })).toBe(false); // not a substring of 28
	});

	test('false for any action other than kill, even with a non-terminating signal', () => {
		// Only `kill` carries this ambiguity; die/stop/start are not gated by signal.
		expect(isNonTerminatingKillSignal('die', { signal: '28' })).toBe(false);
		expect(isNonTerminatingKillSignal('stop', { signal: '28' })).toBe(false);
	});
});

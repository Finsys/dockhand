/**
 * Whether a Docker container event should notify. Shared by the collector path and
 * the Hawser edge path so both silence the same events: ones Dockhand caused on
 * purpose (an update's stop, a scheduled stop or start) and containers that opted
 * out with dockhand.notify=false.
 */
import { expectedEvents } from './expected-events-core';
import { isNotifyDisabledByLabel } from './container-labels';

// Docker emits a `kill` event for ANY signal delivered to a container, not only a
// terminating one. These signals do not end the container and are not alarm-worthy -
// an interactive container receives SIGWINCH on every terminal resize, which otherwise
// fires a false "container exited" notification. Numbers are the Linux values Docker
// reports in the event's signal attribute (signal(7)); names are accepted too for the
// daemons that send the symbolic form.
const NON_TERMINATING_KILL_SIGNALS = new Set([
	'17', 'SIGCHLD', 'CHLD',   // child state change
	'18', 'SIGCONT', 'CONT',   // continue
	'23', 'SIGURG', 'URG',     // urgent socket data (default-ignored)
	'28', 'SIGWINCH', 'WINCH'  // terminal window resize
]);

/** True when a `kill` event carries a non-terminating signal, so it is not a real
 * container-death notification. Pure for unit testing. */
export function isNonTerminatingKillSignal(
	action: string,
	actorAttributes: Record<string, string> | null | undefined
): boolean {
	if (action !== 'kill') return false;
	const signal = actorAttributes?.signal;
	if (!signal) return false;
	return NON_TERMINATING_KILL_SIGNALS.has(signal.trim().toUpperCase());
}

export function shouldNotifyContainerEvent(
	containerId: string,
	action: string,
	actorAttributes: Record<string, string> | null | undefined,
	now: number = Date.now()
): boolean {
	if (isNonTerminatingKillSignal(action, actorAttributes)) return false;
	return !expectedEvents.shouldSuppress(containerId, action, now) && !isNotifyDisabledByLabel(actorAttributes);
}

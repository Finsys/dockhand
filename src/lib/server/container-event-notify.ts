/**
 * Whether a Docker container event should notify. Shared by the collector path and
 * the Hawser edge path so both silence the same events: ones Dockhand caused on
 * purpose (an update's stop, a scheduled stop or start) and containers that opted
 * out with dockhand.notify=false.
 */
import { expectedEvents } from './expected-events-core';
import { isNotifyDisabledByLabel } from './container-labels';

export function shouldNotifyContainerEvent(
	containerId: string,
	action: string,
	actorAttributes: Record<string, string> | null | undefined,
	now: number = Date.now()
): boolean {
	return !expectedEvents.shouldSuppress(containerId, action, now) && !isNotifyDisabledByLabel(actorAttributes);
}

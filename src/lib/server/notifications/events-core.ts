/**
 * Pure notification-event decision logic - NO db/docker imports, so it unit-tests
 * under the bun runner. index.ts re-exports and uses these; keeping the decisions here
 * means the full "which events fire for which input" matrix is testable in isolation.
 *
 * `NotificationEventType` is a type-only import (erased at build), so it doesn't pull
 * better-sqlite3 in through db.ts.
 */

import type { NotificationEventType } from '../db';

/**
 * Map a raw Docker event action to the notification event type it should raise, or null
 * when the action isn't one we notify on. Docker has no "updated" action - a container
 * update is a die/kill of the old container followed by start of the new one, so those
 * map to container_exited/container_started here. The "container was updated" signal is
 * raised separately (see updateEventTypes) from the recreate flow, not from a raw event.
 */
export function mapActionToEventType(action: string): NotificationEventType | null {
	const mapping: Record<string, NotificationEventType> = {
		start: 'container_started',
		stop: 'container_stopped',
		restart: 'container_restarted',
		die: 'container_exited',
		kill: 'container_exited',
		oom: 'container_oom',
		'health_status: unhealthy': 'container_unhealthy',
		'health_status: healthy': 'container_healthy',
		pull: 'image_pulled'
	};
	return mapping[action] || null;
}

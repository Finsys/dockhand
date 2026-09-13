import { json, type RequestHandler } from '@sveltejs/kit';
import { sendEventNotification, sendEnvironmentNotification } from '$lib/server/notifications';
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '$lib/server/db';

/**
 * Test endpoint to trigger notifications for any event type.
 * This is intended for development/testing purposes only.
 *
 * @openapi
 * summary: Trigger a real notification for a given event type (development/testing helper)
 * description: environmentId from GET /api/environments.
 * body: {eventType:string!, environmentId:integer, payload:{title:string!, message:string!, type:string}}
 * body-example: {"eventType":"container_unhealthy","environmentId":1,"payload":{"title":"Container unhealthy","message":"web-1 is unhealthy","type":"warning"}}
 * resp-200: {success:boolean!, sent:integer, eventType:string!, environmentId:integer}
 * resp-200-example: {"success":true,"sent":1,"eventType":"container_unhealthy","environmentId":1}
 * resp-400: eventType required, payload with title and message required, unknown event type, or environmentId missing for a non-system event
 * resp-500: Unknown error while sending the notification
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { eventType, environmentId, payload } = body;

		if (!eventType) {
			return json({ error: 'eventType is required' }, { status: 400 });
		}

		if (!payload || !payload.title || !payload.message) {
			return json({ error: 'payload with title and message is required' }, { status: 400 });
		}

		// Validate event type - NOTIFICATION_EVENT_TYPES is array of {id, label, ...}
		const validEventIds = NOTIFICATION_EVENT_TYPES.map(e => e.id);
		if (!validEventIds.includes(eventType)) {
			return json({
				error: `Invalid event type: ${eventType}`,
				validTypes: validEventIds
			}, { status: 400 });
		}

		// Determine if this is a system event or environment event
		const isSystemEvent = eventType === 'license_expiring';

		let result;

		if (isSystemEvent) {
			// System events don't have an environment
			result = await sendEventNotification(
				eventType as NotificationEventType,
				{
					title: payload.title,
					message: payload.message,
					type: payload.type || 'info'
				}
			);
		} else if (environmentId) {
			// Environment-scoped events
			result = await sendEventNotification(
				eventType as NotificationEventType,
				{
					title: payload.title,
					message: payload.message,
					type: payload.type || 'info'
				},
				environmentId
			);
		} else {
			return json({
				error: 'environmentId is required for non-system events'
			}, { status: 400 });
		}

		return json({
			success: result.success,
			sent: result.sent,
			eventType,
			environmentId: isSystemEvent ? null : environmentId
		});
	} catch (error) {
		console.error('[Notification Test] Error:', error);
		return json({
			error: error instanceof Error ? error.message : 'Unknown error'
		}, { status: 500 });
	}
};

/**
 * GET endpoint to list all available event types
 *
 * @openapi
 * summary: List all available notification event types, grouped into categories
 * resp-200: {eventTypes:array<{id:string!, label:string}>, categories:{container:array<string>, autoUpdate:array<string>, gitStack:array<string>, stack:array<string>, security:array<string>, system:array<string>}}
 */
export const GET: RequestHandler = async () => {
	return json({
		eventTypes: NOTIFICATION_EVENT_TYPES,
		categories: {
			container: [
				'container_started',
				'container_stopped',
				'container_restarted',
				'container_exited',
				'container_unhealthy',
				'container_oom',
				'container_updated',
				'image_pulled',
			],
			autoUpdate: [
				'auto_update_success',
				'auto_update_failed',
				'auto_update_blocked',
			],
			gitStack: [
				'git_sync_success',
				'git_sync_failed',
				'git_sync_skipped',
			],
			stack: [
				'stack_started',
				'stack_stopped',
				'stack_deployed',
				'stack_deploy_failed',
			],
			security: [
				'vulnerability_critical',
				'vulnerability_high',
				'vulnerability_any',
			],
			system: [
				'environment_offline',
				'environment_online',
				'disk_space_warning',
				'license_expiring',
			],
		}
	});
};

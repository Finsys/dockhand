import { json } from '@sveltejs/kit';
import {
	getEnvironmentNotifications,
	createEnvironmentNotification,
	getEnvironment,
	getNotificationSettings,
	type NotificationEventType
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

// GET /api/environments/[id]/notifications - List all notification configurations for an environment
/**
 * @openapi
 * summary: List notification channel configurations attached to an environment
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: array<{id:integer!, notificationId:integer!, enabled:boolean!, eventTypes:array<string>}>
 * resp-400: Invalid environment id
 * resp-403: Permission denied (RBAC 'notifications:view' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while loading notifications
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const envId = parseInt(params.id);
	if (isNaN(envId)) {
		return json({ error: 'Invalid environment ID' }, { status: 400 });
	}

	const env = await getEnvironment(envId);
	if (!env) {
		return json({ error: 'Environment not found' }, { status: 404 });
	}

	try {
		const notifications = await getEnvironmentNotifications(envId);
		return json(notifications);
	} catch (error) {
		console.error('Error fetching environment notifications:', error);
		return json({ error: 'Failed to fetch environment notifications' }, { status: 500 });
	}
};

// POST /api/environments/[id]/notifications - Add a notification channel to an environment
/**
 * @openapi
 * summary: Attach a notification channel to an environment
 * description: notificationId from GET /api/notifications.
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {notificationId:integer!, enabled:boolean, eventTypes:array<string>}
 * body-example: {"notificationId":1,"enabled":true,"eventTypes":["stack_deploy_failed"]}
 * resp-200: {id:integer!, notificationId:integer!, enabled:boolean!}
 * resp-400: Invalid environment id, or notificationId missing
 * resp-403: Permission denied (RBAC 'notifications:edit' missing)
 * resp-404: Environment not found
 * resp-409: This notification channel is already configured for this environment
 * resp-500: Unexpected error while creating the notification link
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const envId = parseInt(params.id);
	if (isNaN(envId)) {
		return json({ error: 'Invalid environment ID' }, { status: 400 });
	}

	const env = await getEnvironment(envId);
	if (!env) {
		return json({ error: 'Environment not found' }, { status: 404 });
	}

	try {
		const body = await request.json();
		const { notificationId, enabled, eventTypes } = body;

		if (!notificationId) {
			return json({ error: 'notificationId is required' }, { status: 400 });
		}

		const notification = await createEnvironmentNotification({
			environmentId: envId,
			notificationId,
			enabled: enabled !== false,
			eventTypes: eventTypes as NotificationEventType[]
		});

		return json(notification);
	} catch (error: any) {
		console.error('Error creating environment notification:', error);
		if (error.message?.includes('UNIQUE constraint failed')) {
			return json({ error: 'This notification channel is already configured for this environment' }, { status: 409 });
		}
		return json({ error: error.message || 'Failed to create environment notification' }, { status: 500 });
	}
};

import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getNotificationSetting } from '$lib/server/db';
import { notificationOutbox } from '$lib/server/notifications/outbox';
import { notificationDeliveryView } from '$lib/utils/notification-retries';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List JSON webhook delivery metadata (no payloads or destination credentials)
 * path: id:integer! Notification channel ID
 * query: page:integer Page number, 25 results per page
 * resp-200: {items:array<{}>!, total:integer!, page:integer!, pages:integer!}
 * resp-400: Invalid channel ID or page
 * resp-403: Requires notifications:view and access to the delivery environment
 * resp-404: Notification channel not found
 * resp-500: Could not load notification deliveries
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && (!auth.isAuthenticated || !await auth.can('notifications', 'view'))) return json({ error: 'Permission denied' }, { status: 403 });
	const id = Number(params.id), page = Number(url.searchParams.get('page') ?? 1);
	if (!Number.isSafeInteger(id) || id < 1 || !Number.isInteger(page) || page < 1 || page > 10000) return json({ error: 'Invalid channel ID or page' }, { status: 400 });
	try {
		if (!await getNotificationSetting(id)) return json({ error: 'Notification channel not found' }, { status: 404 });
		const environments = auth.authEnabled ? await auth.getAccessibleEnvironmentIds() : null;
		const result = await notificationOutbox.list(id, page, environments);
		return json({ ...result, items: result.items.map(notificationDeliveryView) });
	} catch { return json({ error: 'Could not load notification deliveries' }, { status: 500 }); }
};

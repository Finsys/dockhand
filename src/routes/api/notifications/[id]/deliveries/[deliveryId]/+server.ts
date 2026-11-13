import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getNotificationSetting } from '$lib/server/db';
import { auditNotification } from '$lib/server/audit';
import { notificationOutbox, resolveNotificationDelivery } from '$lib/server/notifications/outbox';
import { requireNotificationDeliveryAccess } from '$lib/server/notifications/outbox-authorization';
import { notificationRetryPolicy } from '$lib/utils/notification-retries';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Retry a failed JSON webhook delivery, or discard queued work
 * path: id:integer! Notification channel ID
 * path: deliveryId:string! Delivery ID
 * body: {action:string!}
 * resp-200: {success:boolean!}
 * resp-400: Invalid action or channel ID
 * resp-403: Requires notifications:edit and access to the delivery environment
 * resp-404: Delivery not found
 * resp-409: Delivery is in flight, already changed, or its destination is no longer enabled
 * resp-500: Could not update notification delivery
 */
export const POST: RequestHandler = async (event) => {
	const auth = await authorize(event.cookies);
	if (auth.authEnabled && (!auth.isAuthenticated || !await auth.can('notifications', 'edit'))) return json({ error: 'Permission denied' }, { status: 403 });
	const id = Number(event.params.id);
	if (!Number.isSafeInteger(id) || id < 1) return json({ error: 'Invalid channel ID' }, { status: 400 });
	let action: string;
	try { action = (await event.request.json()).action; } catch { return json({ error: 'Invalid JSON action' }, { status: 400 }); }
	if (action !== 'retry' && action !== 'discard') return json({ error: 'Use retry or discard' }, { status: 400 });
	try {
		const row = await notificationOutbox.get(event.params.deliveryId);
		if (!row || row.notificationId !== id) return json({ error: 'Delivery not found' }, { status: 404 });
		const denied = await requireNotificationDeliveryAccess(auth, row, 'edit');
		if (denied) return denied;
		let changed: boolean;
		if (action === 'retry') {
			const setting = await getNotificationSetting(id);
			if (!setting || !await resolveNotificationDelivery(row)) return json({ error: 'Destination is no longer enabled or subscribed' }, { status: 409 });
			const policy = notificationRetryPolicy(setting.config.retry);
			changed = await notificationOutbox.retry(row.id, Date.now(), policy.maxAttempts, policy.maxAgeMinutes);
		} else changed = await notificationOutbox.discard(row.id, Date.now());
		if (!changed) return json({ error: 'Delivery is in flight or already changed' }, { status: 409 });
		await auditNotification(event, 'update', id, String(id), { action, deliveryId: row.id });
		return json({ success: true });
	} catch { return json({ error: 'Could not update notification delivery' }, { status: 500 }); }
};

import { db, notificationDeliveries } from '../db/drizzle';
import { getNotificationSetting, getEnabledEnvironmentNotifications, type NotificationEventType } from '../db';
import { createNotificationOutboxStore } from './outbox-store';
import { createNotificationOutboxWorker } from './outbox-worker';
import { sendStoredGenericWebhook } from './generic-webhook';
import type { NotificationPayload, NotificationResult } from './shared';
import type { NotificationDelivery, NotificationDeliveryScope, NotificationRetryPolicy } from '$lib/utils/notification-retries';
import { createQueuedWebhook, resolveWebhookDestination } from './outbox-model';
export { notificationEventSnapshot } from './outbox-model';

export const notificationOutbox = createNotificationOutboxStore(db, notificationDeliveries);

export async function resolveNotificationDelivery(row: NotificationDelivery): Promise<string | null> {
	return resolveWebhookDestination(row, { setting: getNotificationSetting,
		links: (environmentId, eventType) => getEnabledEnvironmentNotifications(environmentId, eventType as NotificationEventType) });
}

const worker = createNotificationOutboxWorker({ store: notificationOutbox, resolve: resolveNotificationDelivery,
	send: (url, row, signal) => sendStoredGenericWebhook(url, row.body, row, signal) });

export async function deliverQueuedWebhook(notificationId: number, url: string, payload: NotificationPayload,
	policy: NotificationRetryPolicy, scope: NotificationDeliveryScope): Promise<NotificationResult> {
	const row = createQueuedWebhook(notificationId, url, payload, policy, scope);
	try {
		await notificationOutbox.enqueue(row);
		const result = await worker.attempt(row.id);
		if (result?.success || (await notificationOutbox.get(row.id))?.status === 'succeeded') return { success: true };
		return { success: false, error: 'Webhook delivery recorded; inspect delivery history for retry status' };
	} catch {
		// Do not fall back to an unrecorded send or log credential-bearing exceptions.
		return { success: false, error: 'Could not persist webhook delivery (database, queue capacity or payload limit)' };
	}
}

declare global {
	var __notificationOutbox: { timer: ReturnType<typeof setInterval>; running: Promise<void> | null } | undefined;
}

export function startNotificationOutbox(): void {
	if (globalThis.__notificationOutbox) return;
	const state = { timer: undefined as unknown as ReturnType<typeof setInterval>, running: null as Promise<void> | null };
	const tick = () => {
		if (state.running) return;
		state.running = (async () => {
			await notificationOutbox.cleanup(Date.now());
			await Promise.all(Array.from({ length: 4 }, async () => {
				for (let i = 0; i < 8; i++) if (!await worker.attempt()) break;
			}));
		})().catch(() => { console.warn('[Notifications] Webhook delivery worker could not process its queue'); })
			.finally(() => { state.running = null; });
	};
	state.timer = setInterval(tick, 1000);
	globalThis.__notificationOutbox = state;
	tick();
}

export async function stopNotificationOutbox(): Promise<void> {
	const state = globalThis.__notificationOutbox;
	if (!state) return;
	clearInterval(state.timer);
	await state.running;
	globalThis.__notificationOutbox = undefined;
}

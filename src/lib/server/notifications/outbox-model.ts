import { createHash, randomUUID } from 'node:crypto';
import type { NotificationPayload } from './shared';
import { notificationRetryPolicy, type NotificationDelivery, type NotificationDeliveryScope, type NotificationRetryPolicy } from '$lib/utils/notification-retries';

export const webhookDestinationHash = (url: string): string => createHash('sha256').update(url).digest('hex');

export function notificationEventSnapshot(payload: NotificationPayload): NotificationPayload {
	return { ...payload,
		eventId: typeof payload.eventId === 'string' && /^[a-f0-9-]{36}$/i.test(payload.eventId) ? payload.eventId : randomUUID(),
		timestamp: payload.timestamp && Number.isFinite(Date.parse(payload.timestamp)) ? payload.timestamp : new Date().toISOString() };
}

export function createQueuedWebhook(notificationId: number, url: string, payload: NotificationPayload,
	policy: NotificationRetryPolicy, scope: NotificationDeliveryScope, now = Date.now()): NotificationDelivery {
	const event = notificationEventSnapshot(payload), id = randomUUID();
	return { id, eventId: event.eventId!, notificationId, environmentId: event.environmentId ?? null,
		eventType: event.eventType ?? null, scope, destinationHash: webhookDestinationHash(url),
		body: JSON.stringify({ title: event.title, message: event.message, type: event.type || 'info',
			environment: event.environmentName || null, timestamp: event.timestamp, eventType: event.eventType || null,
			eventId: event.eventId, deliveryId: id }),
		status: 'pending', attempts: 0, maxAttempts: policy.maxAttempts, createdAt: now, dueAt: now,
		expiresAt: now + policy.maxAgeMinutes * 60000, retentionDays: policy.retentionDays, finishedAt: null,
		leaseUntil: null, leaseToken: null, lastError: null, httpStatus: null };
}

interface DeliverySetting { enabled: boolean; type: string; eventTypes: string[]; config: { urls: string[]; retry?: unknown } }
export interface DeliveryResolvers {
	setting: (id: number) => Promise<DeliverySetting | null>;
	links: (environmentId: number, eventType: string | null) => Promise<Array<{ notificationId: number }>>;
}

export async function resolveWebhookDestination(row: NotificationDelivery, resolve: DeliveryResolvers): Promise<string | null> {
	const setting = await resolve.setting(row.notificationId);
	if (!setting?.enabled || setting.type !== 'apprise' || !notificationRetryPolicy(setting.config.retry).enabled) return null;
	if (row.scope === 'environment') {
		if (row.environmentId === null || !(await resolve.links(row.environmentId, row.eventType)).some(link => link.notificationId === row.notificationId)) return null;
	} else if (row.scope === 'system' && !setting.eventTypes.includes(row.eventType ?? '')) return null;
	return setting.config.urls.find(url => /^jsons?:\/\//i.test(url) && webhookDestinationHash(url) === row.destinationHash) ?? null;
}

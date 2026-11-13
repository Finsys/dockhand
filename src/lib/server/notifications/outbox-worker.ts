import type { NotificationDelivery, WebhookAttemptResult } from '$lib/utils/notification-retries';
import { webhookRetryDelay } from '$lib/utils/notification-retries';
import type { NotificationOutboxStore } from './outbox-store';

export interface NotificationOutboxDependencies {
	store: NotificationOutboxStore;
	resolve: (row: NotificationDelivery) => Promise<string | null>;
	send: (url: string, row: NotificationDelivery, signal: AbortSignal) => Promise<WebhookAttemptResult>;
	now?: () => number;
	random?: () => number;
}

/** No globals, database initialization or timers: exercise restart recovery with real stores. */
export function createNotificationOutboxWorker(deps: NotificationOutboxDependencies) {
	const now = deps.now ?? Date.now;
	return {
		async attempt(id?: string): Promise<WebhookAttemptResult | null> {
			let row = await deps.store.claim(now(), id);
			if (!row) return null;
			if (row.expiresAt <= now() || row.attempts >= row.maxAttempts) {
				await deps.store.finish(row, { status: 'failed', finishedAt: now(), lastError: row.expiresAt <= now() ? 'Delivery expired' : 'Retry limit reached' });
				return { success: false, retryable: false };
			}
			let url: string | null;
			try { url = await deps.resolve(row); } catch {
				await deps.store.finish(row, { status: 'pending', dueAt: now() + 5000, lastError: 'Destination lookup failed' });
				return { success: false };
			}
			if (!url) {
				await deps.store.finish(row, { status: 'cancelled', finishedAt: now(), lastError: 'Destination disabled, changed or unsubscribed' });
				return { success: false, retryable: false };
			}
			row = await deps.store.attempted(row, now());
			if (!row) return null;
			let result: WebhookAttemptResult;
			// Every attempt ends before its 60-second processing lease. An interrupted
			// acknowledgement may still duplicate a delivery: IDs are stable for deduplication.
			try { result = await deps.send(url, row, AbortSignal.timeout(30000)); }
			catch { result = { success: false, retryable: true }; }
			const finished = now();
			if (result.success) {
				await deps.store.finish(row, { status: 'succeeded', finishedAt: finished, lastError: null, httpStatus: result.status ?? 200 });
			} else {
				const retryable = result.retryable ?? (!result.status || result.status === 408 || result.status === 429 || result.status >= 500);
				const dueAt = finished + webhookRetryDelay(row.attempts, result.retryAfterMs, deps.random);
				const retry = retryable && row.attempts < row.maxAttempts && dueAt < row.expiresAt;
				await deps.store.finish(row, { status: retry ? 'pending' : 'failed', dueAt, finishedAt: retry ? null : finished,
					httpStatus: result.status ?? null, lastError: !retryable ? 'Permanent delivery failure' : row.attempts >= row.maxAttempts ? 'Retry limit reached' : dueAt >= row.expiresAt ? 'Delivery expired' : result.status === 429 ? 'Rate limited' : 'Temporary delivery failure' });
			}
			return result;
		},
		async drain(limit = 25): Promise<void> {
			await deps.store.cleanup(now());
			for (let i = 0; i < limit; i++) if (!await this.attempt()) break;
		}
	};
}

/** Shared configuration and safe delivery metadata; no channel URLs or credentials. */
export interface NotificationRetryPolicy {
	enabled: boolean;
	maxAttempts: number;
	maxAgeMinutes: number;
	retentionDays: number;
}

export const DEFAULT_NOTIFICATION_RETRY_POLICY: NotificationRetryPolicy = {
	enabled: false, maxAttempts: 10, maxAgeMinutes: 1440, retentionDays: 7
};

export function notificationRetryPolicy(value: unknown): NotificationRetryPolicy {
	if (value === undefined) return { ...DEFAULT_NOTIFICATION_RETRY_POLICY };
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid webhook retry policy');
	const input = value as Record<string, unknown>;
	if (typeof input.enabled !== 'boolean') throw new Error('Webhook retry enabled must be a boolean');
	const policy = { ...DEFAULT_NOTIFICATION_RETRY_POLICY, ...input };
	for (const [key, maximum] of [['maxAttempts', 20], ['maxAgeMinutes', 10080], ['retentionDays', 30]] as const) {
		if (!Number.isInteger(policy[key]) || Number(policy[key]) < 1 || Number(policy[key]) > maximum) {
			throw new Error(`Webhook retry ${key} must be an integer between 1 and ${maximum}`);
		}
	}
	return { enabled: input.enabled, maxAttempts: Number(policy.maxAttempts), maxAgeMinutes: Number(policy.maxAgeMinutes), retentionDays: Number(policy.retentionDays) };
}

export type NotificationDeliveryStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' | 'discarded';
export type NotificationDeliveryScope = 'broadcast' | 'environment' | 'system';

export interface NotificationDelivery {
	id: string;
	eventId: string;
	notificationId: number;
	environmentId: number | null;
	eventType: string | null;
	scope: NotificationDeliveryScope;
	destinationHash: string;
	body: string;
	status: NotificationDeliveryStatus;
	attempts: number;
	maxAttempts: number;
	createdAt: number;
	dueAt: number;
	expiresAt: number;
	retentionDays: number;
	finishedAt: number | null;
	leaseUntil: number | null;
	leaseToken: string | null;
	lastError: string | null;
	httpStatus: number | null;
}

export type NotificationDeliveryView = Omit<NotificationDelivery, 'body' | 'destinationHash' | 'leaseToken' | 'leaseUntil'>;

export interface WebhookAttemptResult {
	success: boolean;
	status?: number;
	retryAfterMs?: number;
	retryable?: boolean;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
	const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
	return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 7 * 86400_000) : undefined;
}

export function webhookRetryDelay(attempts: number, retryAfterMs?: number, random = Math.random): number {
	const steps = [5000, 15000, 45000, 120000, 300000, 900000];
	const jittered = Math.round(steps[Math.min(Math.max(attempts - 1, 0), steps.length - 1)] * (0.9 + 0.2 * random()));
	return Math.max(jittered, retryAfterMs ?? 0);
}

/** Never expose response bodies, destination URLs, exceptions or hashes in history. */
export function notificationDeliveryView(row: NotificationDelivery): NotificationDeliveryView {
	const { body: _body, destinationHash: _hash, leaseToken: _token, leaseUntil: _lease, ...view } = row;
	return view;
}

/** Generic JSON webhook. json:// or jsons:// (HTTPS); json://user:pass@host/path sends Basic auth. */
import { notificationFetch, drainResponse, splitBasicAuth, type NotificationPayload, type NotificationResult } from './shared';
import { NotificationEndpointError, notificationTimeoutSignal } from './shared';
import { retryAfterMilliseconds, type WebhookAttemptResult } from '$lib/utils/notification-retries';

export async function sendGenericWebhook(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// json://hostname/path or jsons://hostname/path
	const scheme = appriseUrl.startsWith('jsons') ? 'https://' : 'http://';
	const rest = appriseUrl.replace(/^jsons?:\/\//, '');
	const authorityEnd = rest.search(/[/?#]/);
	const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
	const remainder = authorityEnd === -1 ? '' : rest.slice(authorityEnd);

	let host: string;
	let authHeader: string | null;
	try {
		({ host, authHeader } = splitBasicAuth(authority));
	} catch (error) {
		return { success: false, error: `Invalid webhook URL: ${error instanceof Error ? error.message : String(error)}` };
	}
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (authHeader) headers['Authorization'] = authHeader;

	try {
		const response = await notificationFetch(`${scheme}${host}${remainder}`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				title: payload.title,
				message: payload.message,
				type: payload.type || 'info',
				environment: payload.environmentName || null,
				timestamp: new Date().toISOString()
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Webhook error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Webhook connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Durable delivery uses the frozen JSON verbatim. Never retain provider bodies or URLs as errors. */
export async function sendStoredGenericWebhook(
	appriseUrl: string,
	body: string,
	ids: { eventId: string; id: string },
	signal: AbortSignal
): Promise<WebhookAttemptResult> {
	if (!/^jsons?:\/\//i.test(appriseUrl)) return { success: false, retryable: false };
	const scheme = /^jsons:\/\//i.test(appriseUrl) ? 'https://' : 'http://';
	const rest = appriseUrl.replace(/^jsons?:\/\//i, '');
	const end = rest.search(/[/?#]/);
	const authority = end === -1 ? rest : rest.slice(0, end);
	const remainder = end === -1 ? '' : rest.slice(end);
	let target: string;
	const headers: Record<string, string> = { 'Content-Type': 'application/json',
		'X-Dockhand-Event-Id': ids.eventId, 'X-Dockhand-Delivery-Id': ids.id };
	try {
		const { host, authHeader } = splitBasicAuth(authority);
		target = `${scheme}${host}${remainder}`;
		if (authHeader) headers.Authorization = authHeader;
	} catch { return { success: false, retryable: false }; }
	try {
		const result = await notificationFetch(target, { method: 'POST', headers, body, signal: notificationTimeoutSignal(signal) });
		const retryAfterMs = retryAfterMilliseconds(result.headers.get('retry-after'));
		await drainResponse(result);
		return { success: result.ok, status: result.status, retryAfterMs,
			retryable: result.status === 408 || result.status === 429 || result.status >= 500 };
	} catch (error) {
		return { success: false, retryable: !(error instanceof NotificationEndpointError) };
	}
}

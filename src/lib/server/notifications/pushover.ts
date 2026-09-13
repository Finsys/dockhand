/** Pushover. pushover://user_key/api_token[/device...] or pover://user_key@api_token[/device...]. */
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';
import { parsePushoverUrl } from '$lib/utils/notification-parsers';

export async function sendPushover(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	const parsed = parsePushoverUrl(appriseUrl);
	if (!parsed) {
		return { success: false, error: 'Invalid Pushover URL format. Expected: pushover://user_key/api_token[/device]' };
	}

	const { userKey, apiToken, device } = parsed;
	const url = 'https://api.pushover.net/1/messages.json';
	const titleWithEnv = payload.environmentName ? `${payload.title} [${payload.environmentName}]` : payload.title;

	try {
		const response = await notificationFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: apiToken,
				user: userKey,
				title: titleWithEnv,
				message: payload.message,
				priority: payload.type === 'error' ? 1 : 0,
				// Optional: a comma-separated device list restricts delivery; omit to reach all devices.
				...(device ? { device } : {})
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Pushover error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Pushover connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

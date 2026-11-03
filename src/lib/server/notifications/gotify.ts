/** Gotify. gotify:// or gotifys:// (HTTPS). */
import { buildGotifyUrl } from '$lib/utils/notification-parsers';
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

export async function sendGotify(appriseUrl: string, payload: NotificationPayload, skipTlsVerify = false): Promise<NotificationResult> {
	const parsed = buildGotifyUrl(appriseUrl);
	if (!parsed) {
		return { success: false, error: 'Invalid Gotify URL format. Expected: gotify://hostname/token' };
	}

	const titleWithEnv = payload.environmentName ? `${payload.title} [${payload.environmentName}]` : payload.title;
	const defaultPriority = payload.type === 'error' ? 8 : payload.type === 'warning' ? 5 : 2;

	try {
		const response = await notificationFetch(parsed.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: titleWithEnv,
				message: payload.message,
				priority: parsed.priority ?? defaultPriority
			})
		}, skipTlsVerify);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Gotify error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Gotify connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

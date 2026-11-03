/** Discord webhook notifications. discord:// or discords://. */
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

export async function sendDiscord(appriseUrl: string, payload: NotificationPayload, skipTlsVerify = false): Promise<NotificationResult> {
	// discord://webhook_id/webhook_token or discords://...
	const url = appriseUrl.replace(/^discords?:\/\//, 'https://discord.com/api/webhooks/');
	const titleWithEnv = payload.environmentName ? `${payload.title} [${payload.environmentName}]` : payload.title;

	try {
		const response = await notificationFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				embeds: [{
					title: titleWithEnv,
					description: payload.message,
					color: payload.type === 'error' ? 0xff0000 : payload.type === 'warning' ? 0xffaa00 : payload.type === 'success' ? 0x00ff00 : 0x0099ff,
					...(payload.environmentName && {
						footer: { text: `Environment: ${payload.environmentName}` }
					})
				}]
			})
		}, skipTlsVerify);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Discord error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Discord connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

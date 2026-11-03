/** Slack incoming webhook. slack:// or slacks:// or a raw hooks.slack.com URL. */
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

export async function sendSlack(appriseUrl: string, payload: NotificationPayload, skipTlsVerify = false): Promise<NotificationResult> {
	// slack://token_a/token_b/token_c or webhook URL
	let url: string;
	if (appriseUrl.includes('hooks.slack.com')) {
		url = appriseUrl.replace(/^slacks?:\/\//, 'https://');
	} else {
		const parts = appriseUrl.replace(/^slacks?:\/\//, '').split('/');
		url = `https://hooks.slack.com/services/${parts.join('/')}`;
	}

	const envTag = payload.environmentName ? ` \`${payload.environmentName}\`` : '';

	try {
		const response = await notificationFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				text: `*${payload.title}*${envTag}\n${payload.message}`
			})
		}, skipTlsVerify);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Slack error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Slack connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

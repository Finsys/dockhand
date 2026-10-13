/** Mattermost incoming webhook. mmost:// or mmosts:// (HTTPS). */
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

/** Severity colours, matching the Discord embed so the two channels read alike. */
const ATTACHMENT_COLORS: Record<string, string> = {
	error: '#FF0000',
	warning: '#FFAA00',
	success: '#00FF00',
	info: '#0099FF'
};

/**
 * The webhook body for one notification.
 *
 * Mattermost accepts Slack-style attachments, which carry a severity colour and a
 * footer the plain `text` form cannot. The attachment replaces `text` rather than
 * accompanying it - Mattermost renders both, so sending both shows the message
 * twice (#1607). `fallback` is what push notifications and email digests read, so
 * it carries the message for anyone not looking at the channel.
 */
export function buildMattermostBody(
	payload: NotificationPayload,
	username?: string,
	nowSeconds: number = Math.floor(Date.now() / 1000)
): Record<string, unknown> {
	const title = payload.environmentName
		? `${payload.title} [${payload.environmentName}]`
		: payload.title;

	const body: Record<string, unknown> = {
		attachments: [
			{
				color: ATTACHMENT_COLORS[payload.type ?? 'info'] ?? ATTACHMENT_COLORS.info,
				fallback: `${title}\n${payload.message}`,
				title,
				text: payload.message,
				mrkdwn_in: ['text', 'pretext'],
				ts: nowSeconds,
				...(payload.environmentName && { footer: `Environment: ${payload.environmentName}` })
			}
		]
	};
	if (username) body.username = username;
	return body;
}

export async function sendMattermost(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// mmost://[botname@]hostname[:port][/path]/token or mmosts://...
	const isSecure = appriseUrl.startsWith('mmosts');
	const protocol = isSecure ? 'https' : 'http';

	let urlPart = appriseUrl.replace(/^mmosts?:\/\//, '');

	// Check for botname (username@hostname format)
	let username: string | undefined;
	const atIndex = urlPart.indexOf('@');
	if (atIndex !== -1) {
		username = urlPart.substring(0, atIndex);
		urlPart = urlPart.substring(atIndex + 1);
	}

	// The token is the last segment, everything else is hostname[:port][/path]
	const lastSlashIndex = urlPart.lastIndexOf('/');
	if (lastSlashIndex === -1) {
		return { success: false, error: 'Invalid Mattermost URL format. Expected: mmost://[botname@]hostname[:port][/path]/token' };
	}

	const token = urlPart.substring(lastSlashIndex + 1);
	const hostAndPath = urlPart.substring(0, lastSlashIndex);

	const url = `${protocol}://${hostAndPath}/hooks/${token}`;

	const body = buildMattermostBody(payload, username);

	try {
		const response = await notificationFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Mattermost error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Mattermost connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

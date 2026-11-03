/** Telegram bot. tgram://bot_token/chat_id[:topic_id]. */
import { escapeTelegramMarkdown, parseTelegramUrl } from '$lib/utils/notification-parsers';
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

export async function sendTelegram(appriseUrl: string, payload: NotificationPayload, skipTlsVerify = false): Promise<NotificationResult> {
	const parsed = parseTelegramUrl(appriseUrl);
	if (!parsed) {
		return { success: false, error: 'Invalid Telegram URL format. Expected: tgram://bot_token/chat_id or tgram://bot_token/chat_id:topic_id' };
	}

	const { botToken, chatId, topicId } = parsed;
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

	const escapedTitle = escapeTelegramMarkdown(payload.title);
	const escapedMessage = escapeTelegramMarkdown(payload.message);
	const envTag = payload.environmentName ? ` [${escapeTelegramMarkdown(payload.environmentName)}]` : '';

	try {
		const response = await notificationFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `*${escapedTitle}*${envTag}\n${escapedMessage}`,
				...(topicId ? { message_thread_id: topicId } : {}),
				parse_mode: 'Markdown',
				link_preview_options: {
					is_disabled: true
				}
			})
		}, skipTlsVerify);

		if (!response.ok) {
			const errorData = await response.json().catch(() => ({})) as { description?: string };
			const errorMsg = errorData.description || response.statusText;
			return { success: false, error: `Telegram error ${response.status}: ${errorMsg}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Telegram connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

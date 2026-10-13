/** Generic JSON webhook. json:// or jsons:// (HTTPS); json://user:pass@host/path sends Basic auth. */
import { notificationFetch, drainResponse, splitBasicAuth, type NotificationPayload, type NotificationResult } from './shared';

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

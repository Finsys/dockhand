/**
 * Signal — via bbernhard/signal-cli-rest-api
 * (https://github.com/bbernhard/signal-cli-rest-api).
 *
 * Supported formats:
 *   signal://host[:port]/+source/+target1[/+target2/...]
 *   signals://host[:port]/+source/+target1[/+target2/...]   (HTTPS)
 *
 * `+source` is the sender's registered Signal number (E.164 format). The '+'
 * is optional in the URL — we re-add it. Recipients can be Signal phone
 * numbers (numeric, '+' gets added) or group IDs (signal-cli's "group.<base64>"
 * form, passed through untouched).
 */
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

export async function sendSignal(appriseUrl: string, payload: NotificationPayload, skipTlsVerify = false): Promise<NotificationResult> {
	const isSecure = appriseUrl.startsWith('signals');
	const raw = appriseUrl.replace(/^signals?:\/\//, '');

	// Strip query string so a future `?foo=bar` doesn't end up in the last
	// recipient. Currently we don't honor any params, but the parsing should
	// be forward-compatible.
	const qIndex = raw.indexOf('?');
	const cleanPath = qIndex === -1 ? raw : raw.substring(0, qIndex);

	const parts = cleanPath.split('/').filter(Boolean);
	if (parts.length < 3) {
		return { success: false, error: 'Invalid Signal URL. Expected: signal://host[:port]/+source/+target1[/+target2/...]' };
	}
	const hostPort = parts[0];

	// Phone numbers may or may not start with '+' in the URL — Signal needs
	// the '+'. Group IDs (signal-cli's "group.<base64>" form) and other
	// non-numeric recipients are passed through untouched.
	const normalize = (n: string) => {
		if (n.startsWith('+')) return n;
		if (/^\d+$/.test(n)) return `+${n}`;
		return n;
	};
	const source = normalize(parts[1]);
	const recipients = parts.slice(2).map(normalize);

	// signal-cli-rest-api uses 'message' for body and 'number' for sender;
	// title is prepended to the body since Signal messages don't have a title field.
	const titleWithEnv = payload.environmentName
		? `${payload.title} [${payload.environmentName}]`
		: payload.title;
	const messageText = `${titleWithEnv}\n\n${payload.message}`;

	const baseUrl = `${isSecure ? 'https' : 'http'}://${hostPort}`;
	try {
		const response = await notificationFetch(`${baseUrl}/v2/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				number: source,
				recipients,
				message: messageText
			})
		}, skipTlsVerify);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Signal error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Signal connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

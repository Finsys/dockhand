/**
 * Apprise passthrough — POST to a self-hosted caronc/apprise-api server.
 *
 * Users configure all their providers (Signal, Matrix, MQTT, IFTTT, AWS SNS,
 * dozens more) in their own Apprise server; Dockhand just forwards each
 * notification once. The big win: every provider Apprise upstream supports
 * is now reachable from Dockhand without us having to write a sender for it.
 *
 * Supported formats:
 *   apprise://host[:port]/key                 → HTTP, stateful (Apprise stored config key)
 *   apprises://host[:port]/key                → HTTPS variant
 *   apprise://host[:port]/prefix/key          → path-prefixed Apprise behind a reverse proxy
 *   apprise://host[:port]/key?tag=devops      → optional tag filter
 *   apprise://user:pass@host[:port]/key       - HTTP Basic auth (sent as a header)
 *
 * Setup docs: https://github.com/caronc/apprise-api
 */
import { notificationFetch, drainResponse, splitBasicAuth, type NotificationPayload, type NotificationResult } from './shared';

export async function sendApprise(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	const isSecure = appriseUrl.startsWith('apprises');
	const raw = appriseUrl.replace(/^apprises?:\/\//, '');

	let cleanPath = raw;
	let queryParams = new URLSearchParams();
	const qIndex = raw.indexOf('?');
	if (qIndex !== -1) {
		queryParams = new URLSearchParams(raw.substring(qIndex + 1));
		cleanPath = raw.substring(0, qIndex);
	}

	const parts = cleanPath.split('/').filter(Boolean);
	if (parts.length < 2) {
		return { success: false, error: 'Invalid Apprise URL. Expected: apprise://host[:port]/key' };
	}
	let hostPort: string;
	let authHeader: string | null;
	try {
		({ host: hostPort, authHeader } = splitBasicAuth(parts[0]));
	} catch (error) {
		return { success: false, error: `Invalid Apprise URL: ${error instanceof Error ? error.message : String(error)}` };
	}
	// The Apprise key is the last path segment. Anything between host and key
	// is a path prefix (some users mount Apprise behind a reverse proxy
	// at /apprise/ — we preserve that).
	const key = parts[parts.length - 1];
	const pathPrefix = parts.slice(1, -1).join('/');
	const baseUrl = `${isSecure ? 'https' : 'http'}://${hostPort}${pathPrefix ? '/' + pathPrefix : ''}`;

	// Map our payload type to Apprise's NotifyType. 'error' → 'failure' is
	// the only rename; everything else lines up.
	const apprisesType = payload.type === 'error'
		? 'failure'
		: payload.type === 'warning'
			? 'warning'
			: payload.type === 'success'
				? 'success'
				: 'info';

	const titleWithEnv = payload.environmentName
		? `${payload.title} [${payload.environmentName}]`
		: payload.title;

	const body: Record<string, unknown> = {
		title: titleWithEnv,
		body: payload.message,
		type: apprisesType
	};
	const tag = queryParams.get('tag');
	if (tag) body.tag = tag;
	const format = queryParams.get('format');
	if (format) body.format = format; // text | markdown | html

	try {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (authHeader) headers['Authorization'] = authHeader;
		const response = await notificationFetch(`${baseUrl}/notify/${encodeURIComponent(key)}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		});

		// Apprise-API uses specific status codes:
		//   200 → success, 204 → key not configured, 424 → at least one
		//   downstream provider failed or tag didn't match.
		if (response.status === 204) {
			return { success: false, error: `Apprise: no configuration found for key "${key}"` };
		}
		if (response.status === 424) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Apprise: at least one downstream provider failed${text ? ` — ${text}` : ''}` };
		}
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Apprise error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `Apprise connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

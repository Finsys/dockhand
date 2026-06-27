/** ntfy.sh + self-hosted ntfy. ntfy:// or ntfys:// (HTTPS). */
import { drainResponse, type NotificationPayload, type NotificationResult } from './shared';

// HTTP header values must be ByteString (every char ≤ 0xFF). Reject anything
// else so we never blow up fetch() with a 65533 (U+FFFD) replacement char.
function isHeaderSafe(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 0xff) return false;
	}
	return true;
}

// ?auth= accepts either a raw ntfy access token (typically `tk_...`) or a
// base64-encoded `Bearer <token>` / `Basic <creds>` string. We try base64 first
// only when the input looks plausibly base64; if decoding produces non-ASCII
// garbage we fall back to treating the value as a raw token.
export function resolveQueryAuth(queryAuth: string): string {
	if (queryAuth.startsWith('tk_')) {
		return `Bearer ${queryAuth}`;
	}
	const looksBase64 = /^[A-Za-z0-9+/=_-]+$/.test(queryAuth);
	if (looksBase64) {
		const decoded = Buffer.from(queryAuth, 'base64').toString();
		if (isHeaderSafe(decoded) && (decoded.startsWith('Bearer ') || decoded.startsWith('Basic '))) {
			return decoded;
		}
	}
	return `Bearer ${queryAuth}`;
}

export async function sendNtfy(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// Supported formats:
	// ntfy://topic (public ntfy.sh)
	// ntfy://host/topic (custom server, no auth)
	// ntfy://user:pass@host/topic (custom server with basic auth)
	// ntfy://token@host/topic (custom server with bearer token)
	// ntfy://host/topic?auth=TOKEN (raw token, e.g. tk_..., or base64-encoded "Bearer <token>")
	// Query params: ?tags=ship,whale &title=Custom &priority=5
	// ntfys:// variants for HTTPS
	const isSecure = appriseUrl.startsWith('ntfys');
	const path = appriseUrl.replace(/^ntfys?:\/\//, '');

	let url: string;
	let authHeader: string | null = null;

	let queryAuth: string | null = null;
	let queryTags: string | null = null;
	let queryTitle: string | null = null;
	let queryPriority: string | null = null;
	let cleanPath = path;
	const qIndex = path.indexOf('?');
	if (qIndex !== -1) {
		const params = new URLSearchParams(path.substring(qIndex + 1));
		queryAuth = params.get('auth');
		queryTags = params.get('tags');
		queryTitle = params.get('title');
		queryPriority = params.get('priority');
		cleanPath = path.substring(0, qIndex);
	}

	const basicMatch = cleanPath.match(/^([^:]+):([^@]+)@(.+)$/);
	if (basicMatch) {
		const [, user, pass, hostAndTopic] = basicMatch;
		const basic = Buffer.from(`${user}:${pass}`).toString('base64');
		authHeader = `Basic ${basic}`;
		url = `${isSecure ? 'https' : 'http'}://${hostAndTopic}`;
	} else if (cleanPath.includes('@') && cleanPath.includes('/')) {
		const tokenMatch = cleanPath.match(/^([^@]+)@(.+)$/);
		if (tokenMatch) {
			const [, token, hostAndTopic] = tokenMatch;
			authHeader = `Bearer ${token}`;
			url = `${isSecure ? 'https' : 'http'}://${hostAndTopic}`;
		} else {
			url = `${isSecure ? 'https' : 'http'}://${cleanPath}`;
		}
	} else if (cleanPath.includes('/')) {
		url = `${isSecure ? 'https' : 'http'}://${cleanPath}`;
	} else {
		url = `https://ntfy.sh/${cleanPath}`;
	}

	if (!authHeader && queryAuth) {
		authHeader = resolveQueryAuth(queryAuth);
	}

	const titleWithEnv = payload.environmentName ? `${payload.title} [${payload.environmentName}]` : payload.title;
	const defaultTags = payload.type || 'info';
	const headers: Record<string, string> = {
		'Title': queryTitle || titleWithEnv,
		'Priority': queryPriority || (payload.type === 'error' ? '5' : payload.type === 'warning' ? '4' : '3'),
		'Tags': queryTags ? `${queryTags},${defaultTags}` : defaultTags
	};

	if (authHeader) {
		headers['Authorization'] = authHeader;
	}

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: payload.message
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `ntfy error ${response.status}: ${text || response.statusText}` };
		}
		await drainResponse(response);
		return { success: true };
	} catch (error) {
		return { success: false, error: `ntfy connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

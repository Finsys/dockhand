/** ntfy.sh + self-hosted ntfy. ntfy:// or ntfys:// (HTTPS). */
import { notificationFetch, drainResponse, type NotificationPayload, type NotificationResult } from './shared';

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

/**
 * Resolve an Apprise-style ntfy URL to the actual HTTP(S) publish endpoint and any
 * auth header derived from the path. Pure + exported so the endpoint building —
 * where the trailing-slash 404 bug lived (#1300) — is unit-testable without fetch.
 *
 * Supported forms:
 *   ntfy://topic                       → https://ntfy.sh/topic   (public)
 *   ntfy://host/topic                  → http://host/topic
 *   ntfy://user:pass@host/topic        → http(s), Basic auth
 *   ntfy://token@host/topic            → http(s), Bearer auth
 *   ntfys:// variants                  → https
 * A trailing slash on the topic is stripped: ntfy 404s POST /topic/ (distinct route
 * from POST /topic), while Apprise tolerates it — so we normalise it away.
 */
export function resolveNtfyEndpoint(cleanPath: string, isSecure: boolean): { url: string; authHeader: string | null } {
	// ntfy treats POST /topic and POST /topic/ as DIFFERENT routes — the latter 404s
	// with {"code":40401,"http":404,"error":"page not found"} (#1300). Strip it.
	cleanPath = cleanPath.replace(/\/+$/, '');

	const basicMatch = cleanPath.match(/^([^:]+):([^@]+)@(.+)$/);
	if (basicMatch) {
		const [, user, pass, hostAndTopic] = basicMatch;
		const basic = Buffer.from(`${user}:${pass}`).toString('base64');
		return { url: `${isSecure ? 'https' : 'http'}://${hostAndTopic}`, authHeader: `Basic ${basic}` };
	}
	if (cleanPath.includes('@') && cleanPath.includes('/')) {
		const tokenMatch = cleanPath.match(/^([^@]+)@(.+)$/);
		if (tokenMatch) {
			const [, token, hostAndTopic] = tokenMatch;
			return { url: `${isSecure ? 'https' : 'http'}://${hostAndTopic}`, authHeader: `Bearer ${token}` };
		}
		return { url: `${isSecure ? 'https' : 'http'}://${cleanPath}`, authHeader: null };
	}
	if (cleanPath.includes('/')) {
		return { url: `${isSecure ? 'https' : 'http'}://${cleanPath}`, authHeader: null };
	}
	return { url: `https://ntfy.sh/${cleanPath}`, authHeader: null };
}

export async function sendNtfy(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// Query params: ?auth=TOKEN &tags=ship,whale &title=Custom &priority=5 &email=me@example.com
	const isSecure = appriseUrl.startsWith('ntfys');
	const path = appriseUrl.replace(/^ntfys?:\/\//, '');

	let queryAuth: string | null = null;
	let queryTags: string | null = null;
	let queryTitle: string | null = null;
	let queryPriority: string | null = null;
	let queryEmail: string | null = null;
	let cleanPath = path;
	const qIndex = path.indexOf('?');
	if (qIndex !== -1) {
		const params = new URLSearchParams(path.substring(qIndex + 1));
		queryAuth = params.get('auth');
		queryTags = params.get('tags');
		queryTitle = params.get('title');
		queryPriority = params.get('priority');
		queryEmail = params.get('email');
		cleanPath = path.substring(0, qIndex);
	}

	const endpoint = resolveNtfyEndpoint(cleanPath, isSecure);
	const url = endpoint.url;
	let authHeader = endpoint.authHeader;

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

	// ?email=<address> → ntfy's Email header so ntfy forwards the message as email (#1231)
	if (queryEmail && isHeaderSafe(queryEmail)) {
		headers['Email'] = queryEmail;
	}

	try {
		const response = await notificationFetch(url, {
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

// Pure parsing/building functions for notification providers.
// Extracted from notifications.ts so unit tests can import without pulling in DB deps.

// --- Telegram ---

// Escape special characters for Telegram legacy Markdown (parse_mode: 'Markdown')
// Only _ * ` [ need escaping — ] and other chars are not special in legacy mode
export function escapeTelegramMarkdown(text: string): string {
	return text
		.replace(/_/g, '\\_')    // Underscore (italic)
		.replace(/\*/g, '\\*')   // Asterisk (bold)
		.replace(/`/g, '\\`')   // Backtick (code)
		.replace(/\[/g, '\\[');  // Opening bracket (link)
}

export function parseTelegramUrl(url: string): { botToken: string; chatId: string; topicId?: number } | null {
	const match = url.match(/^tgram:\/\/([^/]+)\/([^:\/]+)(?::(\d+))?$/);
	if (!match) return null;
	const [, botToken, chatId, topicIdStr] = match;
	return { botToken, chatId, topicId: topicIdStr ? parseInt(topicIdStr, 10) : undefined };
}

// --- Gotify ---

export function buildGotifyUrl(appriseUrl: string): { url: string; priority?: number } | null {
	// Strip query params before parsing path
	const qIdx = appriseUrl.indexOf('?');
	const baseUrl = qIdx >= 0 ? appriseUrl.substring(0, qIdx) : appriseUrl;
	const queryStr = qIdx >= 0 ? appriseUrl.substring(qIdx + 1) : '';

	const match = baseUrl.match(/^gotifys?:\/\/([^/]+)\/(.+)/);
	if (!match) return null;
	const [, hostname, pathPart] = match;
	const protocol = appriseUrl.startsWith('gotifys') ? 'https' : 'http';
	const lastSlash = pathPart.lastIndexOf('/');
	const subpath = lastSlash >= 0 ? pathPart.substring(0, lastSlash) : '';
	const token = lastSlash >= 0 ? pathPart.substring(lastSlash + 1) : pathPart;

	// Parse priority from query params
	let priority: number | undefined;
	if (queryStr) {
		const params = new URLSearchParams(queryStr);
		const p = params.get('priority');
		if (p) {
			const num = parseInt(p);
			if (!isNaN(num) && num >= 0 && num <= 10) priority = num;
		}
	}

	return {
		url: `${protocol}://${hostname}${subpath ? '/' + subpath : ''}/message?token=${token}`,
		priority
	};
}

// --- Pushover ---

/**
 * Parse a Pushover apprise URL into its parts. Two accepted schemes, both with
 * an OPTIONAL trailing device list (backward compatible - existing
 * pushover://user/token URLs parse with device undefined):
 *   pushover://user_key/api_token[/device1[/device2...]]
 *   pover://user_key@api_token[/device1[/device2...]]   (Apprise-native form)
 * The Pushover API `device` field is a comma-separated list, so multiple path
 * segments are joined with commas. Returns null on a malformed URL.
 */
export function parsePushoverUrl(
	url: string
): { userKey: string; apiToken: string; device?: string } | null {
	let userKey: string;
	let apiToken: string;
	let rest: string;

	const pover = url.match(/^pover:\/\/([^/@]+)@([^/]+)(?:\/(.*))?$/);
	if (pover) {
		[, userKey, apiToken, rest = ''] = pover;
	} else {
		const push = url.match(/^pushover:\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
		if (!push) return null;
		[, userKey, apiToken, rest = ''] = push;
	}

	if (!userKey || !apiToken) return null;
	const devices = rest.split('/').map((d) => d.trim()).filter(Boolean);
	return { userKey, apiToken, device: devices.length ? devices.join(',') : undefined };
}

// --- Workflows (Microsoft Power Automate) ---

export function parseWorkflowsUrl(appriseUrl: string): { hostname: string; workflow: string; signature: string } | null {
	const match = appriseUrl.match(/^workflows?:\/\/([^/]+)\/(.+)\/(.+)/);
	if (!match) return null;
	const [, hostname, workflow, signature] = match;
	return { hostname, workflow, signature };
}

export function buildWorkflowsHttpUrl(hostname: string, workflow: string, signature: string): string {
	return `https://${hostname}/powerautomate/automations/direct/workflows/${workflow}/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${signature}`;
}

/**
 * Resolve a `workflows://` channel URL to the HTTPS endpoint to POST to.
 *
 * Two input shapes are accepted:
 *  1. A COMPLETE webhook URL with the schema swapped to `workflows://` - i.e. it
 *     already carries the full `/.../triggers/manual/paths/invoke?...&sig=...` path
 *     and query. Microsoft has changed this path over time (legacy logic.azure.com,
 *     then `/powerautomate/automations/direct/`, then a `/cu/<n>/` segment on
 *     *.powerplatform.com - #1512). We must NOT rebuild it from parts, or new
 *     segments and query params (api-version, cu/<n>) get dropped -> 401. So when the
 *     input already has the invoke path + a sig, pass the path and query through
 *     verbatim, only swapping the scheme to https.
 *  2. The SHORT legacy form `workflows://host/<workflow>/<signature>` (what the UI
 *     hint documents). No invoke path, so reconstruct the endpoint as before.
 *
 * Returns the https URL, or null when the input is neither shape.
 */
export function resolveWorkflowsHttpUrl(appriseUrl: string): string | null {
	const schemeMatch = appriseUrl.match(/^workflows?:\/\/(.*)$/is);
	if (!schemeMatch) return null;
	const rest = schemeMatch[1];

	// Shape 1: a full webhook URL - it carries the invoke path. Pass it through
	// verbatim (only when it also has a sig=, else it's an unsigned/invalid webhook)
	// so any host/path/query shape Microsoft uses survives. An invoke path present but
	// no sig is invalid - do NOT fall through to short-form parsing, which would shred
	// the path into a bogus workflow/signature.
	if (/\/triggers\/manual\/paths\/invoke/i.test(rest)) {
		return /[?&]sig=[^&]/i.test(rest) ? `https://${rest}` : null;
	}

	// Shape 2: the short legacy form host/<workflow>/<signature>.
	const parsed = parseWorkflowsUrl(appriseUrl);
	if (!parsed) return null;
	return buildWorkflowsHttpUrl(parsed.hostname, parsed.workflow, parsed.signature);
}

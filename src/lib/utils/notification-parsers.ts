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

export function buildGotifyUrl(appriseUrl: string): string | null {
	const match = appriseUrl.match(/^gotifys?:\/\/([^/]+)\/(.+)/);
	if (!match) return null;
	const [, hostname, pathPart] = match;
	const protocol = appriseUrl.startsWith('gotifys') ? 'https' : 'http';
	const lastSlash = pathPart.lastIndexOf('/');
	const subpath = lastSlash >= 0 ? pathPart.substring(0, lastSlash) : '';
	const token = lastSlash >= 0 ? pathPart.substring(lastSlash + 1) : pathPart;
	return `${protocol}://${hostname}${subpath ? '/' + subpath : ''}/message?token=${token}`;
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

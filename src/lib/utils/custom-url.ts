export interface ParsedCustomUrl {
	url: string;
	name?: string;
}

/**
 * Parse a custom URL value that may be in markdown link format.
 * Supports:
 *   - Plain URL: "https://example.com" → { url: "https://example.com" }
 *   - Markdown link: "[My App](https://example.com)" → { url: "https://example.com", name: "My App" }
 * Returns null if value is empty/missing.
 */
export function parseCustomUrl(value: string | undefined | null): ParsedCustomUrl | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	const match = trimmed.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
	if (match) {
		return { name: match[1].trim(), url: ensureProtocol(match[2].trim()) };
	}

	return { url: ensureProtocol(trimmed) };
}

function ensureProtocol(url: string): string {
	if (/^https?:\/\//i.test(url)) return url;
	return `https://${url}`;
}

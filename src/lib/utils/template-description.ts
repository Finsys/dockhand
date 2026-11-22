/**
 * Render a third-party template description (from a Portainer catalog) for
 * display via {@html}.
 *
 * The input is untrusted, so: HTML tags are stripped, and markdown links are
 * rebuilt only for safe http(s)/relative URLs — javascript:/data:/etc. are
 * dropped (keeping just the link text) to prevent a `[x](javascript:...)` XSS.
 */

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Only http(s) and relative URLs are safe to put in href; reject javascript:,
// data:, etc.
export function isSafeLinkUrl(url: string): boolean {
	// Browsers ignore ASCII whitespace/control chars when parsing the scheme, so
	// strip them before checking (defeats java\tscript: style bypasses).
	const cleaned = url.replace(/[\x00-\x20]/g, '').toLowerCase();
	if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return true;
	// No scheme (relative path/anchor) is safe; any other scheme is not.
	return !/^[a-z][a-z0-9+.-]*:/.test(cleaned);
}

// Convert markdown links [text](url) to HTML <a> tags; everything else is escaped text.
// Escaping (not just tag stripping) is what keeps an unterminated `<img src=x onerror=...`
// from becoming markup: the tag stripper only removes complete `<...>` pairs.
export function renderDescription(text: string): string {
	const plain = text
		.replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)') // normalize HTML links to markdown first
		.replace(/<[^>]+>/g, ''); // strip remaining HTML tags
	let out = '';
	let last = 0;
	for (const m of plain.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
		out += escapeHtml(plain.slice(last, m.index));
		const [, label, url] = m;
		const safeText = escapeHtml(label);
		out += isSafeLinkUrl(url)
			? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="text-primary hover:underline">${safeText}</a>`
			: safeText; // drop unsafe scheme, keep the text
		last = m.index + m[0].length;
	}
	out += escapeHtml(plain.slice(last));
	return out.trim();
}

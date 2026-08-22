import { describe, test, expect } from 'bun:test';
import { highlightCommand } from '../src/lib/utils/highlight-command';
import { renderDescription, isSafeLinkUrl } from '../src/lib/utils/template-description';

/**
 * Both functions feed {@html} with attacker-influenced data:
 *  - highlightCommand: image layer build commands (crafted image)
 *  - renderDescription: third-party template catalog descriptions
 * They must never let raw HTML or a javascript:/data: URL through.
 */

// Strip our own known-safe <span ...> wrappers, then assert no raw < > remains.
function withoutSpans(html: string): string {
	return html.replace(/<\/?span[^>]*>/g, '');
}

describe('highlightCommand (image layer XSS, H3)', () => {
	test('escapes an <img onerror> payload', () => {
		const out = highlightCommand('<img src=x onerror=alert(document.cookie)>');
		expect(out).toContain('&lt;img');
		expect(withoutSpans(out)).not.toContain('<img');
		expect(withoutSpans(out)).not.toMatch(/[<>]/);
	});

	test('escapes <script> even inside a quoted LABEL value', () => {
		const out = highlightCommand('LABEL a="<script>alert(1)</script>"');
		expect(out).toContain('&lt;script&gt;');
		expect(withoutSpans(out)).not.toMatch(/[<>]/);
	});

	test('still highlights a normal command (feature preserved)', () => {
		const out = highlightCommand('RUN echo "hello" && rm -rf /tmp');
		expect(out).toContain('<span'); // some highlighting applied
		expect(out).toContain('&amp;&amp;'); // ampersands escaped
	});

	test('empty input returns empty', () => {
		expect(highlightCommand('')).toBe('');
	});
});

describe('isSafeLinkUrl (template description XSS, M3)', () => {
	test('rejects javascript: in all obfuscations', () => {
		expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false);
		expect(isSafeLinkUrl('JavaScript:alert(1)')).toBe(false);
		expect(isSafeLinkUrl(' javascript:alert(1)')).toBe(false);
		expect(isSafeLinkUrl('java\tscript:alert(1)')).toBe(false);
		expect(isSafeLinkUrl('java\nscript:alert(1)')).toBe(false);
	});

	test('rejects data: and vbscript:', () => {
		expect(isSafeLinkUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
		expect(isSafeLinkUrl('vbscript:msgbox(1)')).toBe(false);
	});

	test('allows http(s) and relative/anchor URLs', () => {
		expect(isSafeLinkUrl('https://example.com')).toBe(true);
		expect(isSafeLinkUrl('http://example.com/x')).toBe(true);
		expect(isSafeLinkUrl('/local/path')).toBe(true);
		expect(isSafeLinkUrl('#section')).toBe(true);
	});
});

describe('renderDescription (template description XSS, M3)', () => {
	test('drops a javascript: markdown link, keeps the text', () => {
		const out = renderDescription('[click me](javascript:alert(1))');
		expect(out).not.toContain('<a ');
		expect(out).not.toContain('javascript:');
		expect(out).toContain('click me');
	});

	test('renders a safe https link as an anchor', () => {
		const out = renderDescription('[Docs](https://example.com/page)');
		expect(out).toContain('<a href="https://example.com/page"');
		expect(out).toContain('rel="noopener"');
		expect(out).toContain('>Docs</a>');
	});

	test('strips raw HTML tags', () => {
		const out = renderDescription('Plain <b>bold</b> <script>alert(1)</script> text');
		expect(out).not.toContain('<b>');
		expect(out).not.toContain('<script>');
		expect(out).toContain('Plain');
	});
});

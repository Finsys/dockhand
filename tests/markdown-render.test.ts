/**
 * renderMarkdown feeds a GitHub release body into an {@html} block, so the output
 * is attacker-controlled HTML that DOMPurify has to neutralise. These assertions
 * pin the behaviour we depend on, so a dompurify or isomorphic-dompurify upgrade
 * that changes it fails here rather than in a browser.
 */
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { renderMarkdown } from '../src/lib/utils/markdown';

describe('renderMarkdown', () => {
	test('empty input yields empty output', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown(undefined as unknown as string)).toBe('');
	});

	test('ordinary markdown still renders', () => {
		const html = renderMarkdown('## Heading\n\nSome **bold** text and `code`.');
		expect(html).toContain('<h2');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain('<code>code</code>');
	});

	test('a list and a link survive', () => {
		const html = renderMarkdown('- one\n- two\n\n[link](https://example.com)');
		expect(html).toContain('<li>one</li>');
		expect(html).toContain('href="https://example.com"');
	});

	// target/rel are allow-listed explicitly, because a release body links outward.
	test('target and rel are kept', () => {
		const html = renderMarkdown('<a href="https://example.com" target="_blank" rel="noopener">x</a>');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener"');
	});

	test('a script tag is removed', () => {
		const html = renderMarkdown('before\n\n<script>alert(1)</script>\n\nafter');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('alert(1)');
		expect(html).toContain('before');
	});

	test('an inline event handler is stripped', () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)">');
		expect(html.toLowerCase()).not.toContain('onerror');
		expect(html).not.toContain('alert(1)');
	});

	test('a javascript: url is not left as an href', () => {
		const html = renderMarkdown('[click](javascript:alert(1))');
		expect(html.toLowerCase()).not.toContain('href="javascript:');
	});

	test('an iframe and an object are removed', () => {
		const html = renderMarkdown('<iframe src="https://evil.test"></iframe><object data="x"></object>');
		expect(html).not.toContain('<iframe');
		expect(html).not.toContain('<object');
	});

	test('a style-based payload does not survive as a tag', () => {
		const html = renderMarkdown('<style>body{background:url(javascript:alert(1))}</style>');
		expect(html).not.toContain('<style');
	});

	// marked is configured with gfm on and breaks off; both reach the rendered output.
	test('gfm tables render and a single newline is not a break', () => {
		const table = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
		expect(table).toContain('<table');
		expect(renderMarkdown('one\ntwo')).not.toContain('<br');
	});
});

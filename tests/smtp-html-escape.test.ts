/**
 * The SMTP mail body is HTML. Its title/message carry remote-agent-supplied
 * strings (container names, image tags from an edge agent), so they must be
 * HTML-escaped before interpolation or a hostile agent injects markup into the
 * operator's inbox. These tests pin that escaping.
 *
 * Run with: bun test tests/smtp-html-escape.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { escapeHtml, buildSmtpHtml } from '../src/lib/server/notifications/smtp-core';

describe('escapeHtml', () => {
	test('escapes all five significant characters', () => {
		expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
	});

	test('ampersand is escaped first (no double-encoding of entities)', () => {
		expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
	});

	test('leaves ordinary text untouched', () => {
		expect(escapeHtml('nginx:1.27.3')).toBe('nginx:1.27.3');
	});
});

describe('buildSmtpHtml', () => {
	test('neutralizes an injected img/onerror payload in the message', () => {
		const html = buildSmtpHtml('Container Die', 'Container "<img src=x onerror=alert(1)>" die');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});

	test('neutralizes injection in the title', () => {
		const html = buildSmtpHtml('<script>alert(1)</script>', 'ok');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	test('escapes the environment badge value', () => {
		const html = buildSmtpHtml('t', 'm', '<b>prod</b>');
		expect(html).not.toContain('<b>prod</b>');
		expect(html).toContain('&lt;b&gt;prod&lt;/b&gt;');
	});

	test('keeps the structural mail markup', () => {
		const html = buildSmtpHtml('Title', 'Body');
		// The template's own tags survive; only the interpolated values are escaped.
		expect(html).toContain('<h2');
		expect(html).toContain('Sent by Dockhand');
		expect(html).toContain('Title');
		expect(html).toContain('Body');
	});

	test('omits the badge when no environment name is given', () => {
		const html = buildSmtpHtml('Title', 'Body');
		expect(html).not.toContain('background: #3b82f6');
	});
});

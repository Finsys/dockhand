/**
 * Unit tests for custom URL parsing (dockhand.url label).
 *
 * Supports both plain URLs and markdown-style named links:
 *   - "https://example.com" → { url: "https://example.com" }
 *   - "[My App](https://example.com)" → { url: "https://example.com", name: "My App" }
 *
 * Run with: bun test tests/unit/custom-url.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { parseCustomUrl } from '../src/lib/utils/custom-url';

describe('parseCustomUrl', () => {
	// -------------------------------------------------------------------
	// Null/empty handling
	// -------------------------------------------------------------------

	test('returns null for null/undefined/empty', () => {
		expect(parseCustomUrl(null)).toBeNull();
		expect(parseCustomUrl(undefined)).toBeNull();
		expect(parseCustomUrl('')).toBeNull();
		expect(parseCustomUrl('   ')).toBeNull();
	});

	// -------------------------------------------------------------------
	// Plain URL (backward compatible)
	// -------------------------------------------------------------------

	test('parses plain HTTP URL', () => {
		expect(parseCustomUrl('http://example.com')).toEqual({
			url: 'http://example.com',
		});
	});

	test('parses plain HTTPS URL', () => {
		expect(parseCustomUrl('https://example.com:8080/path')).toEqual({
			url: 'https://example.com:8080/path',
		});
	});

	test('trims whitespace from plain URL', () => {
		expect(parseCustomUrl('  https://example.com  ')).toEqual({
			url: 'https://example.com',
		});
	});

	test('parses URL without protocol (prepends https://)', () => {
		expect(parseCustomUrl('example.com:3000')).toEqual({
			url: 'https://example.com:3000',
		});
	});

	// -------------------------------------------------------------------
	// Markdown link format: [name](url)
	// -------------------------------------------------------------------

	test('parses markdown link with name', () => {
		expect(parseCustomUrl('[Cloud](https://cloud.example.com:1234/)')).toEqual({
			url: 'https://cloud.example.com:1234/',
			name: 'Cloud',
		});
	});

	test('parses markdown link with multi-word name', () => {
		expect(parseCustomUrl('[My Admin Panel](https://admin.example.com)')).toEqual({
			url: 'https://admin.example.com',
			name: 'My Admin Panel',
		});
	});

	test('trims whitespace in markdown name and URL', () => {
		expect(parseCustomUrl('[  My App  ](  https://app.example.com  )')).toEqual({
			url: 'https://app.example.com',
			name: 'My App',
		});
	});

	test('trims outer whitespace from markdown link', () => {
		expect(parseCustomUrl('  [App](https://app.example.com)  ')).toEqual({
			url: 'https://app.example.com',
			name: 'App',
		});
	});

	test('parses markdown link with port and path', () => {
		expect(parseCustomUrl('[Dashboard](http://192.168.1.5:9090/dashboard)')).toEqual({
			url: 'http://192.168.1.5:9090/dashboard',
			name: 'Dashboard',
		});
	});

	test('parses markdown link with query string', () => {
		expect(parseCustomUrl('[Grafana](https://grafana.local/d/abc?orgId=1)')).toEqual({
			url: 'https://grafana.local/d/abc?orgId=1',
			name: 'Grafana',
		});
	});

	// -------------------------------------------------------------------
	// Edge cases — should NOT match as markdown
	// -------------------------------------------------------------------

	test('does not match partial markdown (missing closing paren)', () => {
		expect(parseCustomUrl('[App](https://example.com')).toEqual({
			url: 'https://[App](https://example.com',
		});
	});

	test('does not match partial markdown (missing bracket)', () => {
		expect(parseCustomUrl('App](https://example.com)')).toEqual({
			url: 'https://App](https://example.com)',
		});
	});

	test('does not match empty name', () => {
		expect(parseCustomUrl('[](https://example.com)')).toEqual({
			url: 'https://[](https://example.com)',
		});
	});

	test('does not match empty URL in markdown', () => {
		expect(parseCustomUrl('[App]()')).toEqual({
			url: 'https://[App]()',
		});
	});

	test('does not match markdown with extra text after', () => {
		expect(parseCustomUrl('[App](https://example.com) extra')).toEqual({
			url: 'https://[App](https://example.com) extra',
		});
	});

	test('does not match markdown with text before', () => {
		expect(parseCustomUrl('prefix [App](https://example.com)')).toEqual({
			url: 'https://prefix [App](https://example.com)',
		});
	});

	// -------------------------------------------------------------------
	// Per-port URL labels (dockhand.port.<port>.url) use the same parser
	// as dockhand.url, so the title from a markdown link replaces the
	// port badge text in the UI.
	// -------------------------------------------------------------------

	test('per-port URL: plain URL keeps port-badge text', () => {
		expect(parseCustomUrl('https://ha.example.com')).toEqual({
			url: 'https://ha.example.com',
		});
	});

	test('per-port URL: markdown title replaces port-badge text', () => {
		expect(parseCustomUrl('[CloudName](https://cloud.example.com/)')).toEqual({
			url: 'https://cloud.example.com/',
			name: 'CloudName',
		});
	});
});

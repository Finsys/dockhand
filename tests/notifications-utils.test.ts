/**
 * Unit Tests for Notification Utility Functions
 *
 * Tests the escapeTelegramMarkdown function for correct character escaping.
 */
import { describe, test, expect } from 'bun:test';
import { escapeTelegramMarkdown } from '../src/lib/server/notifications';

describe('escapeTelegramMarkdown', () => {
	test('escapes backslashes', () => {
		expect(escapeTelegramMarkdown('path\\to\\file')).toBe('path\\\\to\\\\file');
	});

	test('escapes underscores', () => {
		expect(escapeTelegramMarkdown('some_text_here')).toBe('some\\_text\\_here');
	});

	test('escapes asterisks', () => {
		expect(escapeTelegramMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
	});

	test('escapes square brackets', () => {
		expect(escapeTelegramMarkdown('[link](url)')).toBe('\\[link\\](url)');
	});

	test('escapes backticks', () => {
		expect(escapeTelegramMarkdown('`code`')).toBe('\\`code\\`');
	});

	test('leaves normal text unchanged', () => {
		expect(escapeTelegramMarkdown('Hello World 123')).toBe('Hello World 123');
	});

	test('handles empty string', () => {
		expect(escapeTelegramMarkdown('')).toBe('');
	});

	test('handles multiple special characters together', () => {
		const input = 'Container *nginx_proxy* updated [v1.0]';
		const expected = 'Container \\*nginx\\_proxy\\* updated \\[v1.0\\]';
		expect(escapeTelegramMarkdown(input)).toBe(expected);
	});

	test('escapes all special characters in one pass', () => {
		const input = '\\_*[]`';
		const expected = '\\\\\\_\\*\\[\\]\\`';
		expect(escapeTelegramMarkdown(input)).toBe(expected);
	});
});

/**
 * Workflows & Telegram notification parsing tests
 *
 * Tests for:
 * - workflows:// URL parsing and HTTP URL construction
 * - Telegram URL parsing with topic_id support
 * - Telegram link_preview_options body construction
 *
 * Run with: bun test tests/unit/workflows-notifications.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { parseWorkflowsUrl, buildWorkflowsHttpUrl, parseTelegramUrl } from '../src/lib/utils/notification-parsers';

// Telegram request body construction (mirrors notifications.ts)
function buildTelegramBody(chatId: string, text: string, topicId?: number) {
	return {
		chat_id: chatId,
		text,
		...(topicId ? { message_thread_id: topicId } : {}),
		parse_mode: 'Markdown',
		link_preview_options: {
			is_disabled: true
		}
	};
}

describe('Workflows URL Parsing', () => {
	test('parses valid workflows:// URL', () => {
		const result = parseWorkflowsUrl('workflows://prod.logic.azure.com/abc123/sig456');
		expect(result).not.toBeNull();
		expect(result!.hostname).toBe('prod.logic.azure.com');
		expect(result!.workflow).toBe('abc123');
		expect(result!.signature).toBe('sig456');
	});

	test('parses URL with complex workflow path', () => {
		const result = parseWorkflowsUrl('workflows://myhost.com/long-workflow-id-here/signature-value');
		expect(result).not.toBeNull();
		expect(result!.hostname).toBe('myhost.com');
		expect(result!.workflow).toBe('long-workflow-id-here');
		expect(result!.signature).toBe('signature-value');
	});

	test('parses workflow:// (singular) variant', () => {
		const result = parseWorkflowsUrl('workflow://host.com/wf/sig');
		expect(result).not.toBeNull();
		expect(result!.hostname).toBe('host.com');
	});

	test('returns null for missing signature', () => {
		expect(parseWorkflowsUrl('workflows://host.com/workflow-only')).toBeNull();
	});

	test('returns null for missing path', () => {
		expect(parseWorkflowsUrl('workflows://host.com')).toBeNull();
	});

	test('returns null for invalid protocol', () => {
		expect(parseWorkflowsUrl('http://host.com/wf/sig')).toBeNull();
	});

	test('returns null for empty string', () => {
		expect(parseWorkflowsUrl('')).toBeNull();
	});
});

describe('Workflows HTTP URL Construction', () => {
	test('builds correct Power Automate URL', () => {
		const url = buildWorkflowsHttpUrl('prod.logic.azure.com', 'abc123', 'sig456');
		expect(url).toBe(
			'https://prod.logic.azure.com/powerautomate/automations/direct/workflows/abc123/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=sig456'
		);
	});

	test('URL starts with https', () => {
		const url = buildWorkflowsHttpUrl('any.host', 'wf', 'sig');
		expect(url.startsWith('https://')).toBe(true);
	});

	test('signature is placed in sig query param', () => {
		const url = buildWorkflowsHttpUrl('host', 'wf', 'my-signature');
		expect(url).toContain('sig=my-signature');
	});
});

describe('Workflows Adaptive Card Payload', () => {
	test('constructs valid Adaptive Card body', () => {
		const title = 'Container Started';
		const message = 'nginx started on production';
		const environmentName = 'prod-cluster';

		const titleWithEnv = environmentName ? `${title} [${environmentName}]` : title;

		const body = {
			type: 'message',
			attachments: [
				{
					contentType: 'application/vnd.microsoft.card.adaptive',
					content: {
						$schema: 'https://adaptivecards.io/schemas/adaptive-card.json',
						type: 'AdaptiveCard',
						version: '1.2',
						body: [
							{ type: 'TextBlock', style: 'heading', wrap: true, text: titleWithEnv },
							{ type: 'TextBlock', style: 'default', wrap: true, text: message }
						]
					}
				}
			]
		};

		expect(body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
		expect(body.attachments[0].content.body[0].text).toBe('Container Started [prod-cluster]');
		expect(body.attachments[0].content.body[1].text).toBe('nginx started on production');
	});

	test('title without environment has no brackets', () => {
		const title = 'License Expiring';
		const environmentName = undefined;
		const titleWithEnv = environmentName ? `${title} [${environmentName}]` : title;
		expect(titleWithEnv).toBe('License Expiring');
	});
});

describe('Telegram URL Parsing with Topic ID', () => {
	test('parses URL without topic ID', () => {
		const result = parseTelegramUrl('tgram://123456:ABC-token/-100999');
		expect(result).not.toBeNull();
		expect(result!.botToken).toBe('123456:ABC-token');
		expect(result!.chatId).toBe('-100999');
		expect(result!.topicId).toBeUndefined();
	});

	test('parses URL with topic ID', () => {
		const result = parseTelegramUrl('tgram://123456:ABC-token/-100999:42');
		expect(result).not.toBeNull();
		expect(result!.botToken).toBe('123456:ABC-token');
		expect(result!.chatId).toBe('-100999');
		expect(result!.topicId).toBe(42);
	});

	test('topic ID is parsed as integer', () => {
		const result = parseTelegramUrl('tgram://bot/chat:999');
		expect(result).not.toBeNull();
		expect(typeof result!.topicId).toBe('number');
		expect(result!.topicId).toBe(999);
	});

	test('returns null for URL with no chat ID', () => {
		expect(parseTelegramUrl('tgram://bot-token-only')).toBeNull();
	});

	test('returns null for non-tgram protocol', () => {
		expect(parseTelegramUrl('discord://id/token')).toBeNull();
	});
});

describe('Telegram Request Body', () => {
	test('includes link_preview_options with is_disabled: true', () => {
		const body = buildTelegramBody('-100123', 'test message');
		expect(body.link_preview_options).toEqual({ is_disabled: true });
	});

	test('includes message_thread_id when topic ID provided', () => {
		const body = buildTelegramBody('-100123', 'test', 42);
		expect(body.message_thread_id).toBe(42);
	});

	test('omits message_thread_id when no topic ID', () => {
		const body = buildTelegramBody('-100123', 'test');
		expect(body).not.toHaveProperty('message_thread_id');
	});

	test('uses Markdown parse mode', () => {
		const body = buildTelegramBody('-100123', 'test');
		expect(body.parse_mode).toBe('Markdown');
	});
});

/**
 * Notification System Tests
 *
 * Unit tests for notification event mapping and routing.
 * Run with: bun test tests/notifications.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { escapeTelegramMarkdown, buildGotifyUrl, parsePushoverUrl } from '../src/lib/utils/notification-parsers';

// Test the event type mapping logic (mirrors notifications.ts)
const EVENT_TYPE_MAPPING: Record<string, string> = {
	'start': 'container_started',
	'stop': 'container_stopped',
	'restart': 'container_restarted',
	'die': 'container_exited',
	'kill': 'container_exited',
	'oom': 'container_oom',
	'health_status: unhealthy': 'container_unhealthy',
	'health_status: healthy': 'container_healthy',
	'pull': 'image_pulled'
};

function mapActionToEventType(action: string): string | null {
	return EVENT_TYPE_MAPPING[action] || null;
}

describe('Event Type Mapping', () => {
	test('Maps start action to container_started', () => {
		expect(mapActionToEventType('start')).toBe('container_started');
	});

	test('Maps stop action to container_stopped', () => {
		expect(mapActionToEventType('stop')).toBe('container_stopped');
	});

	test('Maps restart action to container_restarted', () => {
		expect(mapActionToEventType('restart')).toBe('container_restarted');
	});

	test('Maps die action to container_exited', () => {
		expect(mapActionToEventType('die')).toBe('container_exited');
	});

	test('Maps kill action to container_exited', () => {
		expect(mapActionToEventType('kill')).toBe('container_exited');
	});

	test('Maps oom action to container_oom', () => {
		expect(mapActionToEventType('oom')).toBe('container_oom');
	});

	test('Maps health_status: unhealthy to container_unhealthy', () => {
		expect(mapActionToEventType('health_status: unhealthy')).toBe('container_unhealthy');
	});

	test('Maps health_status: healthy to container_healthy', () => {
		expect(mapActionToEventType('health_status: healthy')).toBe('container_healthy');
	});

	test('Maps pull action to image_pulled', () => {
		expect(mapActionToEventType('pull')).toBe('image_pulled');
	});

	test('Returns null for unknown actions', () => {
		expect(mapActionToEventType('create')).toBeNull();
		expect(mapActionToEventType('destroy')).toBeNull();
		expect(mapActionToEventType('unknown')).toBeNull();
	});
});

describe('Scanner Image Detection', () => {
	const SCANNER_IMAGE_PATTERNS = [
		'anchore/grype',
		'aquasec/trivy',
		'ghcr.io/anchore/grype',
		'ghcr.io/aquasecurity/trivy'
	];

	function isScannerContainer(image: string | null | undefined): boolean {
		if (!image) return false;
		const lowerImage = image.toLowerCase();
		return SCANNER_IMAGE_PATTERNS.some(pattern => lowerImage.includes(pattern.toLowerCase()));
	}

	test('Detects Grype scanner images', () => {
		expect(isScannerContainer('anchore/grype:latest')).toBe(true);
		expect(isScannerContainer('ghcr.io/anchore/grype:v0.74.0')).toBe(true);
	});

	test('Detects Trivy scanner images', () => {
		expect(isScannerContainer('aquasec/trivy:latest')).toBe(true);
		expect(isScannerContainer('ghcr.io/aquasecurity/trivy:0.50.0')).toBe(true);
	});

	test('Does not match regular images', () => {
		expect(isScannerContainer('nginx:latest')).toBe(false);
		expect(isScannerContainer('alpine:3.18')).toBe(false);
		expect(isScannerContainer('postgres:16')).toBe(false);
	});

	test('Handles null and undefined', () => {
		expect(isScannerContainer(null)).toBe(false);
		expect(isScannerContainer(undefined)).toBe(false);
	});

	test('Case insensitive matching', () => {
		expect(isScannerContainer('ANCHORE/GRYPE:LATEST')).toBe(true);
		expect(isScannerContainer('AquaSec/Trivy:Latest')).toBe(true);
	});
});

describe('Apprise URL Parsing', () => {
	function parseAppriseProtocol(url: string): string | null {
		const match = url.match(/^([a-z]+):\/\//i);
		return match ? match[1].toLowerCase() : null;
	}

	test('Parses Discord URL', () => {
		expect(parseAppriseProtocol('discord://webhook_id/token')).toBe('discord');
		expect(parseAppriseProtocol('discords://webhook_id/token')).toBe('discords');
	});

	test('Parses Slack URL', () => {
		expect(parseAppriseProtocol('slack://token_a/token_b/token_c')).toBe('slack');
	});

	test('Parses Telegram URL', () => {
		expect(parseAppriseProtocol('tgram://bot_token/chat_id')).toBe('tgram');
	});

	test('Parses Gotify URL', () => {
		expect(parseAppriseProtocol('gotify://hostname/token')).toBe('gotify');
		expect(parseAppriseProtocol('gotifys://hostname/token')).toBe('gotifys');
	});

	test('Parses ntfy URL', () => {
		expect(parseAppriseProtocol('ntfy://topic')).toBe('ntfy');
		expect(parseAppriseProtocol('ntfys://hostname/topic')).toBe('ntfys');
	});

	test('Parses Pushover URL', () => {
		expect(parseAppriseProtocol('pushover://user_key/api_token')).toBe('pushover');
	});

	test('Parses JSON webhook URL', () => {
		expect(parseAppriseProtocol('json://hostname/path')).toBe('json');
		expect(parseAppriseProtocol('jsons://hostname/path')).toBe('jsons');
	});

	test('Returns null for invalid URLs', () => {
		expect(parseAppriseProtocol('invalid')).toBeNull();
		expect(parseAppriseProtocol('://missing-protocol')).toBeNull();
	});
});

describe('Gotify URL Building', () => {
	test('Builds URL without subpath', () => {
		const result = buildGotifyUrl('gotify://myhost/AklJjLSi73nAXY4');
		expect(result?.url).toBe('http://myhost/message?token=AklJjLSi73nAXY4');
		expect(result?.priority).toBeUndefined();
	});

	test('Builds URL without subpath (HTTPS)', () => {
		const result = buildGotifyUrl('gotifys://myhost/AklJjLSi73nAXY4');
		expect(result?.url).toBe('https://myhost/message?token=AklJjLSi73nAXY4');
	});

	test('Builds URL with subpath', () => {
		const result = buildGotifyUrl('gotifys://gotify.domain/gotify/AklJjLSi73nAXY4');
		expect(result?.url).toBe('https://gotify.domain/gotify/message?token=AklJjLSi73nAXY4');
	});

	test('Builds URL with deeper subpath', () => {
		const result = buildGotifyUrl('gotify://myhost/apps/gotify/MyToken123');
		expect(result?.url).toBe('http://myhost/apps/gotify/message?token=MyToken123');
	});

	test('Returns null for invalid URL', () => {
		expect(buildGotifyUrl('gotify://hostname-only')).toBeNull();
	});

	test('Parses priority from query param', () => {
		const result = buildGotifyUrl('gotifys://myhost/token123?priority=3');
		expect(result?.url).toBe('https://myhost/message?token=token123');
		expect(result?.priority).toBe(3);
	});

	test('Parses priority with subpath', () => {
		const result = buildGotifyUrl('gotifys://gotify.domain/gotify/token123?priority=7');
		expect(result?.url).toBe('https://gotify.domain/gotify/message?token=token123');
		expect(result?.priority).toBe(7);
	});

	test('Ignores invalid priority values', () => {
		expect(buildGotifyUrl('gotify://myhost/token?priority=abc')?.priority).toBeUndefined();
		expect(buildGotifyUrl('gotify://myhost/token?priority=-1')?.priority).toBeUndefined();
		expect(buildGotifyUrl('gotify://myhost/token?priority=11')?.priority).toBeUndefined();
	});

	test('Priority 0 is valid', () => {
		expect(buildGotifyUrl('gotify://myhost/token?priority=0')?.priority).toBe(0);
	});

	test('Ignores unknown query params', () => {
		const result = buildGotifyUrl('gotify://myhost/token?foo=bar&priority=5&baz=qux');
		expect(result?.url).toBe('http://myhost/message?token=token');
		expect(result?.priority).toBe(5);
	});
});

describe('Telegram URL Parsing', () => {
	function parseTelegramUrl(url: string): { botToken: string; chatId: string } | null {
		const match = url.match(/^tgram:\/\/([^/]+)\/(.+)/);
		if (!match) return null;
		return { botToken: match[1], chatId: match[2] };
	}

	test('Parses valid Telegram URL', () => {
		const result = parseTelegramUrl('tgram://123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/-100123456789');
		expect(result).not.toBeNull();
		expect(result!.botToken).toBe('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
		expect(result!.chatId).toBe('-100123456789');
	});

	test('Returns null for invalid URLs', () => {
		expect(parseTelegramUrl('tgram://only-token')).toBeNull();
		expect(parseTelegramUrl('invalid://bot/chat')).toBeNull();
	});
});

describe('Telegram Markdown Escaping', () => {
	test('escapes underscores', () => {
		expect(escapeTelegramMarkdown('my_container')).toBe('my\\_container');
	});

	test('escapes asterisks', () => {
		expect(escapeTelegramMarkdown('*bold*')).toBe('\\*bold\\*');
	});

	test('escapes backticks', () => {
		expect(escapeTelegramMarkdown('`code`')).toBe('\\`code\\`');
	});

	test('escapes opening brackets', () => {
		expect(escapeTelegramMarkdown('[link')).toBe('\\[link');
	});

	test('does NOT escape closing brackets (#955)', () => {
		expect(escapeTelegramMarkdown('text]')).toBe('text]');
	});

	test('does NOT escape backslashes (legacy Markdown)', () => {
		expect(escapeTelegramMarkdown('path\\to')).toBe('path\\to');
	});

	test('plain text passes through unchanged', () => {
		expect(escapeTelegramMarkdown('production')).toBe('production');
		expect(escapeTelegramMarkdown('my-env-123')).toBe('my-env-123');
	});

	test('environment name in envTag format has no extra backslash', () => {
		const envName = 'production';
		const envTag = ` [${escapeTelegramMarkdown(envName)}]`;
		expect(envTag).toBe(' [production]');
		expect(envTag).not.toContain('\\]');
	});

	test('environment name with special chars in envTag', () => {
		const envName = 'my_server';
		const envTag = ` [${escapeTelegramMarkdown(envName)}]`;
		expect(envTag).toBe(' [my\\_server]');
		expect(envTag).not.toContain('\\]');
	});
});

describe('Pushover URL Parsing', () => {
	test('backward compatible: pushover://user/token has no device', () => {
		expect(parsePushoverUrl('pushover://uKey123/aToken456')).toEqual({
			userKey: 'uKey123',
			apiToken: 'aToken456',
			device: undefined
		});
	});

	test('pushover:// with a single device', () => {
		expect(parsePushoverUrl('pushover://uKey123/aToken456/phone')).toEqual({
			userKey: 'uKey123',
			apiToken: 'aToken456',
			device: 'phone'
		});
	});

	test('pushover:// with multiple devices -> comma-separated list', () => {
		expect(parsePushoverUrl('pushover://uKey123/aToken456/phone/tablet/desktop')).toEqual({
			userKey: 'uKey123',
			apiToken: 'aToken456',
			device: 'phone,tablet,desktop'
		});
	});

	test('apprise-native pover://user@token form, no device', () => {
		expect(parsePushoverUrl('pover://uKey123@aToken456')).toEqual({
			userKey: 'uKey123',
			apiToken: 'aToken456',
			device: undefined
		});
	});

	test('apprise-native pover://user@token/device1/device2', () => {
		expect(parsePushoverUrl('pover://uKey123@aToken456/phone/tablet')).toEqual({
			userKey: 'uKey123',
			apiToken: 'aToken456',
			device: 'phone,tablet'
		});
	});

	test('trailing slash / empty segments are ignored', () => {
		expect(parsePushoverUrl('pushover://uKey123/aToken456/')?.device).toBeUndefined();
		expect(parsePushoverUrl('pover://uKey123@aToken456//phone')?.device).toBe('phone');
	});

	test('malformed URLs return null', () => {
		expect(parsePushoverUrl('pushover://onlyuser')).toBeNull();
		expect(parsePushoverUrl('pover://useronly')).toBeNull();
		expect(parsePushoverUrl('invalid://user/token')).toBeNull();
		expect(parsePushoverUrl('')).toBeNull();
	});
});

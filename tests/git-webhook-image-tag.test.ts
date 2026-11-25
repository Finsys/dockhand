import { describe, expect, test } from 'bun:test';
import { parseWebhookImageTag, resolveWebhookImageTag, withGitStackDeployLock } from '../src/lib/server/git-webhook-image-tag';

describe('webhook image tag', () => {
	test('uses the supplied tag, existing stack value, then latest', () => {
		expect(resolveWebhookImageTag('abc123', 'old')).toBe('abc123');
		expect(resolveWebhookImageTag(null, 'old')).toBe('old');
		expect(resolveWebhookImageTag('', '')).toBe('latest');
	});
	test('rejects invalid Docker tags', () => {
		for (const tag of ['-bad', 'a/b', 'a b', 'a'.repeat(129)]) {
			expect(() => resolveWebhookImageTag(tag)).toThrow();
		}
	});
	test('distinguishes absent, empty, valid, duplicate and invalid parameters', () => {
		expect(parseWebhookImageTag([])).toEqual({ supplied: false, raw: null });
		expect(parseWebhookImageTag([''])).toEqual({ supplied: true, raw: '' });
		expect(parseWebhookImageTag(['a.1-b_c'])).toEqual({ supplied: true, raw: 'a.1-b_c' });
		expect(() => parseWebhookImageTag(['a', 'b'])).toThrow();
		expect(() => parseWebhookImageTag(['a/b'])).toThrow();
	});
	test('rejects overlapping webhook deployments and releases the lock after failure', async () => {
		let release!: () => void;
		const pending = withGitStackDeployLock(1, () => new Promise<void>(resolve => { release = resolve; }));
		expect(await withGitStackDeployLock(1, async () => true)).toBeNull();
		expect(await withGitStackDeployLock(2, async () => true)).toBe(true);
		release();
		await pending;
		await expect(withGitStackDeployLock(1, async () => { throw new Error('failed'); })).rejects.toThrow();
		expect(await withGitStackDeployLock(1, async () => true)).toBe(true);
	});
});

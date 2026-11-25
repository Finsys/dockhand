import { describe, expect, test } from 'bun:test';
import { parseWebhookImageTag, resolveWebhookImageTag, webhookDeployStatus, withGitStackDeployLock } from '../src/lib/server/git-webhook-image-tag';

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
	test('preserves existing webhook HTTP status without a tag and reports tagged failures to CI', () => {
		expect(webhookDeployStatus(false, true, false)).toBe(200);
		expect(webhookDeployStatus(false, false, false)).toBe(200);
		expect(webhookDeployStatus(false, false, true)).toBe(200);
		expect(webhookDeployStatus(true, true, false)).toBe(200);
		expect(webhookDeployStatus(true, false, false)).toBe(500);
		expect(webhookDeployStatus(true, false, true)).toBe(409);
	});
	test('rejects overlapping webhook deployments and releases the lock after failure', async () => {
		let release!: () => void;
		const pending = withGitStackDeployLock(1, true, () => new Promise<void>(resolve => { release = resolve; }));
		expect(await withGitStackDeployLock(1, true, async () => true)).toBeNull();
		expect(await withGitStackDeployLock(2, true, async () => true)).toBe(true);
		let started = false;
		const ordinary = withGitStackDeployLock(1, false, async () => { started = true; });
		await Promise.resolve();
		expect(started).toBe(false);
		release();
		await pending;
		await ordinary;
		expect(started).toBe(true);
		await expect(withGitStackDeployLock(1, true, async () => { throw new Error('failed'); })).rejects.toThrow();
		expect(await withGitStackDeployLock(1, true, async () => true)).toBe(true);
	});
	test('ordinary deployments can overlap, but a tagged deployment cannot start during them', async () => {
		let release!: () => void;
		const ordinary = withGitStackDeployLock(3, false, () => new Promise<void>(resolve => { release = resolve; }));
		expect(await withGitStackDeployLock(3, false, async () => true)).toBe(true);
		expect(await withGitStackDeployLock(3, true, async () => true)).toBeNull();
		release();
		await ordinary;
		expect(await withGitStackDeployLock(3, true, async () => true)).toBe(true);
	});
});

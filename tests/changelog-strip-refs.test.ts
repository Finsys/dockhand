import { describe, test, expect } from 'bun:test';
import { stripRefs } from '../scripts/generate-changelog-page';

describe('stripRefs (RSS plain-text)', () => {
	test('removes a trailing (#N, PR#N, @user) cluster whole, no stray punctuation', () => {
		expect(stripRefs('git stack stop/down/remove now resolve panel environment variables (#1313, PR#1339, @strausmann)'))
			.toBe('git stack stop/down/remove now resolve panel environment variables');
	});

	test('removes a single trailing (#N)', () => {
		expect(stripRefs("deleting a git stack no longer clears a same-named stack's variables on other environments (#1335)"))
			.toBe("deleting a git stack no longer clears a same-named stack's variables on other environments");
	});

	test('keeps prose commas inside the text, only drops the ref cluster', () => {
		expect(stripRefs('Git stack source badge shows the deployed short commit hash, and git url, branch in tooltip (PR#1325, @brx19)'))
			.toBe('Git stack source badge shows the deployed short commit hash, and git url, branch in tooltip');
	});

	test('preserves prose parens that are not ref clusters', () => {
		expect(stripRefs('direct remote environments - configurable remote path for stacks with relative bind mounts (./config, ./data)'))
			.toBe('direct remote environments - configurable remote path for stacks with relative bind mounts (./config, ./data)');
	});

	test('text with no refs is unchanged', () => {
		expect(stripRefs('Azure Blob destinations no longer fail with invalid format on init'))
			.toBe('Azure Blob destinations no longer fail with invalid format on init');
	});

	test('strips a bare inline #N mid-sentence', () => {
		expect(stripRefs('fixes the #876 regression in tag listing')).toBe('fixes the regression in tag listing');
	});
});

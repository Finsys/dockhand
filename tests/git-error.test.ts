import { describe, test, expect } from 'bun:test';
import { permissionDeniedMessage, isSshRepoUrl } from '../src/lib/server/git-error';

describe('isSshRepoUrl', () => {
	test('recognizes ssh:// urls', () => {
		expect(isSshRepoUrl('ssh://user@srvgit.int:5522/path')).toBe(true);
		expect(isSshRepoUrl('ssh://git@github.com/org/repo.git')).toBe(true);
	});

	test('recognizes scp-like git@ and host:path urls', () => {
		expect(isSshRepoUrl('git@github.com:owner/repo.git')).toBe(true);
		expect(isSshRepoUrl('user@server.local:path/to/repo.git')).toBe(true);
	});

	test('returns false for http/https/git schemes and non-ssh', () => {
		expect(isSshRepoUrl('https://github.com/owner/repo.git')).toBe(false);
		expect(isSshRepoUrl('http://git.local/repo.git')).toBe(false);
		expect(isSshRepoUrl('git://example.com/repo.git')).toBe(false);
		expect(isSshRepoUrl(null)).toBe(false);
		expect(isSshRepoUrl('')).toBe(false);
	});
});

describe('permissionDeniedMessage (#1509, #1862 - auth-aware git error)', () => {
	test('token credential on an SSH url points at the URL mismatch, not SSH creds', () => {
		const msg = permissionDeniedMessage('password', 'git@github.com:owner/repo.git');
		expect(msg).toContain('SSH');
		expect(msg).toContain('https://');
		expect(msg).not.toContain('SSH credentials');
	});

	test('token credential on an ssh:// url points at the mismatch (#1862)', () => {
		const msg = permissionDeniedMessage('password', 'ssh://user@srvgit.int:5522/path');
		expect(msg).toContain('SSH');
		expect(msg).toContain('https://');
		expect(msg).not.toContain('Check your access token and that it has repository access');
	});

	test('token credential on an https url blames the token, not SSH', () => {
		const msg = permissionDeniedMessage('password', 'https://github.com/owner/repo.git');
		expect(msg).toContain('token');
		expect(msg).not.toContain('SSH');
	});

	test('ssh credential gets an SSH-key-specific message', () => {
		const msg = permissionDeniedMessage('ssh', 'git@github.com:owner/repo.git');
		expect(msg).toContain('SSH key');
	});

	test('unknown/absent auth gets a generic message (no SSH assumption)', () => {
		const msg = permissionDeniedMessage(undefined, undefined);
		expect(msg).toContain('Permission denied');
		expect(msg).not.toContain('SSH');
		expect(msg).not.toContain('token');
	});

	test('token with no url still blames the token (not SSH)', () => {
		const msg = permissionDeniedMessage('password', null);
		expect(msg).toContain('token');
		expect(msg).not.toContain('SSH URL');
	});
});

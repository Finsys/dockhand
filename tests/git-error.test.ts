import { describe, test, expect } from 'bun:test';
import { permissionDeniedMessage } from '../src/lib/server/git-error';

describe('permissionDeniedMessage (#1509 - auth-aware git error)', () => {
	test('token credential on an SSH url points at the URL mismatch, not SSH creds', () => {
		const msg = permissionDeniedMessage('password', 'git@github.com:owner/repo.git');
		expect(msg).toContain('token');
		expect(msg).toContain('https://');
		expect(msg).not.toContain('SSH credentials');
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

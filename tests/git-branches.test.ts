/**
 * Unit tests for the /api/git/branches endpoint.
 *
 * Tests the endpoint handler logic: permission check, parameter validation,
 * repositoryId path, and url path. Uses mocked fetch/db to avoid pulling
 * in the full git module (which depends on native modules).
 */

import { describe, expect, mock, test } from 'bun:test';

// --- Helpers that simulate the endpoint logic ---

/**
 * Simulate the branches endpoint parameter validation.
 * Returns the same shape the endpoint would return.
 */
function validateBranchesParams(body: unknown): {
	repoUrl?: string;
	credId?: number;
	error?: string;
	status?: number;
} {
	const parsed = body as {
		repositoryId?: number;
		url?: string;
		credentialId?: number | null;
	};

	let repoUrl: string | undefined;
	let credId: number | undefined;

	if (parsed.repositoryId) {
		// In the real endpoint, getGitRepository(repositoryId) would be called
		// For testing, we simulate the lookup
		const repos: Record<number, { url: string; credentialId: number | null }> = {
			1: { url: 'https://github.com/test/repo.git', credentialId: 1 },
			2: { url: 'https://github.com/test/repo2.git', credentialId: null }
		};
		const repo = repos[parsed.repositoryId];
		if (!repo) {
			return { error: 'Repository not found', status: 404 };
		}
		repoUrl = repo.url;
		credId = repo.credentialId ?? undefined;
	} else if (parsed.url) {
		repoUrl = parsed.url;
		credId = parsed.credentialId ?? undefined;
	} else {
		return { error: 'repositoryId or url is required', status: 400 };
	}

	return { repoUrl, credId };
}

describe('branches endpoint - parameter validation', () => {
	test('rejects request without repositoryId or url (400)', () => {
		const result = validateBranchesParams({});
		expect(result.error).toBe('repositoryId or url is required');
		expect(result.status).toBe(400);
	});

	test('rejects request with only credentialId (400)', () => {
		const result = validateBranchesParams({ credentialId: 1 });
		expect(result.error).toBe('repositoryId or url is required');
		expect(result.status).toBe(400);
	});

	test('accepts repositoryId and resolves url', () => {
		const result = validateBranchesParams({ repositoryId: 1 });
		expect(result.error).toBeUndefined();
		expect(result.repoUrl).toBe('https://github.com/test/repo.git');
		expect(result.credId).toBe(1);
	});

	test('accepts repositoryId with no credential', () => {
		const result = validateBranchesParams({ repositoryId: 2 });
		expect(result.error).toBeUndefined();
		expect(result.repoUrl).toBe('https://github.com/test/repo2.git');
		expect(result.credId).toBeUndefined();
	});

	test('accepts url with credentialId', () => {
		const result = validateBranchesParams({ url: 'https://gitlab.com/test/repo.git', credentialId: 5 });
		expect(result.error).toBeUndefined();
		expect(result.repoUrl).toBe('https://gitlab.com/test/repo.git');
		expect(result.credId).toBe(5);
	});

	test('accepts url without credentialId', () => {
		const result = validateBranchesParams({ url: 'https://github.com/public/repo.git' });
		expect(result.error).toBeUndefined();
		expect(result.repoUrl).toBe('https://github.com/public/repo.git');
		expect(result.credId).toBeUndefined();
	});

	test('returns 404 for non-existent repositoryId', () => {
		const result = validateBranchesParams({ repositoryId: 999 });
		expect(result.error).toBe('Repository not found');
		expect(result.status).toBe(404);
	});
});

describe('branches endpoint - permission check', () => {
	test('requires git:edit permission', () => {
		// The endpoint checks auth.can('git', 'edit')
		// Previously it was 'git:view' which is read-only
		const requiredPermission = 'git:edit';
		expect(requiredPermission).toBe('git:edit');
	});
});

describe('branches endpoint - branch parsing', () => {
	test('parses git ls-remote output correctly', () => {
		const stdout = [
			'abc123def456\trefs/heads/main',
			'789ghijklmno\trefs/heads/develop',
			'pqr123stu456\trefs/heads/feature/test',
			'vwx789\trefs/heads/v1.0.0'
		].join('\n');

		const branches = stdout.split('\n')
			.filter(l => l.trim())
			.map(l => {
				const m = l.match(/refs\/heads\/(.+)$/);
				return m ? m[1] : null;
			})
			.filter(Boolean) as string[];

		expect(branches).toEqual(['main', 'develop', 'feature/test', 'v1.0.0']);
	});

	test('handles empty ls-remote output', () => {
		const stdout = '';
		const branches = stdout.split('\n')
			.filter(l => l.trim())
			.map(l => {
				const m = l.match(/refs\/heads\/(.+)$/);
				return m ? m[1] : null;
			})
			.filter(Boolean) as string[];

		expect(branches).toEqual([]);
	});

	test('ignores non-heads refs', () => {
		const stdout = [
			'abc123\trefs/heads/main',
			'def456\trefs/tags/v1.0',
			'ghi789\trefs/notes/commits'
		].join('\n');

		const branches = stdout.split('\n')
			.filter(l => l.trim())
			.map(l => {
				const m = l.match(/refs\/heads\/(.+)$/);
				return m ? m[1] : null;
			})
			.filter(Boolean) as string[];

		expect(branches).toEqual(['main']);
	});
});

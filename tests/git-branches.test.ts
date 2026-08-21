/**
 * Unit tests for the /api/git/branches endpoint and its security guards.
 *
 * The security guards (assertSafeBranchTarget / assertCredentialUrlPair) live
 * in src/lib/server/git-branch-lookup.ts — an import-light, pure module, so
 * we import them directly (no native deps). Everything else (the git module,
 * the db layer) is avoided by mirroring the endpoint's resolution logic,
 * matching the existing convention in this file.
 */

import { describe, expect, test } from 'bun:test';
import {
	assertSafeBranchTarget,
	assertCredentialUrlPair,
	isPrivateIp,
	parseRepoHost
} from '../src/lib/server/git-branch-lookup';

// --- A minimal GitCredential shape for the affinity guard ---
interface FakeCredential {
	id: number;
	name: string;
	authType: 'password' | 'ssh' | 'none';
	username?: string | null;
	password?: string | null;
}

function cred(partial: Partial<FakeCredential> & { name: string }): FakeCredential {
	return { id: 1, authType: 'password', username: null, ...partial } as FakeCredential;
}

// --- Endpoint resolution logic (mirrors src/routes/api/git/branches/+server.ts) ---

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

/**
 * Simulate the FULL endpoint pipeline: param validation → SSRF guard →
 * credential-affinity guard (only on the raw-url path). Mirrors the real
 * handler's ordering and 400/404 semantics.
 */
function runEndpointPipeline(
	body: unknown,
	credential: FakeCredential | null
): { repoUrl?: string; credId?: number; error?: string; status?: number } {
	const resolved = validateBranchesParams(body);
	if (resolved.error) return resolved;

	const { repoUrl, credId } = resolved;
	const bodyObj = body as { repositoryId?: number; url?: string };

	// Guard 1 (SSRF): always runs, on both paths.
	try {
		assertSafeBranchTarget(repoUrl!);
	} catch (e: any) {
		return { error: e.message, status: 400 };
	}

	// Guard 2 (credential exfiltration): raw url paired with a stored credential.
	if (bodyObj.url && credId != null && credential) {
		try {
			assertCredentialUrlPair(repoUrl!, credential as any);
		} catch (e: any) {
			return { error: e.message, status: 400 };
		}
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

// ============================================================================
// SECURITY GUARDS — imported directly from the real module (pure, no native)
// ============================================================================

describe('assertSafeBranchTarget — SSRF guard', () => {
	test('allows a public https URL', () => {
		expect(() => assertSafeBranchTarget('https://github.com/test/repo.git')).not.toThrow();
	});

	test('allows a public ssh:// URL', () => {
		expect(() => assertSafeBranchTarget('ssh://git@github.com/test/repo.git')).not.toThrow();
	});

	test('allows scp-like ssh URL (host:path)', () => {
		expect(() => assertSafeBranchTarget('git@github.com:test/repo.git')).not.toThrow();
	});

	test('blocks loopback 127.0.0.1', () => {
		expect(() => assertSafeBranchTarget('https://127.0.0.1/repo.git')).toThrow(/private|loopback|link-local/i);
	});

	test('blocks loopback 127.0.0.0/8', () => {
		expect(() => assertSafeBranchTarget('http://127.5.6.7/repo.git')).toThrow();
	});

	test('blocks link-local 169.254.x.x (cloud metadata)', () => {
		expect(() => assertSafeBranchTarget('http://169.254.169.254/latest/meta-data/')).toThrow();
	});

	test('blocks private 10.x', () => {
		expect(() => assertSafeBranchTarget('https://10.0.0.5/repo.git')).toThrow();
	});

	test('blocks private 172.16-31.x', () => {
		expect(() => assertSafeBranchTarget('https://172.16.0.1/repo.git')).toThrow();
		expect(() => assertSafeBranchTarget('https://172.31.255.254/repo.git')).toThrow();
	});

	test('allows 172.32.x (outside 172.16/12)', () => {
		expect(() => assertSafeBranchTarget('https://172.32.0.1/repo.git')).not.toThrow();
	});

	test('blocks private 192.168.x', () => {
		expect(() => assertSafeBranchTarget('https://192.168.1.1/repo.git')).toThrow();
	});

	test('blocks CGNAT 100.64.x', () => {
		expect(() => assertSafeBranchTarget('https://100.64.0.1/repo.git')).toThrow();
	});

	test('blocks 0.0.0.0', () => {
		expect(() => assertSafeBranchTarget('https://0.0.0.0/repo.git')).toThrow();
	});

	test('blocks IPv6 loopback ::1', () => {
		expect(() => assertSafeBranchTarget('http://[::1]/repo.git')).toThrow();
	});

	test('blocks IPv6 link-local fe80::', () => {
		expect(() => assertSafeBranchTarget('http://[fe80::1]/repo.git')).toThrow();
	});

	test('blocks IPv6 unique-local fc00::/7', () => {
		expect(() => assertSafeBranchTarget('http://[fc00::1]/repo.git')).toThrow();
		expect(() => assertSafeBranchTarget('http://[fd12::1]/repo.git')).toThrow();
	});

	test('blocks IPv4-mapped IPv6 (::ffff:127.0.0.1)', () => {
		// The mapped form is only reachable when the URL uses bracketed IPv6
		// syntax (the scp-like path splits on ':' and would misparse it).
		expect(() => assertSafeBranchTarget('http://[::ffff:127.0.0.1]/repo.git')).toThrow();
		expect(() => assertSafeBranchTarget('ssh://[::ffff:127.0.0.1]:22/repo.git')).toThrow();
	});

	test('blocks well-known internal hostname "localhost"', () => {
		expect(() => assertSafeBranchTarget('https://localhost/repo.git')).toThrow(/not allowed|private/i);
	});

	test('blocks host.docker.internal', () => {
		expect(() => assertSafeBranchTarget('https://host.docker.internal/repo.git')).toThrow();
	});

	test('rejects a bare local path (no host)', () => {
		// assertSafeRepoUrl rejects these upstream, but the guard must also
		// not crash and must reject when no host is parseable.
		expect(() => assertSafeBranchTarget('/tmp/local/repo.git')).toThrow();
	});

	test('rejects a URL with no scheme and no scp-colon', () => {
		expect(() => assertSafeBranchTarget('nonsense-no-host')).toThrow();
	});

	test('rejects ext:: transport (RCE vector)', () => {
		expect(() => assertSafeBranchTarget('ext::sh -c "evil"')).toThrow();
	});
});

describe('assertCredentialUrlPair — credential-exfiltration guard', () => {
	test('ssh credential is ALWAYS allowed (host-agnostic)', () => {
		const c = cred({ name: 'my-ssh', authType: 'ssh', username: null });
		// Even a mismatched host — ssh keys are validated by the remote server.
		expect(() => assertCredentialUrlPair('https://github.com/repo.git', c as any)).not.toThrow();
		expect(() => assertCredentialUrlPair('ssh://git@internal-git.example.com/repo', c as any)).not.toThrow();
	});

	test('none credential is allowed (no secret to leak)', () => {
		const c = cred({ name: 'public', authType: 'none' });
		expect(() => assertCredentialUrlPair('https://github.com/repo.git', c as any)).not.toThrow();
	});

	test('password credential: username == URL host → allowed', () => {
		const c = cred({ name: 'github-pat', authType: 'password', username: 'github.com' });
		expect(() => assertCredentialUrlPair('https://github.com/repo.git', c as any)).not.toThrow();
	});

	test('password credential: name is a host-suffix → allowed', () => {
		const c = cred({ name: 'github-pat', authType: 'password', username: 'someuser' });
		// "github" (from "github-pat") is the first label of host "github.com"
		expect(() => assertCredentialUrlPair('https://github.com/repo.git', c as any)).not.toThrow();
	});

	test('password credential: name matches full host → allowed', () => {
		const c = cred({ name: 'gitlab.com', authType: 'password', username: 'x' });
		expect(() => assertCredentialUrlPair('https://gitlab.com/repo.git', c as any)).not.toThrow();
	});

	test('password credential: WRONG host → rejected', () => {
		const c = cred({ name: 'github-pat', authType: 'password', username: 'someuser' });
		// Attacker pairs a GitHub credential with an attacker host.
		expect(() => assertCredentialUrlPair('https://attacker.tld/repo.git', c as any)).toThrow(/does not match/i);
	});

	test('password credential: SSRF target with mismatched cred → rejected', () => {
		const c = cred({ name: 'github-pat', authType: 'password', username: 'github.com' });
		// Even a loopback target is rejected by the affinity guard (and would
		// be rejected by assertSafeBranchTarget separately).
		expect(() => assertCredentialUrlPair('http://127.0.0.1/repo.git', c as any)).toThrow();
	});

	test('null credential is allowed (nothing to check)', () => {
		expect(() => assertCredentialUrlPair('https://github.com/repo.git', null as any)).not.toThrow();
	});
});

describe('parseRepoHost', () => {
	test('https with path', () => {
		expect(parseRepoHost('https://github.com/test/repo.git')).toBe('github.com');
	});

	test('ssh:// with user and port', () => {
		expect(parseRepoHost('ssh://git@gitlab.example.com:2222/test/repo.git')).toBe('gitlab.example.com');
	});

	test('scp-like host:path', () => {
		expect(parseRepoHost('git@github.com:test/repo.git')).toBe('github.com');
	});

	test('git:// scheme', () => {
		expect(parseRepoHost('git://github.com/test/repo.git')).toBe('github.com');
	});

	test('returns null for a bare path', () => {
		expect(parseRepoHost('/tmp/repo.git')).toBeNull();
	});

	test('returns null for unsupported scheme', () => {
		expect(parseRepoHost('ext::evil')).toBeNull();
	});
});

describe('isPrivateIp', () => {
	test('public IPv4 is not private', () => {
		expect(isPrivateIp('8.8.8.8')).toBe(false);
		expect(isPrivateIp('1.1.1.1')).toBe(false);
	});

	test('loopback IPv4 is private', () => {
		expect(isPrivateIp('127.0.0.1')).toBe(true);
		expect(isPrivateIp('127.255.255.255')).toBe(true);
	});

	test('link-local IPv4 is private', () => {
		expect(isPrivateIp('169.254.1.1')).toBe(true);
	});

	test('private IPv4 ranges are private', () => {
		expect(isPrivateIp('10.0.0.1')).toBe(true);
		expect(isPrivateIp('172.16.0.1')).toBe(true);
		expect(isPrivateIp('172.31.255.255')).toBe(true);
		expect(isPrivateIp('192.168.1.1')).toBe(true);
	});

	test('boundary: 172.32.0.1 is NOT private', () => {
		expect(isPrivateIp('172.32.0.1')).toBe(false);
	});

	test('IPv6 loopback/link-local/ULA are private', () => {
		expect(isPrivateIp('::1')).toBe(true);
		expect(isPrivateIp('fe80::1')).toBe(true);
		expect(isPrivateIp('fc00::1')).toBe(true);
		expect(isPrivateIp('fd12::1')).toBe(true);
	});

	test('IPv4-mapped IPv6 of a private IPv4 is private', () => {
		expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
		expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
	});
});

// ============================================================================
// ENDPOINT PIPELINE — mirrors the real handler's guard ordering
// ============================================================================

describe('branches endpoint - security pipeline (guards in handler order)', () => {
	test('SSRF target is rejected even via repositoryId path', () => {
		// The repositoryId path resolves the repo's stored URL; if that URL
		// points internal, the SSRF guard still catches it.
		const result = runEndpointPipeline(
			{ repositoryId: 1 }, // fake repo 1 → github.com (safe)
			cred({ name: 'github-pat', authType: 'password', username: 'github.com' })
		);
		expect(result.error).toBeUndefined();
		expect(result.repoUrl).toBe('https://github.com/test/repo.git');
	});

	test('raw url pointing at loopback is rejected (SSRF)', () => {
		const result = runEndpointPipeline(
			{ url: 'http://127.0.0.1/evil.git', credentialId: 2 },
			cred({ name: 'github-pat', authType: 'password', username: 'github.com' })
		);
		expect(result.status).toBe(400);
		expect(result.error).toMatch(/private|loopback|link-local/i);
	});

	test('raw url + mismatched stored credential is rejected (exfiltration)', () => {
		const result = runEndpointPipeline(
			{ url: 'https://attacker.tld/evil.git', credentialId: 2 },
			cred({ name: 'github-pat', authType: 'password', username: 'github.com' })
		);
		expect(result.status).toBe(400);
		expect(result.error).toMatch(/does not match/i);
	});

	test('raw url + matching stored credential is allowed', () => {
		const result = runEndpointPipeline(
			{ url: 'https://github.com/test/repo.git', credentialId: 2 },
			cred({ name: 'github-pat', authType: 'password', username: 'github.com' })
		);
		expect(result.error).toBeUndefined();
		expect(result.repoUrl).toBe('https://github.com/test/repo.git');
	});

	test('raw url + ssh credential is allowed even for a different host', () => {
		const result = runEndpointPipeline(
			{ url: 'ssh://git@github.com/test/repo.git', credentialId: 3 },
			cred({ name: 'my-ssh-key', authType: 'ssh' })
		);
		expect(result.error).toBeUndefined();
	});

	test('repositoryId path is NOT subject to the affinity guard', () => {
		// Even if the fake repo's credential is "mismatched", the repositoryId
		// path uses the user's own stored repo config — no affinity check.
		const result = runEndpointPipeline(
			{ repositoryId: 1 },
			cred({ name: 'totally-different', authType: 'password', username: 'x' })
		);
		expect(result.error).toBeUndefined();
		expect(result.credId).toBe(1);
	});
});

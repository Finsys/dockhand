/**
 * Security tests for POST /api/git/preview-env (PR #1343 maintainer review).
 *
 * The preview endpoint clones a USER-SUPPLIED URL and reads env files from
 * it — the same SSRF / RCE / path-traversal surface as the branches
 * endpoint. This file locks the guards applied in previewRepoEnvFiles
 * (git.ts) and the preview-env endpoint:
 *
 *  1. SSRF — assertSafeRepoTarget blocks the maintainer's encoded-IP
 *     payloads (decimal / octal / short-form / hex / metadata / v4-mapped
 *     IPv6) so the preview clone never reaches an internal host.
 *  2. RCE — assertSafeRepoUrl rejects the ext::/file:: transport denylist
 *     before any git subprocess is spawned.
 *  3. Path traversal — repoFilePath keeps composePath/envFilePath INSIDE the
 *     clone dir, so `envFilePath: '../../secrets/x'` cannot read a file
 *     outside the temp dir.
 *  4. Credential affinity — assertCredentialHostMatch refuses to pair a raw
 *     url with a stored password credential whose username isn't the host
 *     (exfiltration defense).
 *
 * Mirror-test convention: the endpoint pipeline below mirrors the real
 * preview-env handler's guard order and error handling. Keep in sync.
 */

import { describe, expect, test } from 'bun:test';
import {
	assertSafeRepoTarget,
	assertCredentialHostMatch
} from '../src/lib/server/git-branch-lookup';
import { repoFilePath, assertSafeRepoUrl } from '../src/lib/server/git-url-safety';
import { resolve, sep } from 'node:path';

// =============================================================================
// SSRF guard — preview clone never reaches internal hosts.
// =============================================================================

describe('preview-env SSRF guard (assertSafeRepoTarget)', () => {
	test('blocks decimal-encoded loopback', () => {
		expect(() => assertSafeRepoTarget('http://2130706433/')).toThrow();
	});
	test('blocks octal-encoded loopback', () => {
		expect(() => assertSafeRepoTarget('http://0177.0.0.1/')).toThrow();
	});
	test('blocks short-form loopback', () => {
		expect(() => assertSafeRepoTarget('http://127.1/')).toThrow();
	});
	test('blocks hex-encoded loopback', () => {
		expect(() => assertSafeRepoTarget('http://0x7f000001/')).toThrow();
	});
	test('blocks decimal-encoded cloud metadata', () => {
		expect(() => assertSafeRepoTarget('http://2852039166/')).toThrow();
	});
	test('blocks v4-mapped IPv6 loopback', () => {
		expect(() => assertSafeRepoTarget('http://[0:0:0:0:0:ffff:127.0.0.1]/')).toThrow();
	});
	test('blocks localhost', () => {
		expect(() => assertSafeRepoTarget('https://localhost/repo.git')).toThrow();
	});
	test('allows public https', () => {
		expect(() => assertSafeRepoTarget('https://github.com/repo.git')).not.toThrow();
	});
	test('allows public ssh://', () => {
		expect(() => assertSafeRepoTarget('ssh://git@github.com/repo.git')).not.toThrow();
	});
});

// =============================================================================
// RCE guard — ext::/file:: transport denylist.
// =============================================================================

describe('preview-env RCE guard (assertSafeRepoUrl)', () => {
	test('blocks ext:: transport', () => {
		expect(() => assertSafeRepoUrl('ext::sh -c "evil"')).toThrow();
	});
	test('blocks fd:: transport', () => {
		expect(() => assertSafeRepoUrl('fd::sh -c "evil"')).toThrow();
	});
	test('blocks file:// transport', () => {
		expect(() => assertSafeRepoUrl('file:///tmp/repo.git')).toThrow();
	});
	test('blocks local path', () => {
		expect(() => assertSafeRepoUrl('/tmp/repo.git')).toThrow();
	});
	test('allows https', () => {
		expect(() => assertSafeRepoUrl('https://github.com/repo.git')).not.toThrow();
	});
});

// =============================================================================
// Path traversal guard — repoFilePath keeps paths inside the clone dir.
// =============================================================================

describe('preview-env path traversal guard (repoFilePath)', () => {
	const cloneDir = '/home/user/git-repos/preview-123';

	test('keeps a normal compose path inside the clone dir', () => {
		const p = repoFilePath(cloneDir, 'compose.yaml', 'Compose path');
		expect(p).toBe(resolve(cloneDir, 'compose.yaml'));
	});

	test('keeps a nested env path inside the clone dir', () => {
		const p = repoFilePath(cloneDir, 'subdir/.env', 'Env file path');
		expect(p).toBe(resolve(cloneDir, 'subdir/.env'));
	});

	test('rejects an env path that escapes the clone dir (.. traversal)', () => {
		expect(() => repoFilePath(cloneDir, '../../secrets/credentials.env', 'Env file path')).toThrow(/inside the repository/i);
	});

	test('rejects a compose path that escapes the clone dir', () => {
		expect(() => repoFilePath(cloneDir, '../../etc/passwd', 'Compose path')).toThrow(/inside the repository/i);
	});

	test('rejects a path with an internal .. that escapes the clone dir', () => {
		// An internal .. (not just a leading /) still escapes — blocked.
		expect(() => repoFilePath(cloneDir, 'compose/../../secrets/credentials.env', 'Env file path')).toThrow(/inside the repository/i);
	});

	test('a leading / is treated as repo-root-relative (still inside the clone)', () => {
		// A leading / is stripped → repo-root-relative. This is the documented
		// behaviour for in-repo paths; the containment check still blocks a
		// REAL escape.
		const p = repoFilePath(cloneDir, '/compose.yaml', 'Compose path');
		expect(p.startsWith(cloneDir + sep)).toBe(true);
	});
});

// =============================================================================
// Credential affinity — raw url may only pair with a host-matching credential.
// =============================================================================

describe('preview-env credential affinity (assertCredentialHostMatch)', () => {
	test('rejects a single-label username for an attacker subdomain', () => {
		const c: any = { id: 1, name: 'github', authType: 'password', username: 'github', password: 'x' };
		expect(() => assertCredentialHostMatch('https://github.evil.com/x.git', c)).toThrow(/does not match/i);
	});
	test('allows a username that matches the full host', () => {
		const c: any = { id: 2, name: 'gh', authType: 'password', username: 'github.com', password: 'x' };
		expect(() => assertCredentialHostMatch('https://github.com/x.git', c)).not.toThrow();
	});
	test('allows ssh credential (no secret to leak)', () => {
		const c: any = { id: 3, name: 'ssh', authType: 'ssh', username: null, password: null };
		expect(() => assertCredentialHostMatch('https://github.com/x.git', c)).not.toThrow();
	});
});

// =============================================================================
// Endpoint pipeline (mirror of POST /api/git/preview-env).
// =============================================================================

type StoredRepo = { id: number; url: string; credentialId: number | null };
type StoredCred = { id: number; name: string; authType: string; username: string | null };
const storedRepos = new Map<number, StoredRepo>();
const storedCreds = new Map<number, StoredCred>();

/**
 * Mirror of POST /api/git/preview-env (src/routes/api/git/preview-env/+server.ts).
 * Keeps only the security-relevant guard order; the actual clone/env-read is
 * stubbed (previewRepoEnvFiles is not imported here).
 */
async function postPreviewEnv(
	body: { repositoryId?: number; url?: string; branch?: string; credentialId?: number | null; composePath?: string },
	permissionDenied = false
): Promise<{ status: number; json: any }> {
	if (permissionDenied) return { status: 401, json: { error: 'Authentication required' } };

	const { repositoryId, url, credentialId, composePath } = body;
	if (!composePath || typeof composePath !== 'string') {
		return { status: 400, json: { error: 'Compose path is required' } };
	}

	let repoUrl: string;
	let credentialIdResolved: number | null = null;
	if (repositoryId) {
		const repo = storedRepos.get(repositoryId);
		if (!repo) return { status: 404, json: { error: 'Repository not found' } };
		repoUrl = repo.url;
		credentialIdResolved = repo.credentialId;
	} else if (url) {
		repoUrl = url;
		credentialIdResolved = credentialId || null;
	} else {
		return { status: 400, json: { error: 'Either repositoryId or url is required' } };
	}

	let credential = null;
	if (credentialIdResolved) {
		credential = storedCreds.get(credentialIdResolved);
	}

	// Guard 1 (SSRF) — runs on both paths.
	try {
		assertSafeRepoTarget(repoUrl);
	} catch (e: any) {
		return { status: 400, json: { error: e.message } };
	}

	// Guard 2 (credential affinity) — raw url path only.
	if (url && credentialIdResolved && credential) {
		try {
			assertCredentialHostMatch(repoUrl, credential as any);
		} catch (e: any) {
			return { status: 400, json: { error: e.message } };
		}
	}

	// Stubbed: previewRepoEnvFiles (clone + read env files).
	return { status: 200, json: { vars: {}, sources: {} } };
}

describe('POST /api/git/preview-env — pipeline', () => {
	test('requires composePath (400)', async () => {
		const res = await postPreviewEnv({ url: 'https://github.com/x.git' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/compose path/i);
	});

	test('requires repositoryId or url (400)', async () => {
		const res = await postPreviewEnv({ composePath: 'compose.yaml' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/repositoryId or url/i);
	});

	test('unknown repositoryId returns 404', async () => {
		const res = await postPreviewEnv({ repositoryId: 9999, composePath: 'compose.yaml' });
		expect(res.status).toBe(404);
	});

	test('endpoint blocks decimal-encoded loopback (SSRF)', async () => {
		const res = await postPreviewEnv({ url: 'http://2130706433/', composePath: 'compose.yaml' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks ext:: transport (RCE)', async () => {
		const res = await postPreviewEnv({ url: 'ext::sh -c "evil"', composePath: 'compose.yaml' });
		expect(res.status).toBe(400);
	});

	test('endpoint blocks a credential whose username does not match the host', async () => {
		const cred = storedCreds.set(1, { id: 1, name: 'github', authType: 'password', username: 'github' });
		const res = await postPreviewEnv({
			url: 'https://github.evil.com/x.git',
			credentialId: 1,
			composePath: 'compose.yaml'
		});
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/does not match/i);
	});

	test('endpoint allows a host-matching credential', async () => {
		storedCreds.set(2, { id: 2, name: 'gh', authType: 'password', username: 'github.com' });
		const res = await postPreviewEnv({
			url: 'https://github.com/x.git',
			credentialId: 2,
			composePath: 'compose.yaml'
		});
		expect(res.status).toBe(200);
	});

	test('repositoryId path is not subject to the credential guard', async () => {
		storedCreds.set(3, { id: 3, name: 'gh', authType: 'password', username: 'github' });
		storedRepos.set(10, { id: 10, url: 'https://github.com/x.git', credentialId: 3 });
		const res = await postPreviewEnv({ repositoryId: 10, composePath: 'compose.yaml' });
		expect(res.status).toBe(200);
	});
});

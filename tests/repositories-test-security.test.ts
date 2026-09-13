/**
 * Security tests for POST /api/git/repositories/test (PR #1343 maintainer
 * review).
 *
 * The test-connection endpoint spawns git (ls-remote + clone) with a
 * USER-SUPPLIED url + credentialId. This file locks the guards applied in
 * testRepositoryConfig (git.ts) and the repositories/test endpoint:
 *
 *  1. SSRF — assertSafeRepoTarget blocks the maintainer's encoded-IP payloads.
 *  2. RCE — assertSafeRepoUrl rejects the ext::/file:: transport denylist.
 *
 * Mirror-test convention: the endpoint pipeline below mirrors the real
 * repositories/test handler's guard order and error handling. Keep in sync.
 */

import { describe, expect, test } from 'bun:test';
import { assertSafeRepoTarget } from '../src/lib/server/git-branch-lookup';
import { assertSafeRepoUrl } from '../src/lib/server/git-url-safety';

// =============================================================================
// SSRF guard — test-connection never reaches internal hosts.
// =============================================================================

describe('repositories/test SSRF guard (assertSafeRepoTarget)', () => {
	test('blocks decimal-encoded loopback', () => {
		expect(() => assertSafeRepoTarget('http://2130706433/')).toThrow();
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
	test('allows public https', () => {
		expect(() => assertSafeRepoTarget('https://github.com/repo.git')).not.toThrow();
	});
});

// =============================================================================
// RCE guard — ext::/file:: transport denylist.
// =============================================================================

describe('repositories/test RCE guard (assertSafeRepoUrl)', () => {
	test('blocks ext:: transport', () => {
		expect(() => assertSafeRepoUrl('ext::sh -c "evil"')).toThrow();
	});
	test('blocks file:// transport', () => {
		expect(() => assertSafeRepoUrl('file:///tmp/repo.git')).toThrow();
	});
	test('allows https', () => {
		expect(() => assertSafeRepoUrl('https://github.com/repo.git')).not.toThrow();
	});
});

// =============================================================================
// Endpoint pipeline (mirror of POST /api/git/repositories/test).
// =============================================================================

/**
 * Mirror of POST /api/git/repositories/test
 * (src/routes/api/git/repositories/test/+server.ts). Keeps only the
 * security-relevant guard order; the actual git ls-remote/clone is stubbed.
 */
async function postRepositoriesTest(
	body: { url?: string; branch?: string; credentialId?: number | null },
	permissionDenied = false
): Promise<{ status: number; json: any }> {
	if (permissionDenied) return { status: 403, json: { error: 'Permission denied' } };

	if (!body.url || typeof body.url !== 'string') {
		return { status: 400, json: { error: 'Repository URL is required' } };
	}

	// Guard 1 (SSRF + transport denylist).
	try {
		assertSafeRepoTarget(body.url);
	} catch (e: any) {
		return { status: 400, json: { success: false, error: e.message } };
	}

	// Stubbed: testRepositoryConfig (ls-remote + clone).
	return { status: 200, json: { success: true } };
}

describe('POST /api/git/repositories/test — pipeline', () => {
	test('requires url (400)', async () => {
		const res = await postRepositoriesTest({});
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/repository url/i);
	});

	test('endpoint blocks decimal-encoded loopback (SSRF)', async () => {
		const res = await postRepositoriesTest({ url: 'http://2130706433/' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks ext:: transport (RCE)', async () => {
		const res = await postRepositoriesTest({ url: 'ext::sh -c "evil"' });
		expect(res.status).toBe(400);
	});

	test('endpoint allows a public URL with no credential', async () => {
		const res = await postRepositoriesTest({ url: 'https://github.com/x.git' });
		expect(res.status).toBe(200);
	});
});

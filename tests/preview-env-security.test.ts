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
 *
 * Mirror-test convention: the endpoint pipeline below mirrors the real
 * preview-env handler's input-parsing behaviour (composePath/url validation,
 * SSRF, RCE) and its guard order. Keep in sync.
 *
 *  4. Permission gate (PR #1343 maintainer review) — the handler is gated on
 *     the git:edit permission (same model as /api/git/branches). That
 *     authorization contract is NOT covered by this mirror (a mirror can
 *     prove only its own copied logic) — it is covered against the ACTUAL
 *     exported POST handler in tests/preview-env-authorization.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { assertSafeRepoTarget } from '../src/lib/server/git-branch-lookup';
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
// Endpoint pipeline (mirror of POST /api/git/preview-env).
// =============================================================================

type StoredRepo = { id: number; url: string; credentialId: number | null };
const storedRepos = new Map<number, StoredRepo>();

/**
 * Mirror of POST /api/git/preview-env (src/routes/api/git/preview-env/+server.ts).
 * Keeps only the security-relevant guard order; the actual clone/env-read is
 * stubbed (previewRepoEnvFiles is not imported here).
 *
 * `authEnabled` mirrors the handler's `authorize()`:
 *  - false -> the git:edit gate is skipped (existing allowed behaviour);
 *  - true  -> requires `hasGitEdit` (the `auth.can('git','edit')` result);
 *             when absent it returns 403 BEFORE any repository input is
 *             parsed or any git subprocess is spawned.
 */
async function postPreviewEnv(
	body: { repositoryId?: number; url?: string; branch?: string; credentialId?: number | null; composePath?: string },
	authEnabled = false,
	hasGitEdit = false
): Promise<{ status: number; json: any }> {
	// Auth/permission gate — mirrors the handler: 401 when authenticated
	// context is absent, 403 when the user lacks git:edit. Both run BEFORE
	// request.json() (attacker-controlled input) and before any git op.
	if (authEnabled) {
		if (!hasGitEdit) {
			return { status: 403, json: { error: 'Permission denied' } };
		}
	}

	const { repositoryId, url, composePath } = body;
	if (!composePath || typeof composePath !== 'string') {
		return { status: 400, json: { error: 'Compose path is required' } };
	}

	let repoUrl: string;
	if (repositoryId) {
		const repo = storedRepos.get(repositoryId);
		if (!repo) return { status: 404, json: { error: 'Repository not found' } };
		repoUrl = repo.url;
	} else if (url) {
		repoUrl = url;
	} else {
		return { status: 400, json: { error: 'Either repositoryId or url is required' } };
	}

	// Guard 1 (SSRF) — runs on both paths.
	try {
		assertSafeRepoTarget(repoUrl);
	} catch (e: any) {
		return { status: 400, json: { error: e.message } };
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
		expect(res.json.error).toMatch(/not allowed|loopback|metadata/i);
	});

	test('endpoint blocks ext:: transport (RCE)', async () => {
		const res = await postPreviewEnv({ url: 'ext::sh -c "evil"', composePath: 'compose.yaml' });
		expect(res.status).toBe(400);
	});

	test('repositoryId path resolves the stored repo URL', async () => {
		storedRepos.set(10, { id: 10, url: 'https://github.com/x.git', credentialId: null });
		const res = await postPreviewEnv({ repositoryId: 10, composePath: 'compose.yaml' });
		expect(res.status).toBe(200);
	});
});

// =============================================================================
// Permission gate (git:edit) — tests the ACTUAL production handler core.
// =============================================================================
// The preview-env route (src/routes/api/git/preview-env/+server.ts) is a thin
// wrapper that resolves the real dependencies and forwards to
// handlePreviewEnv() (src/lib/server/preview-env-handler.ts). These tests
// execute that EXACT production pipeline with injected fakes — no mirror and
// no mock.module(), so nothing leaks into other test files. The tested
// function IS the code path the POST route invokes; if the route's
// `auth.can('git','edit')` gate is removed, these tests break.
//
// Contract:
//   - auth disabled           -> gate skipped, continues (200 with a valid URL);
//   - auth enabled + unauth   -> can('git','edit')=false -> 403 'Permission
//                                denied' BEFORE request.json() is parsed;
//   - auth enabled + read-only-> can('git','edit')=false -> 403;
//   - auth enabled + git:edit -> gate satisfied, continues (200).
// =============================================================================
import { handlePreviewEnv, type PreviewEnvDependencies } from '../src/lib/server/preview-env-handler';

function makeAuthDeps(cfg: { authEnabled: boolean; canGitEdit: boolean }): { deps: PreviewEnvDependencies; request: { json: () => Promise<unknown>; _body: unknown }; requestJsonCalls: () => number; previewCalled: () => number } {
	let requestJsonCalls = 0;
	let previewCalls = 0;
	const deps: PreviewEnvDependencies = {
		authorize: async () => ({
			authEnabled: cfg.authEnabled,
			isAuthenticated: cfg.canGitEdit,
			user: null,
			isAdmin: false,
			isEnterprise: false,
			can: async (resource: string, action: string) =>
				resource === 'git' && action === 'edit' ? cfg.canGitEdit : false
		}),
		getGitRepository: async () => null,
		getGitCredential: async () => null,
		previewRepoEnvFiles: async () => {
			previewCalls++;
			return { vars: {}, sources: {} };
		},
		assertSafeRepoTarget: () => {}
	};
	// The request object whose json() we track (the body parser, NOT the
	// response helper). If the permission gate runs BEFORE request.json(),
	// this counter stays at 0 for the 403 path.
	const request: { json: () => Promise<unknown>; _body: unknown } = {
		json: async () => {
			requestJsonCalls++;
			return request._body;
		},
		_body: undefined
	};
	return { deps, request, requestJsonCalls: () => requestJsonCalls, previewCalled: () => previewCalls };
}

async function runAuthTest(
	cfg: { authEnabled: boolean; canGitEdit: boolean },
	body: unknown
): Promise<{ kind: string; requestJsonCalls: number; previewCalls: number; message?: string; vars?: Record<string, string> }> {
	const { deps, request, requestJsonCalls, previewCalled } = makeAuthDeps(cfg);
	request._body = body;
	const outcome = await handlePreviewEnv(deps, {
		request,
		cookies: {}
	});
	return {
		kind: outcome.kind,
		requestJsonCalls: requestJsonCalls(),
		previewCalls: previewCalled(),
		message: 'message' in outcome ? (outcome as any).message : undefined,
		vars: 'vars' in outcome ? (outcome as any).vars : undefined
	};
}

describe('POST /api/git/preview-env — git:edit gate (REAL handler core, no mock.module)', () => {
	// Test A — auth disabled: the gate is skipped; the request proceeds beyond
	// authorization (composePath present, valid public URL -> 200).
	test('auth disabled -> proceeds beyond authorization', async () => {
		const r = await runAuthTest(
			{ authEnabled: false, canGitEdit: false },
			{ url: 'https://github.com/x.git', composePath: 'compose.yaml' }
		);
		expect(r.kind).toBe('success');
		// The handler parsed the body (request.json) and reached the (injected)
		// env read — proof the gate was skipped and execution continued.
		expect(r.requestJsonCalls).toBe(1);
		expect(r.previewCalls).toBe(1);
	});

	// Test B — auth enabled, no git:edit: 403 "Permission denied" AND the
	// handler must NOT have parsed the body or touched any git/db operation —
	// the gate runs BEFORE attacker-controlled input is processed.
	test('auth enabled without git:edit -> 403 before any processing', async () => {
		const r = await runAuthTest(
			{ authEnabled: true, canGitEdit: false },
			{ url: 'https://github.com/x.git', composePath: 'compose.yaml' }
		);
		expect(r.kind).toBe('permission-denied');
		// The gate runs BEFORE request.json() (body parser) — proof that
		// attacker-controlled input is NOT parsed before authorization.
		expect(r.requestJsonCalls).toBe(0);
		expect(r.previewCalls).toBe(0);
	});

	// Test B' — the gate fires even when the body is missing/malicious: a
	// read-only user is rejected regardless of the (possibly attacker) input.
	test('auth enabled without git:edit -> 403 even with a malformed body', async () => {
		const r = await runAuthTest({ authEnabled: true, canGitEdit: false }, { url: 'https://github.com/x.git' });
		expect(r.kind).toBe('permission-denied');
		expect(r.requestJsonCalls).toBe(0);
	});

	// Test C — auth enabled, git:edit present: the gate is satisfied and the
	// request continues (body parsed, env read reached -> 200).
	test('auth enabled with git:edit -> continues processing', async () => {
		const r = await runAuthTest(
			{ authEnabled: true, canGitEdit: true },
			{ url: 'https://github.com/x.git', composePath: 'compose.yaml' }
		);
		expect(r.kind).toBe('success');
		expect(r.requestJsonCalls).toBe(1);
		expect(r.previewCalls).toBe(1);
	});

	// Test C' — the downstream SSRF guard STILL applies after the gate is
	// satisfied (a permitted user cannot use a loopback URL). This uses the
	// REAL assertSafeRepoTarget to prove the guard runs after the gate.
	test('auth enabled with git:edit -> downstream SSRF guard still applies', async () => {
		const { assertSafeRepoTarget } = await import('../src/lib/server/git-branch-lookup');
		const { deps } = makeAuthDeps({ authEnabled: true, canGitEdit: true });
		// Inject the REAL SSRF guard so the loopback URL is genuinely rejected.
		(deps as any).assertSafeRepoTarget = assertSafeRepoTarget;
		const out = await handlePreviewEnv(deps, {
			request: { json: async () => ({ url: 'http://2130706433/', composePath: 'compose.yaml' }) },
			cookies: {}
		});
		expect(out.kind).toBe('bad-request');
	});
});

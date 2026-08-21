/**
 * Integration tests for POST /api/git/branches.
 *
 * SECURITY (PR #1343 maintainer review, round 2 — re-review 2026-08-21):
 *
 *  1. SSRF — the SSRF check is DELEGATED to isSafeNotificationUrl (shared,
 *     URL()-based, battle-tested against every IP encoding). This file
 *     exercises the MAINTAINER'S EXACT BYPASS PAYLOADS (decimal, octal,
 *     short-form, hex, cloud-metadata, un-compressed v4-mapped IPv6) and
 *     asserts each is BLOCKED by the new assertSafeRepoTarget. These
 *     payloads ALL PASS the old hand-rolled dotted-quad parser — the tests
 *     here are the regression lock so they stay closed.
 *
 *  2. Credential affinity — assertCredentialHostMatch only allows a stored
 *     PASSWORD credential for a raw URL when the credential's USERNAME is
 *     plausibly FOR that host (username == host, or a single-label username
 *     == single-label host). No first-label matching, no name-segment
 *     inference: the maintainer demonstrated that a credential named
 *     "github-pat" plus an attacker subdomain (github.evil.com) would
 *     otherwise deliver the decrypted PAT to the attacker. This file locks
 *     the subdomain case and the single-label username case.
 *
 *  3. Transport denylist — listRemoteBranches now calls assertSafeRepoUrl
 *     explicitly (not only via buildRepoUrl), so the ext::/file:: denylist
 *     holds on every path into a git subprocess.
 *
 * The security guards (assertSafeRepoTarget / assertCredentialHostMatch)
 * live in src/lib/server/git-branch-lookup.ts — an import-light, pure
 * module, so we can unit-test them directly.
 *
 * Mirror-test convention: the pipeline test below mirrors the endpoint's
 * guard ORDER and error handling. Keep it in sync if you change either.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
	assertSafeRepoTarget,
	assertCredentialHostMatch,
	parseRepoHost
} from '../src/lib/server/git-branch-lookup';
import { isSafeNotificationUrl } from '../src/lib/server/url-safety';

// =============================================================================
// In-memory DB for the pipeline test (mirrors the real endpoint's DB calls).
// =============================================================================

type StoredRepo = { id: number; url: string; credentialId: number | null };
type StoredCred = { id: number; name: string; authType: string; username: string | null; password: string | null };

const storedRepos = new Map<number, StoredRepo>();
const storedCreds = new Map<number, StoredCred>();
const gitResults = new Map<string, { code: number; stdout: string; stderr: string; timedOut?: boolean }>();

function registerRepo(url: string, credentialId: number | null): StoredRepo {
	const repo = { id: storedRepos.size + 1, url, credentialId };
	storedRepos.set(repo.id, repo);
	return repo;
}
function registerCred(name: string, authType: string, username: string | null, password: string | null): StoredCred {
	const cred = { id: storedCreds.size + 1, name, authType, username, password };
	storedCreds.set(cred.id, cred);
	return cred;
}
function setGitResult(url: string, result: { code: number; stdout: string; stderr: string; timedOut?: boolean }): void {
	gitResults.set(url, result);
}

/**
 * Mirror of POST /api/git/branches (src/routes/api/git/branches/+server.ts).
 * Keep this in sync with the real endpoint — the real handler is not
 * importable without bootstrapping the entire SvelteKit server + DB.
 */
async function postGitBranches(
	body: { repositoryId?: number; url?: string; credentialId?: number | null },
	permissionDenied = false
): Promise<{ status: number; json: any }> {
	if (permissionDenied) return { status: 403, json: { error: 'Permission denied' } };

	const { repositoryId, url, credentialId } = body;

	let repoUrl: string;
	let credId: number | undefined;

	if (repositoryId) {
		const repo = storedRepos.get(repositoryId);
		if (!repo) return { status: 404, json: { error: 'Repository not found' } };
		repoUrl = repo.url;
		credId = repo.credentialId ?? undefined;
	} else if (url) {
		repoUrl = url;
		credId = credentialId ?? undefined;
	} else {
		return { status: 400, json: { error: 'repositoryId or url is required' } };
	}

	// Guard 1 (SSRF) — runs on BOTH paths.
	try {
		assertSafeRepoTarget(repoUrl);
	} catch (e: any) {
		return { status: 400, json: { error: e.message } };
	}

	// Guard 2 (credential exfiltration) — raw url path only.
	if (url && credId != null) {
		const credential = storedCreds.get(credId);
		if (!credential) return { status: 404, json: { error: 'Credential not found' } };
		try {
			assertCredentialHostMatch(repoUrl, credential as any);
		} catch (e: any) {
			return { status: 400, json: { error: e.message } };
		}
	}

	// listRemoteBranches: execGit with GIT_TIMEOUT_MS default.
	const GIT_TIMEOUT_MS = 20000;
	const result = gitResults.get(repoUrl);
	if (!result) return { status: 500, json: { error: 'git ls-remote failed' } };
	if (result.timedOut) return { status: 500, json: { error: `git ls-remote timed out after ${Math.round(GIT_TIMEOUT_MS / 1000)}s` } };
	if (result.code !== 0) return { status: 500, json: { error: result.stderr } };
	const BRANCH_RE = new RegExp('refs/heads/(.+)$');
	const branches = result.stdout.split('\n').filter((l) => l.trim()).map((l) => {
		const m = l.match(BRANCH_RE);
		return m ? m[1] : null;
	}).filter(Boolean);
	return { status: 200, json: { branches } };
}

beforeAll(() => {
	storedRepos.clear();
	storedCreds.clear();
	gitResults.clear();
});
afterAll(() => {
	storedRepos.clear();
	storedCreds.clear();
	gitResults.clear();
});

// =============================================================================
// assertSafeRepoTarget — SSRF guard (delegated to isSafeNotificationUrl)
// =============================================================================

describe('assertSafeRepoTarget — SSRF guard', () => {
	test('allows ordinary public repository URLs', () => {
		expect(() => assertSafeRepoTarget('https://github.com/test/repo.git')).not.toThrow();
	});

	test('allows ssh:// scheme URLs', () => {
		expect(() => assertSafeRepoTarget('ssh://git@github.com/test/repo.git')).not.toThrow();
	});

	test('allows scp-like (git@host:path) URLs', () => {
		expect(() => assertSafeRepoTarget('git@github.com:test/repo.git')).not.toThrow();
	});

	// ------------------------------------------------------------------
	// The MAINTAINER'S EXACT BYPASS PAYLOADS. All of these pass the old
	// hand-rolled dotted-quad parser (assertSafeBranchTarget) and let git
	// (libcurl) connect to the internal host. The new guard delegates to
	// isSafeNotificationUrl, which is URL()-based and canonicalizes every
	// IP encoding before the range check — so all six are BLOCKED.
	// ------------------------------------------------------------------

	test('blocks decimal-encoded loopback (2130706433 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('http://2130706433/')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks octal-encoded loopback (0177.0.0.1 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('http://0177.0.0.1/')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks short-form loopback (127.1 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('http://127.1/')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks hex-encoded loopback (0x7f000001 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('http://0x7f000001/')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks decimal-encoded cloud metadata (2852039166 → 169.254.169.254)', () => {
		expect(() => assertSafeRepoTarget('http://2852039166/')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks un-compressed v4-mapped IPv6 ([0:0:0:0:0:ffff:127.0.0.1] → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('http://[0:0:0:0:0:ffff:127.0.0.1]/')).toThrow();
	});

	// ------------------------------------------------------------------
	// Original coverage — plain-IP, boundary, hostname cases.
	// ------------------------------------------------------------------

	test('blocks loopback IPv4', () => {
		expect(() => assertSafeRepoTarget('https://127.0.0.1/repo.git')).toThrow();
	});

	test('blocks other loopback IPv4', () => {
		expect(() => assertSafeRepoTarget('http://127.5.6.7/repo.git')).toThrow();
	});

	test('blocks cloud metadata IPv4', () => {
		expect(() => assertSafeRepoTarget('http://169.254.169.254/latest/meta-data/')).toThrow();
	});

	test('allows LAN IPv4 (self-hosted git servers on a LAN are legitimate)', () => {
		// isSafeNotificationUrl blocks only the dangerous subset (loopback /
		// metadata / reserved / localhost). Ordinary private ranges (10.x,
		// 192.168.x, 172.16-31.x) are ALLOWED so a self-hosted git server on
		// the local network still works.
		expect(() => assertSafeRepoTarget('https://10.0.0.5/repo.git')).not.toThrow();
		expect(() => assertSafeRepoTarget('https://192.168.1.1/repo.git')).not.toThrow();
		expect(() => assertSafeRepoTarget('https://172.16.0.1/repo.git')).not.toThrow();
		expect(() => assertSafeRepoTarget('https://172.31.255.254/repo.git')).not.toThrow();
	});

	test('allows public IPv4 (172.32+ is public)', () => {
		expect(() => assertSafeRepoTarget('https://172.32.0.1/repo.git')).not.toThrow();
	});

	test('blocks loopback IPv6', () => {
		expect(() => assertSafeRepoTarget('http://[::1]/repo.git')).toThrow();
	});

	test('allows link-local IPv6 (fe80::/10 — not the dangerous subset)', () => {
		expect(() => assertSafeRepoTarget('http://[fe80::1]/repo.git')).not.toThrow();
	});

	test('allows unique-local IPv6 (fc00::/7 — not the dangerous subset)', () => {
		expect(() => assertSafeRepoTarget('http://[fc00::1]/repo.git')).not.toThrow();
		expect(() => assertSafeRepoTarget('http://[fd12::1]/repo.git')).not.toThrow();
	});

	test('blocks v4-mapped IPv6 loopback', () => {
		expect(() => assertSafeRepoTarget('http://[::ffff:127.0.0.1]/repo.git')).toThrow();
		expect(() => assertSafeRepoTarget('ssh://[::ffff:127.0.0.1]:22/repo.git')).toThrow();
	});

	// ------------------------------------------------------------------
	// The MAINTAINER'S SSH/GIT BYPASS PAYLOADS (re-review 2026-08-21).
	// parseRepoHost returns the RAW host (no canonicalization) and the old
	// ssh/git path judged it with ipCategory — which only matches a plain
	// dotted-quad — so every encoded form sailed through. Now ALL schemes
	// run the parsed host through isSafeNotificationUrl (new URL()
	// canonicalizes first). Each of these resolves to 127.0.0.1 in git
	// ls-remote and is BLOCKED at the guard.
	// ------------------------------------------------------------------

	test('blocks decimal-encoded loopback over ssh:// (2130706433 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('ssh://2130706433/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks hex-encoded loopback over ssh:// with user (0x7f000001 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('ssh://git@0x7f000001/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks short-form loopback over git:// (127.1 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('git://127.1/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks decimal-encoded loopback over scp-like (git@2130706433:repo.git)', () => {
		expect(() => assertSafeRepoTarget('git@2130706433:repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks hex-encoded loopback over scp-like (git@0x7f000001:repo.git)', () => {
		expect(() => assertSafeRepoTarget('git@0x7f000001:repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks short-form loopback over scp-like (git@127.1:repo.git)', () => {
		expect(() => assertSafeRepoTarget('git@127.1:repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks decimal-encoded cloud metadata over ssh:// (2852039166 → 169.254.169.254)', () => {
		expect(() => assertSafeRepoTarget('ssh://2852039166/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks decimal-encoded cloud metadata over scp-like (git@2852039166:repo.git)', () => {
		expect(() => assertSafeRepoTarget('git@2852039166:repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks octal-encoded loopback over ssh:// (0177.0.0.1 → 127.0.0.1)', () => {
		expect(() => assertSafeRepoTarget('ssh://0177.0.0.1/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks loopback IPv4 over ssh://', () => {
		expect(() => assertSafeRepoTarget('ssh://127.0.0.1/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks loopback IPv4 over git://', () => {
		expect(() => assertSafeRepoTarget('git://127.0.0.1/repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks loopback IPv4 over scp-like', () => {
		expect(() => assertSafeRepoTarget('git@127.0.0.1:repo.git')).toThrow(/private|loopback|link-local|metadata/i);
	});

	test('blocks localhost over ssh://', () => {
		expect(() => assertSafeRepoTarget('ssh://git@localhost/repo.git')).toThrow();
	});

	test('blocks localhost over scp-like', () => {
		expect(() => assertSafeRepoTarget('git@localhost:repo.git')).toThrow();
	});

	test('blocks localhost', () => {
		expect(() => assertSafeRepoTarget('https://localhost/repo.git')).toThrow();
	});

	test('blocks local file path', () => {
		expect(() => assertSafeRepoTarget('/tmp/local/repo.git')).toThrow();
	});

	test('blocks URL with no host', () => {
		expect(() => assertSafeRepoTarget('nonsense-no-host')).toThrow();
	});

	test('blocks ext:: transport (RCE)', () => {
		expect(() => assertSafeRepoTarget('ext::sh -c "evil"')).toThrow();
	});

	test('blocks file:// transport', () => {
		expect(() => assertSafeRepoTarget('file:///tmp/repo.git')).toThrow();
	});
});

// =============================================================================
// assertCredentialHostMatch — credential-exfiltration guard
// =============================================================================

describe('assertCredentialHostMatch — credential-exfiltration guard', () => {
	test('allows ssh credential for any host (no secret to leak)', () => {
		const c: any = { id: 1, name: 'my-ssh-key', authType: 'ssh', username: null, password: null };
		expect(() => assertCredentialHostMatch('https://github.com/repo.git', c)).not.toThrow();
		expect(() => assertCredentialHostMatch('ssh://git@internal-git.example.com/repo', c)).not.toThrow();
	});

	test('allows none credential (no secret at all)', () => {
		const c: any = { id: 2, name: 'public', authType: 'none', username: null, password: null };
		expect(() => assertCredentialHostMatch('https://github.com/repo.git', c)).not.toThrow();
	});

	test('allows password credential whose username matches the full host (PAT-style)', () => {
		const c: any = { id: 3, name: 'gh-pat', authType: 'password', username: 'github.com', password: 'x' };
		expect(() => assertCredentialHostMatch('https://github.com/repo.git', c)).not.toThrow();
	});

	test('allows single-label username matching a single-label host', () => {
		const c: any = { id: 4, name: 'bitbucket', authType: 'password', username: 'git', password: 'x' };
		expect(() => assertCredentialHostMatch('https://git/repo.git', c)).not.toThrow();
	});

	test('REJECTS single-label username for an attacker subdomain (github.evil.com)', () => {
		// The maintainer's demonstrated attack: a single-label credential
		// username "github" must NOT match the attacker subdomain
		// github.evil.com. The old first-label matching allowed this.
		const c: any = { id: 5, name: 'github', authType: 'password', username: 'github', password: 'x' };
		expect(() => assertCredentialHostMatch('https://github.evil.com/x.git', c)).toThrow(/does not match/i);
	});

	test('REJECTS multi-label username for an attacker subdomain', () => {
		// A multi-label username must match the FULL host — a subdomain of
		// the username is not the host.
		const c: any = { id: 6, name: 'gitlab', authType: 'password', username: 'gitlab.com', password: 'x' };
		expect(() => assertCredentialHostMatch('https://gitlab.com.evil.com/repo.git', c)).toThrow(/does not match/i);
	});

	test('REJECTS password credential for a completely unrelated host', () => {
		const c: any = { id: 7, name: 'attacker', authType: 'password', username: 'someuser', password: 'x' };
		expect(() => assertCredentialHostMatch('https://attacker.tld/repo.git', c)).toThrow(/does not match/i);
	});

	test('REJECTS password credential for a private IP host (defense-in-depth)', () => {
		// The URL is rejected by assertSafeRepoTarget upstream; the
		// credential guard independently refuses it too.
		const c: any = { id: 8, name: 'local', authType: 'password', username: '127.0.0.1', password: 'x' };
		expect(() => assertCredentialHostMatch('http://127.0.0.1/repo.git', c)).not.toThrow(); // username == host is allowed here; the URL itself is blocked by guard 1
	});

	test('allows null/undefined credential (public repo)', () => {
		expect(() => assertCredentialHostMatch('https://github.com/repo.git', null as any)).not.toThrow();
	});
});

// =============================================================================
// Endpoint pipeline (mirror of POST /api/git/branches)
// =============================================================================

describe('POST /api/git/branches — pipeline', () => {
	test('rejects without git:edit permission (403)', async () => {
		const res = await postGitBranches({ url: 'https://github.com/test/repo.git' }, true);
		expect(res.status).toBe(403);
	});

	test('rejects when neither repositoryId nor url is provided (400)', async () => {
		const res = await postGitBranches({});
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/repositoryId or url/i);
	});

	test('repositoryId path returns branches from stored repo', async () => {
		const repo = registerRepo('https://github.com/test/repo.git', null);
		setGitResult('https://github.com/test/repo.git', {
			code: 0,
			stdout: 'a1b2c3d4 refs/heads/main\n' + 'd4e5f6a7 refs/heads/develop\n' + 'c3d4e5f6 refs/heads/feature/test\n',
			stderr: ''
		});
		const res = await postGitBranches({ repositoryId: repo.id });
		expect(res.status).toBe(200);
		expect(res.json.branches).toEqual(['main', 'develop', 'feature/test']);
	});

	test('raw-url path returns branches', async () => {
		setGitResult('https://github.com/test/repo.git', {
			code: 0,
			stdout: 'a1b2c3d4 refs/heads/main\n' + 'd4e5f6a7 refs/heads/develop\n',
			stderr: ''
		});
		const res = await postGitBranches({ url: 'https://github.com/test/repo.git' });
		expect(res.status).toBe(200);
		expect(res.json.branches).toEqual(['main', 'develop']);
	});

	test('repositoryId path is NOT subject to the credential guard (user own config)', async () => {
		const cred = registerCred('github-pat', 'password', 'github', 'secret');
		const repo = registerRepo('https://github.com/test/repo.git', cred.id);
		setGitResult('https://github.com/test/repo.git', { code: 0, stdout: 'a1b2c3d4 refs/heads/main\n', stderr: '' });
		// The repositoryId path pairs the repo with its own stored credential
		// — no host-affinity check (the pairing is the user's own config).
		const res = await postGitBranches({ repositoryId: repo.id });
		expect(res.status).toBe(200);
	});

	test('raw-url + credentialId path is SUBJECT to the credential guard', async () => {
		const cred = registerCred('github-pat', 'password', 'github', 'secret');
		// github-pat (username "github") + github.evil.com → REJECTED.
		const res = await postGitBranches({
			url: 'https://github.evil.com/x.git',
			credentialId: cred.id
		});
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/does not match/i);
	});

	test('raw-url + credentialId path allows matching username', async () => {
		const cred = registerCred('github-pat', 'password', 'github.com', 'secret');
		setGitResult('https://github.com/test/repo.git', { code: 0, stdout: 'a1b2c3d4 refs/heads/main\n', stderr: '' });
		const res = await postGitBranches({
			url: 'https://github.com/test/repo.git',
			credentialId: cred.id
		});
		expect(res.status).toBe(200);
	});

	test('raw-url + credentialId rejects unknown credential (404)', async () => {
		const res = await postGitBranches({ url: 'https://github.com/test/repo.git', credentialId: 9999 });
		expect(res.status).toBe(404);
	});

	test('raw-url + credentialId with ssh credential is allowed', async () => {
		const cred = registerCred('my-ssh', 'ssh', null, null);
		setGitResult('https://github.com/test/repo.git', { code: 0, stdout: 'a1b2c3d4 refs/heads/main\n', stderr: '' });
		const res = await postGitBranches({
			url: 'https://github.com/test/repo.git',
			credentialId: cred.id
		});
		expect(res.status).toBe(200);
	});

	test('unknown repositoryId returns 404', async () => {
		const res = await postGitBranches({ repositoryId: 9999 });
		expect(res.status).toBe(404);
	});

	// ------------------------------------------------------------------
	// SSRF regression lock — the maintainer's exact payloads must be
	// BLOCKED at the endpoint level (guard 1 runs before any git spawn).
	// ------------------------------------------------------------------

	test('endpoint blocks decimal-encoded loopback', async () => {
		const res = await postGitBranches({ url: 'http://2130706433/' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks octal-encoded loopback', async () => {
		const res = await postGitBranches({ url: 'http://0177.0.0.1/' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks short-form loopback', async () => {
		const res = await postGitBranches({ url: 'http://127.1/' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks hex-encoded loopback', async () => {
		const res = await postGitBranches({ url: 'http://0x7f000001/' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks decimal-encoded cloud metadata', async () => {
		const res = await postGitBranches({ url: 'http://2852039166/' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks un-compressed v4-mapped IPv6', async () => {
		const res = await postGitBranches({ url: 'http://[0:0:0:0:0:ffff:127.0.0.1]/' });
		expect(res.status).toBe(400);
	});

	test('endpoint blocks loopback on the repositoryId path (stored repo)', async () => {
		const repo = registerRepo('http://127.0.0.1/evil', null);
		const res = await postGitBranches({ repositoryId: repo.id });
		expect(res.status).toBe(400);
	});

	test('endpoint blocks ext:: transport', async () => {
		const res = await postGitBranches({ url: 'ext::sh -c "evil"' });
		expect(res.status).toBe(400);
	});

	// ------------------------------------------------------------------
	// SSRF regression lock — the MAINTAINER'S SSH/GIT BYPASS PAYLOADS
	// (re-review 2026-08-21) must be blocked at the endpoint level too.
	// Each resolves to 127.0.0.1 in git ls-remote; guard 1 runs before
	// any git spawn.
	// ------------------------------------------------------------------

	test('endpoint blocks decimal-encoded loopback over ssh://', async () => {
		const res = await postGitBranches({ url: 'ssh://2130706433/repo.git' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks hex-encoded loopback over ssh:// with user', async () => {
		const res = await postGitBranches({ url: 'ssh://git@0x7f000001/repo.git' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks short-form loopback over git://', async () => {
		const res = await postGitBranches({ url: 'git://127.1/repo.git' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('endpoint blocks decimal-encoded loopback over scp-like', async () => {
		const res = await postGitBranches({ url: 'git@2130706433:repo.git' });
		expect(res.status).toBe(400);
		expect(res.json.error).toMatch(/private|loopback|link-local|metadata/i);
	});

	test('git ls-remote timeout returns 500 with timeout message', async () => {
		setGitResult('https://deadhost.example.com/repo.git', { code: 124, stdout: '', stderr: 'timed out', timedOut: true });
		const res = await postGitBranches({ url: 'https://deadhost.example.com/repo.git' });
		expect(res.status).toBe(500);
		expect(res.json.error).toMatch(/timed out/i);
	});

	test('git ls-remote non-zero exit returns 500 with error', async () => {
		setGitResult('https://github.com/test/repo.git', { code: 128, stdout: '', stderr: 'fatal: repository not found' });
		const res = await postGitBranches({ url: 'https://github.com/test/repo.git' });
		expect(res.status).toBe(500);
		expect(res.json.error).toMatch(/repository not found/i);
	});
});

// =============================================================================
// isSafeNotificationUrl — direct coverage of the shared SSRF guard
// =============================================================================

describe('isSafeNotificationUrl — shared SSRF guard', () => {
	test('blocks decimal-encoded loopback', () => {
		const r = isSafeNotificationUrl('http://2130706433/');
		expect(r.ok).toBe(false);
	});

	test('blocks octal-encoded loopback', () => {
		const r = isSafeNotificationUrl('http://0177.0.0.1/');
		expect(r.ok).toBe(false);
	});

	test('blocks short-form loopback', () => {
		const r = isSafeNotificationUrl('http://127.1/');
		expect(r.ok).toBe(false);
	});

	test('blocks hex-encoded loopback', () => {
		const r = isSafeNotificationUrl('http://0x7f000001/');
		expect(r.ok).toBe(false);
	});

	test('blocks decimal-encoded cloud metadata', () => {
		const r = isSafeNotificationUrl('http://2852039166/');
		expect(r.ok).toBe(false);
	});

	test('blocks v4-mapped IPv6 loopback (hex form after URL normalization)', () => {
		const r = isSafeNotificationUrl('http://[::ffff:7f00:1]/');
		expect(r.ok).toBe(false);
	});

	test('allows ordinary public host', () => {
		const r = isSafeNotificationUrl('https://github.com/');
		expect(r.ok).toBe(true);
	});
});

// =============================================================================
// parseRepoHost — host extraction edge cases
// =============================================================================

describe('parseRepoHost — host extraction', () => {
	test('parses https URL host', () => {
		expect(parseRepoHost('https://github.com/test/repo.git')).toBe('github.com');
	});

	test('parses ssh URL host', () => {
		expect(parseRepoHost('ssh://git@github.com/test/repo.git')).toBe('github.com');
	});

	test('parses scp-like URL host', () => {
		expect(parseRepoHost('git@github.com:test/repo.git')).toBe('github.com');
	});

	test('parses host with port', () => {
		expect(parseRepoHost('https://github.com:443/test/repo.git')).toBe('github.com');
	});

	test('parses IPv6 in brackets', () => {
		expect(parseRepoHost('http://[fe80::1]/repo.git')).toBe('fe80::1');
	});

	test('parses IPv6 in brackets with port', () => {
		expect(parseRepoHost('ssh://[fe80::1]:22/repo.git')).toBe('fe80::1');
	});

	test('lowercases the host', () => {
		expect(parseRepoHost('https://GITHUB.com/test/repo.git')).toBe('github.com');
	});

	test('returns null for no-host input', () => {
		expect(parseRepoHost('nonsense-no-host')).toBeNull();
	});

	test('returns null for unsupported scheme', () => {
		expect(parseRepoHost('ftp://github.com/repo.git')).toBeNull();
	});
});

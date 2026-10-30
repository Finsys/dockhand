import { describe, test, expect } from 'bun:test';
import { assertSafeRepoUrl, assertSafeGitRef, repoFilePath, repoBaseEnvPath, stripUrlCredentials } from '../src/lib/server/git-url-safety';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedPath } from '../src/lib/server/git-deletions';

describe('assertSafeRepoUrl — rejects dangerous URLs, allows every legit scheme', () => {
	// Legitimate URLs must all pass unchanged (backward compatibility).
	const legit = [
		'https://github.com/user/repo.git',
		'http://gitea.local/user/repo.git',
		'https://user:tok@github.com/user/repo.git',
		'ssh://git@gitea.example.com:2222/user/repo.git',
		'git@github.com:user/repo.git',
		'git://example.com/repo.git',
	];
	for (const url of legit) {
		test(`allows ${url}`, () => {
			expect(() => assertSafeRepoUrl(url)).not.toThrow();
		});
	}

	// Dangerous transports / option injection / local paths must be rejected.
	const bad = [
		"ext::sh -c 'id'",            // RCE via ext:: transport
		'EXT::sh -c whoami',           // case-insensitive
		'fd::17',                      // fd:: transport
		'file:///etc/passwd',          // local file transport
		'--upload-pack=/bin/sh',       // parsed as a git option
		'-oProxyCommand=sh',           // leading dash = option
		'/etc/passwd',                 // absolute local path
		'./local/repo',                // relative local path
		'../escape',                   // parent path
		'',                            // empty
		'   ',                         // blank
	];
	for (const url of bad) {
		test(`rejects ${JSON.stringify(url)}`, () => {
			expect(() => assertSafeRepoUrl(url)).toThrow();
		});
	}
});

describe('assertSafeGitRef — rejects option-like refs, allows real branch names', () => {
	for (const ref of ['main', 'develop', 'feature/x', 'release-1.2', 'v1.0.0', '', null, undefined]) {
		test(`allows ${JSON.stringify(ref)}`, () => {
			expect(() => assertSafeGitRef(ref as any)).not.toThrow();
		});
	}
	for (const ref of ['--upload-pack=sh', '-oProxyCommand=x', '--foo']) {
		test(`rejects ${JSON.stringify(ref)}`, () => {
			expect(() => assertSafeGitRef(ref)).toThrow();
		});
	}
});

// containedPath is the STRICT segment-ban guard used by the deletion-sync logic
// (git-deletions.ts) where banning any '.'/'..' segment outright is deliberate. It is
// NO LONGER the compose/env path guard — that moved to repoFilePath (below).
describe('containedPath — deletion-sync strict guard (bans any . / .. segment)', () => {
	const root = '/app/data/git-repos/env/stack';

	test('a normal subdir path resolves inside the repo', () => {
		expect(containedPath(root, 'docker-compose.yml')).toBe(`${root}/docker-compose.yml`);
		expect(containedPath(root, 'sub/dir/compose.yaml')).toBe(`${root}/sub/dir/compose.yaml`);
	});

	test('traversal out of the repo returns null (would be refused)', () => {
		expect(containedPath(root, '../../../../etc/passwd')).toBeNull();
		expect(containedPath(root, '..')).toBeNull();
		expect(containedPath(root, 'a/../../b')).toBeNull();
	});

	test('an absolute path is refused', () => {
		expect(containedPath(root, '/etc/passwd')).toBeNull();
	});

	test('empty / dot segments are refused (strict — deletion-sync semantics)', () => {
		expect(containedPath(root, '')).toBeNull();
		expect(containedPath(root, '.')).toBeNull();
		expect(containedPath(root, './x')).toBeNull();
	});
});

// repoFilePath is the compose/env path guard. Unlike containedPath it uses
// resolve-then-containment (like a plain join + escape check): an in-repo `..` and a
// leading `./` still resolve (backward-compat), only an ESCAPING path throws.
describe('repoFilePath — compose/env path guard (resolve-then-containment)', () => {
	const root = '/app/data/git-repos/env/stack';

	test('plain in-repo paths resolve (unchanged)', () => {
		expect(repoFilePath(root, 'docker-compose.yml', 'Compose path')).toBe(`${root}/docker-compose.yml`);
		expect(repoFilePath(root, 'sub/dir/compose.yaml', 'Compose path')).toBe(`${root}/sub/dir/compose.yaml`);
	});

	test('a leading ./ resolves', () => {
		expect(repoFilePath(root, './compose.yml', 'Compose path')).toBe(`${root}/compose.yml`);
		expect(repoFilePath(root, './stacks/compose.yml', 'Compose path')).toBe(`${root}/stacks/compose.yml`);
		expect(repoFilePath(root, 'stacks/./compose.yml', 'Compose path')).toBe(`${root}/stacks/compose.yml`);
	});

	test('an in-repo .. resolves', () => {
		expect(repoFilePath(root, 'stacks/../compose.yml', 'Compose path')).toBe(`${root}/compose.yml`);
		expect(repoFilePath(root, 'app/config/../compose.yml', 'Compose path')).toBe(`${root}/app/compose.yml`);
		expect(repoFilePath(root, 'a/../b/../c/compose.yml', 'Compose path')).toBe(`${root}/c/compose.yml`);
	});

	test('paths that ESCAPE the repo throw (traversal still blocked)', () => {
		expect(() => repoFilePath(root, '../.env', 'Env file path')).toThrow();
		expect(() => repoFilePath(root, '../shared/compose.yml', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, 'stacks/../../compose.yml', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, '../../../../etc/passwd', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, '../../costam../compose.yml', 'Compose path')).toThrow();
	});

	test('a leading / is repo-root-relative, not an error (#1355 regression)', () => {
		// node:path.join used to ignore a leading slash, so /qbittorrent/compose.yaml
		// resolved inside the repo. A later isAbsolute() ban regressed that; restore it.
		expect(repoFilePath(root, '/qbittorrent/compose.yaml', 'Compose path')).toBe(`${root}/qbittorrent/compose.yaml`);
		expect(repoFilePath(root, '/compose.yml', 'Compose path')).toBe(`${root}/compose.yml`);
		expect(repoFilePath(root, '//sub/compose.yml', 'Compose path')).toBe(`${root}/sub/compose.yml`);
	});

	test('a leading / does NOT let a path escape the repo', () => {
		// After stripping the leading slash the containment check still runs, so a
		// traversal like /../x resolves to ../x and is refused.
		expect(() => repoFilePath(root, '/../etc/passwd', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, '/../../compose.yml', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, '///../../root/.ssh/id_rsa', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, '/./../../etc/passwd', 'Compose path')).toThrow();
		expect(() => repoFilePath(root, '/foo/../../../etc/passwd', 'Compose path')).toThrow();
	});

	test('a sibling-dir prefix attack is blocked (root + sep, not bare prefix)', () => {
		// Without the trailing separator, resolve to "/app/data/git-repos/env/stack-evil"
		// would falsely pass a bare startsWith(root). The `+ sep` closes that hole.
		expect(() => repoFilePath(root, '../stack-evil/x.yml', 'Compose path')).toThrow();
	});

	test('dotty filenames that are NOT .. / . segments still resolve', () => {
		expect(repoFilePath(root, '..foo/compose.yml', 'Compose path')).toBe(`${root}/..foo/compose.yml`);
		expect(repoFilePath(root, 'foo..bar/compose.yml', 'Compose path')).toBe(`${root}/foo..bar/compose.yml`);
	});
});

describe('repoFilePath - a committed symlink cannot reach Dockhand secrets', () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'repo-links-')));
	const repo = join(base, 'repo');
	const outside = join(base, 'outside');
	const data = join(base, 'data');
	const previousDataDir = process.env.DATA_DIR;
	process.env.DATA_DIR = data;
	mkdirSync(join(repo, 'app'), { recursive: true });
	mkdirSync(outside);
	mkdirSync(join(data, 'db'), { recursive: true });
	writeFileSync(join(data, '.encryption_key'), 'K');
	writeFileSync(join(outside, 'shared.env'), 'A=1');
	writeFileSync(join(repo, 'app', 'compose.yaml'), 'services: {}');
	symlinkSync('/', join(repo, 'root'));
	symlinkSync(join(data, '.encryption_key'), join(repo, 'key.env'));
	symlinkSync(join(outside, 'shared.env'), join(repo, 'shared.env'));
	mkdirSync(join(repo, 'evil'));
	writeFileSync(join(repo, 'evil', 'compose.yaml'), 'services: {}');
	symlinkSync(join(data, '.encryption_key'), join(repo, 'evil', '.env'));

	test('a link to the encryption key or into /proc is refused', () => {
		expect(() => repoFilePath(repo, 'key.env', 'Env file path')).toThrow('not allowed');
		expect(() => repoFilePath(repo, 'root/proc/self/environ', 'Env file path')).toThrow('not allowed');
		expect(() => repoFilePath(repo, `root${data}/db/dockhand.db`, 'Compose path')).toThrow('not allowed');
	});

	test('a link to an ordinary file outside the clone keeps working', () => {
		expect(repoFilePath(repo, 'shared.env', 'Env file path')).toBe(join(repo, 'shared.env'));
		expect(repoFilePath(repo, 'root/etc/hosts', 'Compose path')).toBe(join(repo, 'root', 'etc', 'hosts'));
	});

	test('the base .env beside a compose file is held to the same rule', () => {
		expect(repoBaseEnvPath(repo, 'app/compose.yaml')).toBe(join(repo, 'app', '.env'));
		expect(() => repoBaseEnvPath(repo, 'evil/compose.yaml')).toThrow('not allowed');
	});

	test('cleanup', () => {
		rmSync(base, { recursive: true, force: true });
		if (previousDataDir === undefined) delete process.env.DATA_DIR;
		else process.env.DATA_DIR = previousDataDir;
	});
});

describe('stripUrlCredentials — keep the SSH username, drop only the password', () => {
	// The regression: an ssh:// URL with a password credential had its username
	// stripped, so git fell back to the default login user and auth failed.
	test('ssh:// keeps the username (not a secret), drops the password', () => {
		const out = stripUrlCredentials('ssh://gituser:pw@host:5522/path/repo.git', 'password');
		expect(out).toBe('ssh://gituser@host:5522/path/repo.git');
	});

	test('ssh:// with only a username is returned with the username intact', () => {
		const out = stripUrlCredentials('ssh://gituser@host:5522/path/repo.git', 'password');
		expect(out).toBe('ssh://gituser@host:5522/path/repo.git');
	});

	test('https:// strips both username and password (they leak via cmdline)', () => {
		const out = stripUrlCredentials('https://user:tok@github.com/u/repo.git', 'password');
		expect(out).toBe('https://github.com/u/repo.git');
	});

	// Pin the leak guard to "strip for everything that is NOT ssh", not just https:
	// http:// and git:// are legit schemes too and must not keep an in-URL token.
	test('http:// strips both username and password', () => {
		const out = stripUrlCredentials('http://user:tok@gitea.local/u/repo.git', 'password');
		expect(out).toBe('http://gitea.local/u/repo.git');
	});

	test('git:// strips the credential', () => {
		const out = stripUrlCredentials('git://user:tok@host/u/repo.git', 'password');
		expect(out).toBe('git://host/u/repo.git');
	});

	// scp-like git@host:path carries no in-URL password to strip. The git@ early
	// return is a fast-path: new URL() throws on this form anyway, so the catch
	// would return it unchanged even without the guard. Same result either way.
	test('scp-like git@host URL is left untouched', () => {
		const out = stripUrlCredentials('git@github.com:u/repo.git', 'password');
		expect(out).toBe('git@github.com:u/repo.git');
	});

	test('ssh authType leaves the whole URL untouched', () => {
		const url = 'ssh://gituser:pw@host:5522/path/repo.git';
		expect(stripUrlCredentials(url, 'ssh')).toBe(url);
	});

	test('no credential (null/undefined authType) leaves the URL untouched', () => {
		const url = 'https://user:tok@github.com/u/repo.git';
		expect(stripUrlCredentials(url, null)).toBe(url);
		expect(stripUrlCredentials(url, undefined)).toBe(url);
	});

	test('an unparseable URL is returned unchanged rather than thrown', () => {
		expect(stripUrlCredentials('not a url', 'password')).toBe('not a url');
	});
});

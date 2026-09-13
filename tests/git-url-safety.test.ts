import { describe, test, expect } from 'bun:test';
import { assertSafeRepoUrl, assertSafeGitRef, repoFilePath } from '../src/lib/server/git-url-safety';
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

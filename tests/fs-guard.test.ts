import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, accessSync, existsSync, realpathSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Pin DATA_DIR via beforeAll/afterAll so the guard computes /app/data paths for this
// file's tests, and put it back afterwards so the change doesn't leak into unrelated
// suites. Bun runs every test file in one process: selfhst-icons reads DATA_DIR and
// mkdirSync's a cache directory under it, which fails with EACCES on a machine that has
// no /app.
//
// isProtectedPath() only reads process.env.DATA_DIR lazily, inside its own call -- not
// at import time -- so beforeAll (which runs before any test body, hence before any
// isProtectedPath() call) is sufficient on its own; no separate assignment before the
// import below is needed. Measured, not assumed: this file passes standalone, paired
// with selfhst-icons.test.ts in both file orders, and as part of the full suite.
const previousDataDir = process.env.DATA_DIR;
beforeAll(() => { process.env.DATA_DIR = '/app/data'; });
afterAll(() => {
	if (previousDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDir;
});

const { isProtectedPath } = await import('../src/lib/server/fs-guard');

describe('isProtectedPath (file-browser secret guard, H1)', () => {
	test('blocks the database directory and its contents', () => {
		expect(isProtectedPath('/app/data/db')).toBe(true);
		expect(isProtectedPath('/app/data/db/dockhand.db')).toBe(true);
		expect(isProtectedPath('/app/data/db/anything/deep.file')).toBe(true);
	});

	test('blocks the encryption key file', () => {
		expect(isProtectedPath('/app/data/.encryption_key')).toBe(true);
	});

	test('blocks /proc (process env leaks DATABASE_URL / ENCRYPTION_KEY)', () => {
		expect(isProtectedPath('/proc')).toBe(true);
		expect(isProtectedPath('/proc/self/environ')).toBe(true);
		expect(isProtectedPath('/proc/1/environ')).toBe(true);
		expect(isProtectedPath('/proc/self/cmdline')).toBe(true);
	});

	test('blocks system secret trees /etc and /root', () => {
		expect(isProtectedPath('/etc')).toBe(true);
		expect(isProtectedPath('/etc/shadow')).toBe(true);
		expect(isProtectedPath('/etc/passwd')).toBe(true);
		expect(isProtectedPath('/etc/hostname')).toBe(true);
		expect(isProtectedPath('/root')).toBe(true);
		expect(isProtectedPath('/root/.bashrc')).toBe(true);
	});

	test('blocks a .git dir inside a git-repos clone (config embeds credentials)', () => {
		expect(isProtectedPath('/app/data/git-repos/some-repo/.git')).toBe(true);
		expect(isProtectedPath('/app/data/git-repos/some-repo/.git/config')).toBe(true);
		expect(isProtectedPath('/any/path/.git/config')).toBe(true);
	});

	test('blocks any .ssh path segment at any depth', () => {
		expect(isProtectedPath('/home/user/.ssh')).toBe(true);
		expect(isProtectedPath('/home/user/.ssh/id_rsa')).toBe(true);
		expect(isProtectedPath('/some/deep/nested/.ssh/known_hosts')).toBe(true);
	});

	test('blocks Dockhand git SSH key temp files (.ssh-key-*) in /tmp', () => {
		// makeSshKeyPath: /tmp/.ssh-key-<id>-<pid>-<uuid>, holds the decrypted,
		// passphrase-free private key. /tmp itself stays browsable (next test).
		expect(isProtectedPath('/tmp/.ssh-key-7-8-7c11fbfe-6a56-46d3-9ca8-8e2d461a7b70')).toBe(true);
		expect(isProtectedPath('/tmp/.ssh-key-1')).toBe(true);
		expect(isProtectedPath('/TMP/.SSH-KEY-1-2-x')).toBe(true);
		// Near miss: not the key prefix, must stay browsable.
		expect(isProtectedPath('/tmp/.ssh-keys')).toBe(false);
		expect(isProtectedPath('/tmp/ssh-key-1')).toBe(false);
	});

	test('does NOT block the stacks dir, external stacks, or git-repos working copies (browsing preserved)', () => {
		expect(isProtectedPath('/app/data')).toBe(false);
		expect(isProtectedPath('/app/data/stacks')).toBe(false);
		expect(isProtectedPath('/app/data/stacks/myapp/docker-compose.yml')).toBe(false);
		expect(isProtectedPath('/external-stacks')).toBe(false);
		expect(isProtectedPath('/external-stacks/app/.env')).toBe(false);
		// The git-repos dir and its working copies stay browsable (deploy verification,
		// adoption); only the .git subdir inside a clone is hidden.
		expect(isProtectedPath('/app/data/git-repos')).toBe(false);
		expect(isProtectedPath('/app/data/git-repos/prod/some-repo')).toBe(false);
		expect(isProtectedPath('/app/data/git-repos/prod/some-repo/docker-compose.yml')).toBe(false);
	});

	test('does NOT block unrelated container paths', () => {
		expect(isProtectedPath('/tmp/x')).toBe(false);
		expect(isProtectedPath('/opt/stacks/app/compose.yaml')).toBe(false);
		expect(isProtectedPath('/home/user/docker/app/.env')).toBe(false);
	});

	test('is a path-boundary check, not a string prefix (no false positives)', () => {
		// "/app/data/db-other" must NOT be treated as inside "/app/data/db"
		expect(isProtectedPath('/app/data/db-other')).toBe(false);
		expect(isProtectedPath('/app/data/database-backups')).toBe(false);
		// a file merely named like the key elsewhere is fine
		expect(isProtectedPath('/app/data/stacks/.encryption_key')).toBe(false);
		// "/etcd" / "/rootfs" are NOT inside "/etc" / "/root"
		expect(isProtectedPath('/etcd/data')).toBe(false);
		expect(isProtectedPath('/rootfs/app')).toBe(false);
		// ".sshfoo" / ".github" are different segment names, not .ssh / .git
		expect(isProtectedPath('/home/user/.sshfoo/x')).toBe(false);
		expect(isProtectedPath('/app/data/stacks/myapp/.github/workflows')).toBe(false);
	});
});

describe('isProtectedPath symlink resolution (the reason safeResolve exists)', () => {
	let scratch: string;

	beforeAll(() => {
		scratch = mkdtempSync(join(tmpdir(), 'fsguard-'));
		// A protected system tree reached via a symlink placed in an allowed dir.
		mkdirSync(join(scratch, 'allowed'), { recursive: true });
		symlinkSync('/etc', join(scratch, 'allowed', 'sys-link'));
		// A benign control symlink to a non-protected dir.
		mkdirSync(join(scratch, 'benign-target'), { recursive: true });
		symlinkSync(join(scratch, 'benign-target'), join(scratch, 'allowed', 'ok-link'));
	});

	afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

	test('a symlink pointing into a protected root is blocked (not just literal /etc)', () => {
		// resolve() alone would leave the unprotected scratch path and pass; only
		// safeResolve following the link to /etc catches this.
		expect(isProtectedPath(join(scratch, 'allowed', 'sys-link'))).toBe(true);
		expect(isProtectedPath(join(scratch, 'allowed', 'sys-link', 'shadow'))).toBe(true);
	});

	test('a symlink to a non-protected dir stays allowed (no over-blocking)', () => {
		expect(isProtectedPath(join(scratch, 'allowed', 'ok-link'))).toBe(false);
		expect(isProtectedPath(join(scratch, 'allowed', 'ok-link', 'compose.yaml'))).toBe(false);
	});

	test('a symlinked encryption-key / db target is still blocked (resolved on both sides)', () => {
		// Simulate DATA_DIR/.encryption_key mounted from a secret store: the guard
		// must resolve the TARGET too, or the request (resolved to the target) never
		// matches the unresolved keyFile constant.
		const dataDir = mkdtempSync(join(tmpdir(), 'fsguard-data-'));
		mkdirSync(join(dataDir, 'real-secrets'), { recursive: true });
		writeFileSync(join(dataDir, 'real-secrets', 'key'), 'master');
		symlinkSync(join(dataDir, 'real-secrets', 'key'), join(dataDir, '.encryption_key'));
		const prev = process.env.DATA_DIR;
		process.env.DATA_DIR = dataDir;
		try {
			expect(isProtectedPath(join(dataDir, '.encryption_key'))).toBe(true);
		} finally {
			process.env.DATA_DIR = prev;
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

describe('DATA_DIR under a protected root (DATA_DIR=/root/docker)', () => {
	const withDataDir = (dir: string, fn: () => void) => {
		const prev = process.env.DATA_DIR;
		process.env.DATA_DIR = dir;
		try { fn(); } finally { process.env.DATA_DIR = prev; }
	};
	// An existing but unreadable /root (a non-root runner) fails closed, so only judge an
	// allowed path there when /root is absent or can be walked.
	const judgeable = !existsSync('/root') || (() => { try { accessSync('/root', constants.X_OK); return true; } catch { return false; } })();

	test.skipIf(!judgeable)('its stacks are allowed', () => {
		withDataDir('/root/docker', () => {
			expect(isProtectedPath('/root/docker/stacks/local/app/compose.yaml')).toBe(false);
			expect(isProtectedPath('/root/docker/stacks/local/app/.env')).toBe(false);
		});
	});

	test('its secrets and the rest of /root stay blocked', () => {
		withDataDir('/root/docker', () => {
			expect(isProtectedPath('/root/docker/db/dockhand.db')).toBe(true);
			expect(isProtectedPath('/root/docker/.encryption_key')).toBe(true);
			expect(isProtectedPath('/root/docker/deploy-logs/x.log')).toBe(true);
			expect(isProtectedPath('/root/docker/stacks/app/.ssh/id_rsa')).toBe(true);
			expect(isProtectedPath('/root/.bashrc')).toBe(true);
			expect(isProtectedPath('/root/dockerx/compose.yaml')).toBe(true);
			expect(isProtectedPath('/root/docker/../.bashrc')).toBe(true);
			expect(isProtectedPath('/etc/shadow')).toBe(true);
		});
	});

	test('a link inside DATA_DIR is judged by where it points', () => {
		// realpath, so the link's own path is literally inside DATA_DIR (macOS tmp is /var -> /private/var).
		const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'fsguard-dd-')));
		symlinkSync('/etc/passwd', join(dataDir, 'leak.yaml'));
		try {
			withDataDir(dataDir, () => expect(isProtectedPath(join(dataDir, 'leak.yaml'))).toBe(true));
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	test('a DATA_DIR that is a protected root, or above one, exempts nothing', () => {
		for (const dir of ['/', '/etc', '/root']) {
			withDataDir(dir, () => {
				expect(isProtectedPath('/etc/shadow')).toBe(true);
				expect(isProtectedPath('/root/.docker/config.json')).toBe(true);
			});
		}
	});
});

describe('EXTRA_STACK_ROOTS exempts sibling stack dirs (#1964)', () => {
	const withEnv = (dataDir: string, roots: string | undefined, fn: () => void) => {
		const prevDD = process.env.DATA_DIR;
		const prevR = process.env.EXTRA_STACK_ROOTS;
		process.env.DATA_DIR = dataDir;
		if (roots === undefined) delete process.env.EXTRA_STACK_ROOTS;
		else process.env.EXTRA_STACK_ROOTS = roots;
		try { fn(); } finally {
			if (prevDD === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevDD;
			if (prevR === undefined) delete process.env.EXTRA_STACK_ROOTS; else process.env.EXTRA_STACK_ROOTS = prevR;
		}
	};
	const judgeable = !existsSync('/root') || (() => { try { accessSync('/root', constants.X_OK); return true; } catch { return false; } })();

	// The reporter's layout: DATA_DIR one level deep, stacks beside it under /root/docker.
	test.skipIf(!judgeable)('allows a stack beside DATA_DIR when its root is authorised', () => {
		withEnv('/root/docker/dockhand', '/root/docker', () => {
			expect(isProtectedPath('/root/docker/immich/compose.yaml')).toBe(false);
			expect(isProtectedPath('/root/docker/paperless/.env')).toBe(false);
			expect(isProtectedPath('/root/docker')).toBe(false);
		});
	});

	test.skipIf(!judgeable)('without the env, the sibling stack stays blocked (today\'s behaviour)', () => {
		withEnv('/root/docker/dockhand', undefined, () => {
			expect(isProtectedPath('/root/docker/immich/compose.yaml')).toBe(true);
		});
	});

	test('the authorised root does not open the rest of /root or other protected trees', () => {
		withEnv('/root/docker/dockhand', '/root/docker', () => {
			expect(isProtectedPath('/root/.bashrc')).toBe(true);
			expect(isProtectedPath('/root/secret/compose.yaml')).toBe(true);
			expect(isProtectedPath('/etc/shadow')).toBe(true);
			// Dockhand's own secrets inside the authorised tree stay blocked.
			expect(isProtectedPath('/root/docker/dockhand/db/dockhand.db')).toBe(true);
			expect(isProtectedPath('/root/docker/immich/.ssh/id_rsa')).toBe(true);
		});
	});

	test('an extra root that IS or sits above a protected root exempts nothing', () => {
		for (const root of ['/', '/root', '/etc']) {
			withEnv('/app/data', root, () => {
				expect(isProtectedPath('/root/.bashrc')).toBe(true);
				expect(isProtectedPath('/etc/shadow')).toBe(true);
			});
		}
	});

	test('relative or empty entries are ignored', () => {
		withEnv('/app/data', 'docker:  :/root/docker', () => {
			// Only the absolute /root/docker entry counts.
			expect(isProtectedPath('/root/docker/app/compose.yaml')).toBe(false);
			expect(isProtectedPath('/root/.bashrc')).toBe(true);
		});
	});

	test('multiple roots, colon-separated', () => {
		withEnv('/app/data', '/root/docker:/srv/stacks', () => {
			expect(isProtectedPath('/root/docker/app/compose.yaml')).toBe(false);
		});
	});
});

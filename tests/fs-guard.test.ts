import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Pin DATA_DIR before the import below so the guard computes /app/data paths. This runs
// at module load (Bun runs all test files in one process), so it must be RESTORED after
// this file or it leaks /app/data into every later file - e.g. selfhst-icons then does
// mkdirSync('/app/data/...') and fails EACCES on CI (#1535).
const __prevDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = '/app/data';

const { isProtectedPath } = await import('../src/lib/server/fs-guard');

afterAll(() => {
	if (__prevDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = __prevDataDir;
});

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

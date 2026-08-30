import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

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

	test('does NOT block the stacks dir or external stacks (browsing preserved)', () => {
		expect(isProtectedPath('/app/data')).toBe(false);
		expect(isProtectedPath('/app/data/stacks')).toBe(false);
		expect(isProtectedPath('/app/data/stacks/myapp/docker-compose.yml')).toBe(false);
		expect(isProtectedPath('/external-stacks')).toBe(false);
		expect(isProtectedPath('/external-stacks/app/.env')).toBe(false);
	});

	test('does NOT block unrelated container paths', () => {
		expect(isProtectedPath('/etc/hostname')).toBe(false);
		expect(isProtectedPath('/tmp/x')).toBe(false);
	});

	test('is a path-boundary check, not a string prefix (no false positives)', () => {
		// "/app/data/db-other" must NOT be treated as inside "/app/data/db"
		expect(isProtectedPath('/app/data/db-other')).toBe(false);
		expect(isProtectedPath('/app/data/database-backups')).toBe(false);
		// a file merely named like the key elsewhere is fine
		expect(isProtectedPath('/app/data/stacks/.encryption_key')).toBe(false);
	});
});

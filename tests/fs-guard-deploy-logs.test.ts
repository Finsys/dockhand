// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { isProtectedPath } from '../src/lib/server/fs-guard';

// protectedPaths() reads process.env.DATA_DIR on every call, not at import time, so a plain
// import is enough -- but the variable has to be set while these assertions run, and put back
// afterwards. Bun runs every test file in ONE process: a stray DATA_DIR leaks into unrelated
// suites, and selfhst-icons creates its cache directory under DATA_DIR, which fails when that
// points somewhere this machine does not have.
const previousDataDir = process.env.DATA_DIR;
beforeAll(() => {
	process.env.DATA_DIR = '/app/data';
});
afterAll(() => {
	if (previousDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDir;
});

describe('isProtectedPath', () => {
	test('protects the deploy log directory', () => {
		// Deploy logs can carry secrets. The file browser is open by design, so the
		// directory has to be named here or the API's permission check is bypassable.
		expect(isProtectedPath('/app/data/deploy-logs')).toBe(true);
		expect(isProtectedPath('/app/data/deploy-logs/abc.log')).toBe(true);
	});

	test('still protects what it protected before', () => {
		expect(isProtectedPath('/app/data/db')).toBe(true);
		expect(isProtectedPath('/proc/1/environ')).toBe(true);
	});

	test('leaves the rest of the container browsable', () => {
		expect(isProtectedPath('/app/data/stacks')).toBe(false);
	});
});

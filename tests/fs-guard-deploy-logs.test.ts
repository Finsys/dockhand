import { describe, expect, test } from 'bun:test';

// protectedPaths() derives every path from resolve(process.env.DATA_DIR || './data') at
// call time, so DATA_DIR has to be set BEFORE the module is loaded -- hence the dynamic
// import. tests/fs-guard.test.ts does the same thing for the same reason. With a static
// import the '/app/data/db' assertion below is red no matter how correct the change is.
process.env.DATA_DIR = '/app/data';
const { isProtectedPath } = await import('../src/lib/server/fs-guard');

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

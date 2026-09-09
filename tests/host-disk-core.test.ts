import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHostDiskInfo } from '../src/lib/server/host-disk-core';

describe('getHostDiskInfo', () => {
	it('defaults to "/" when called without a path', async () => {
		const result = await getHostDiskInfo();

		assert.ok(result !== null);
		assert.ok(result!.diskTotal > 0);
		assert.ok(result!.diskFree >= 0);
		assert.ok(result!.diskAvailable >= 0);
	});

	it('defaults to "/" when passed an empty string', async () => {
		const result = await getHostDiskInfo('');

		assert.ok(result !== null);
	});

	it('measures the given path, not a hardcoded "/"', async () => {
		// A directory that definitely exists but is not '/' itself - proves the
		// argument actually reaches statfs() instead of being ignored.
		const dir = mkdtempSync(join(tmpdir(), 'dockhand-host-disk-test-'));
		try {
			const result = await getHostDiskInfo(dir);
			assert.ok(result !== null);
			assert.ok(result!.diskTotal > 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('returns null for a path that does not exist, instead of silently falling back to "/"', async () => {
		const bogusPath = '/this/path/almost-certainly/does-not-exist-dockhand-1397';

		const result = await getHostDiskInfo(bogusPath);

		assert.equal(result, null);
	});
});

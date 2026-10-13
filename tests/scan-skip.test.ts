import { describe, test, expect } from 'bun:test';
import { shouldSkipScanDir, SKIP_DIRECTORIES } from '../src/lib/utils/scan-skip';

describe('shouldSkipScanDir', () => {
	test('skips hidden (dot-prefixed) directories, e.g. btrfs .snapshots (#1251)', () => {
		expect(shouldSkipScanDir('.snapshots')).toBe(true);
		expect(shouldSkipScanDir('.git')).toBe(true);
		expect(shouldSkipScanDir('.cache')).toBe(true);
		expect(shouldSkipScanDir('.anything')).toBe(true);
	});

	test('skips the known noise directories', () => {
		for (const d of SKIP_DIRECTORIES) {
			expect(shouldSkipScanDir(d)).toBe(true);
		}
		expect(shouldSkipScanDir('node_modules')).toBe(true);
		expect(shouldSkipScanDir('venv')).toBe(true);
	});

	test('does NOT skip normal stack directories', () => {
		expect(shouldSkipScanDir('my-stack')).toBe(false);
		expect(shouldSkipScanDir('nginx')).toBe(false);
		expect(shouldSkipScanDir('docker')).toBe(false); // only .docker is skipped, not docker
		expect(shouldSkipScanDir('snapshots')).toBe(false); // only .snapshots is hidden
	});

	test('a name with a dot inside (not prefix) is not treated as hidden', () => {
		expect(shouldSkipScanDir('my.stack')).toBe(false);
		expect(shouldSkipScanDir('v1.2.3')).toBe(false);
	});
});

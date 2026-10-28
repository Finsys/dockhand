/**
 * The "Stack files on the host" picker: a bind dir inside the stack folder can be left
 * out here, since with its bind unticked the stack files are the only place it is kept.
 * What the server never excludes stays locked, so the picker never shows a false exclusion.
 */
import { describe, test, expect } from 'bun:test';
import { isStackEntryLocked, isLoadBearingStackEntry, effectiveStackFileExclusions } from '../src/lib/utils/stack-files-picker';
import { isLoadBearingStackFile } from '../src/lib/server/backups/stackfile-filter';

describe('isStackEntryLocked', () => {
	test('a bind dir can be deselected', () => {
		expect(isStackEntryLocked({ name: 'files', capturedAs: 'bind' })).toBe(false);
	});

	test('a plain dir or file can be deselected', () => {
		expect(isStackEntryLocked({ name: 'DATA_OLD' })).toBe(false);
		expect(isStackEntryLocked({ name: 'cleanup.sh' })).toBe(false);
	});

	test('an entry captured as its own volume stays locked', () => {
		expect(isStackEntryLocked({ name: 'files', capturedAs: 'volume' })).toBe(true);
	});

	test('compose, any yaml and env files stay locked, a file bind included', () => {
		for (const name of ['compose.yaml', 'docker-compose.yml', 'Compose.YAML', 'docker-compose.override.yml', 'prometheus.yml', '.env', '.env.prod']) {
			expect(isStackEntryLocked({ name })).toBe(true);
			expect(isStackEntryLocked({ name, capturedAs: 'bind' })).toBe(true);
		}
	});

	test('look-alike names are not load-bearing', () => {
		for (const name of ['compose.yaml.bak', 'my.env', 'env', '.envrc', '.environment', 'yml', 'notes.yamlx']) {
			expect(isStackEntryLocked({ name })).toBe(false);
		}
	});
});

describe('isLoadBearingStackEntry matches the server rule', () => {
	test('on every name, including the ones a narrower rule would get wrong', () => {
		const names = [
			'compose.yaml', 'docker-compose.yml', 'docker-compose.override.yml', 'prometheus.yml', 'app.YAML',
			'.env', '.env.local', '.envrc', '.environment', 'mastodon.env', '.ENV',
			'files', 'compose.yaml.bak', 'notes.yamlx', 'cleanup.sh'
		];
		for (const name of names) {
			expect(`${name}:${isLoadBearingStackEntry(name)}`).toBe(`${name}:${isLoadBearingStackFile(name)}`);
		}
	});
});

describe('effectiveStackFileExclusions', () => {
	test('a saved exclusion of a file the server keeps anyway does not count', () => {
		expect(effectiveStackFileExclusions(['files', 'prometheus.yml', '.env', 'cleanup.sh'])).toEqual(['files', 'cleanup.sh']);
		expect(effectiveStackFileExclusions(['compose.yaml'])).toEqual([]);
	});
});

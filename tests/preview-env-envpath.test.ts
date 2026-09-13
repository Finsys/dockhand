/**
 * #1495 - "Populate environment variables" found no .env because the preview clone
 * computed the base .env path by re-joining the temp dir onto an already-absolute
 * compose path, doubling the prefix:
 *   join(tempDir, dirname(safeComposePath), '.env')
 *     -> /tmp/preview-x/tmp/preview-x/stacks/repro/.env   (cannot exist -> 0 vars)
 *
 * This calls the REAL production helper repoBaseEnvPath (the exact code previewRepoEnvFiles
 * uses), so a revert to the buggy join fails these tests - unlike a re-implemented formula,
 * which would stay green.
 */
import { describe, expect, test } from 'bun:test';
import { sep } from 'node:path';
import { repoBaseEnvPath } from '../src/lib/server/git-url-safety';

describe('#1495 preview base .env path is not doubled', () => {
	const tempDir = '/app/data/git-repos/preview-1788100341098-d7vddc';

	test('relative compose path -> .env beside it, single temp prefix', () => {
		const p = repoBaseEnvPath(tempDir, 'stacks/repro/docker-compose.yml');
		expect(p).toBe(`${tempDir}/stacks/repro/.env`);
		// the temp dir must appear exactly once (the regression put it in twice)
		expect(p.split(tempDir).length - 1).toBe(1);
		expect(p.startsWith(tempDir + sep)).toBe(true);
	});

	test('leading-slash compose path is treated repo-root-relative, still single prefix', () => {
		const p = repoBaseEnvPath(tempDir, '/stacks/repro/docker-compose.yml');
		expect(p).toBe(`${tempDir}/stacks/repro/.env`);
		expect(p.split(tempDir).length - 1).toBe(1);
	});

	test('./ compose path resolves the same', () => {
		const p = repoBaseEnvPath(tempDir, './stacks/repro/compose.yaml');
		expect(p).toBe(`${tempDir}/stacks/repro/.env`);
		expect(p.split(tempDir).length - 1).toBe(1);
	});

	test('compose at repo root -> .env at repo root', () => {
		const p = repoBaseEnvPath(tempDir, 'docker-compose.yml');
		expect(p).toBe(`${tempDir}/.env`);
	});

	test('a traversing compose path is still rejected (containment guard preserved)', () => {
		expect(() => repoBaseEnvPath(tempDir, '../../etc/docker-compose.yml')).toThrow();
	});
});

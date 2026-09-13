import { describe, test, expect, afterEach } from 'bun:test';
import { rewriteComposeVolumePaths, __setCachedMountsForTest } from '../src/lib/server/host-path';

afterEach(() => __setCachedMountsForTest(null));

const compose = (bind: string) => `services:\n  app:\n    image: x\n    volumes:\n      - ${bind}\n`;

describe('rewriteComposeVolumePaths', () => {
	test('1:1 mount (host path == container path) leaves the relative bind untouched (#1514)', () => {
		// TerraMaster/1:1 case: the compose dir is mounted at the identical path, so
		// translating ./data_db to the same absolute path is pointless and would force
		// a stdin deploy that loses com.docker.compose.project.config_files.
		__setCachedMountsForTest([
			{ source: '/Volume1/Development/Docker', destination: '/Volume1/Development/Docker' }
		]);
		const r = rewriteComposeVolumePaths(compose('./data_db:/var/lib/postgresql/data'), '/Volume1/Development/Docker/authentik');
		expect(r.modified).toBe(false);
		expect(r.content).toContain('- ./data_db:/var/lib/postgresql/data');
		expect(r.changes.length).toBe(0);
	});

	test('non-1:1 mount (container path differs from host) still translates (no regression)', () => {
		// The Dockhand-in-Docker case: /app/data mounted from /docker/data on the host.
		__setCachedMountsForTest([{ source: '/docker/data', destination: '/app/data' }]);
		const r = rewriteComposeVolumePaths(compose('./sub:/x'), '/app/data/stacks/myapp');
		expect(r.modified).toBe(true);
		expect(r.content).toContain('- /docker/data/stacks/myapp/sub:/x');
	});

	test('untranslatable relative bind (no matching mount) is left unchanged', () => {
		__setCachedMountsForTest([{ source: '/docker/data', destination: '/app/data' }]);
		const r = rewriteComposeVolumePaths(compose('./x:/y'), '/somewhere/else');
		expect(r.modified).toBe(false);
		expect(r.content).toContain('- ./x:/y');
	});

	test('no mounts known: nothing is translated', () => {
		__setCachedMountsForTest([]);
		const r = rewriteComposeVolumePaths(compose('./x:/y'), '/app/data/s');
		expect(r.modified).toBe(false);
	});

	test('named volumes and absolute binds are never touched', () => {
		__setCachedMountsForTest([{ source: '/docker/data', destination: '/app/data' }]);
		const named = 'services:\n  app:\n    volumes:\n      - dbdata:/var/lib\n      - /abs/host:/x\n';
		const r = rewriteComposeVolumePaths(named, '/app/data/s');
		expect(r.modified).toBe(false);
		expect(r.content).toBe(named);
	});
});

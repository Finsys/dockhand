/**
 * #1524: warn when a custom stack compose path is not under any Dockhand container
 * mount, so it would be written to the container's throwaway layer and lost on recreate.
 */

import { describe, test, expect } from 'bun:test';
import { unpersistedComposePathWarning, pathOverriddenBySubMount, translateContainerPathViaMount, __setCachedMountsForTest } from '../src/lib/server/host-path';

const MOUNTS = [
	{ source: 'dockhand_data', destination: '/app/data' },
	{ source: '/opt/stacks', destination: '/opt/stacks' },
];

describe('unpersistedComposePathWarning', () => {
	test('warns for a path outside every mount', () => {
		const w = unpersistedComposePathWarning('/home/docker/minecraft/compose.yaml', MOUNTS);
		expect(w).toContain('/home/docker/minecraft/compose.yaml');
		expect(w).toContain('recreated');
	});

	test('no warning for a path under the data volume (default location)', () => {
		expect(unpersistedComposePathWarning('/app/data/stacks/Production/web/compose.yaml', MOUNTS)).toBeNull();
	});

	test('no warning for a path under a user-added bind mount', () => {
		expect(unpersistedComposePathWarning('/opt/stacks/web/compose.yaml', MOUNTS)).toBeNull();
	});

	test('a path exactly equal to a mount destination is under it', () => {
		expect(unpersistedComposePathWarning('/opt/stacks', MOUNTS)).toBeNull();
	});

	test('a prefix that is not a path boundary does NOT count as under the mount', () => {
		// /app/database is not under /app/data even though the string starts with it.
		expect(unpersistedComposePathWarning('/app/database/compose.yaml', MOUNTS)).not.toBeNull();
	});

	test('bare metal (no mounts) never warns', () => {
		expect(unpersistedComposePathWarning('/home/docker/x/compose.yaml', [])).toBeNull();
	});

	test('a relative path is not guarded (resolved against DATA_DIR elsewhere)', () => {
		expect(unpersistedComposePathWarning('compose.yaml', MOUNTS)).toBeNull();
		expect(unpersistedComposePathWarning('./sub/compose.yaml', MOUNTS)).toBeNull();
	});

	test('null / empty path never warns', () => {
		expect(unpersistedComposePathWarning(null, MOUNTS)).toBeNull();
		expect(unpersistedComposePathWarning('', MOUNTS)).toBeNull();
		expect(unpersistedComposePathWarning(undefined, MOUNTS)).toBeNull();
	});
});

describe('pathOverriddenBySubMount (#1533)', () => {
	// The exact #1533 topology: /app/data on a named volume, /app/data/stacks on a
	// separate bind. A stack under /app/data/stacks lives on the bind, not the volume,
	// so the DATA_DIR translation is wrong and must yield to the mount translation.
	const SUBMOUNT = [
		{ source: '/home/docker/docker/volumes/dockhand_data/_data', destination: '/app/data' },
		{ source: '/home/docker/compose', destination: '/app/data/stacks' },
	];

	test('true when a deeper bind overrides the stack subpath', () => {
		expect(pathOverriddenBySubMount('/app/data/stacks/adguard', '/app/data', SUBMOUNT)).toBe(true);
	});

	test('true when the path equals the sub-mount destination', () => {
		expect(pathOverriddenBySubMount('/app/data/stacks', '/app/data', SUBMOUNT)).toBe(true);
	});

	test('false for a DATA_DIR path NOT covered by the sub-mount', () => {
		// /app/data/db is under DATA_DIR but not under the /app/data/stacks bind.
		expect(pathOverriddenBySubMount('/app/data/db', '/app/data', SUBMOUNT)).toBe(false);
	});

	test('false when the only mount IS DATA_DIR itself (normal single-volume setup)', () => {
		const single = [{ source: 'dockhand_data', destination: '/app/data' }];
		expect(pathOverriddenBySubMount('/app/data/stacks/adguard', '/app/data', single)).toBe(false);
	});

	test('false with no mounts (bare metal)', () => {
		expect(pathOverriddenBySubMount('/app/data/stacks/adguard', '/app/data', [])).toBe(false);
	});

	test('path-boundary safe: /app/database is not under /app/data', () => {
		const m = [{ source: '/x', destination: '/app/database' }];
		expect(pathOverriddenBySubMount('/app/data/stacks/adguard', '/app/data', m)).toBe(false);
	});

	test('trailing slashes on DATA_DIR / destinations are normalized', () => {
		const m = [{ source: '/home/docker/compose', destination: '/app/data/stacks/' }];
		expect(pathOverriddenBySubMount('/app/data/stacks/adguard', '/app/data/', m)).toBe(true);
	});

	// The load-bearing invariant of the #1533 fix: when we NULL dataDirHostPath because a
	// sub-mount overrides, mountHostPath (translateContainerPathViaMount) MUST resolve non-null
	// - otherwise we'd regress a wrong-but-found path into a hard-fail (unknown).
	test('overridden => translateContainerPathViaMount resolves non-null (no hard-fail regression)', () => {
		const mounts = [
			{ source: '/home/docker/docker/volumes/dockhand_data/_data', destination: '/app/data' },
			{ source: '/home/docker/compose', destination: '/app/data/stacks' },
		];
		const path = '/app/data/stacks/adguard';
		try {
			__setCachedMountsForTest(mounts);
			expect(pathOverriddenBySubMount(path, '/app/data', mounts)).toBe(true);
			// the very folder the backup helper will bind-mount:
			expect(translateContainerPathViaMount(path)).toBe('/home/docker/compose/adguard');
		} finally {
			__setCachedMountsForTest(null);
		}
	});
});

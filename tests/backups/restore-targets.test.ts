/**
 * Unit tests for resolveRestoreTargets - the single source of truth for where a restore lands.
 *
 * The load-bearing guarantee: for IN-PLACE, the resolved target MUST equal what the swap actually
 * binds, i.e. resolveBindFromMetadata(meta, key).source. These tests assert that identity directly
 * so the preview can never show a path the restore doesn't write. Clone targets are verbatim from
 * volumeDestinations; stack files come from the passed stackDir.
 */
import { describe, expect, test } from 'bun:test';
import { resolveRestoreTargets } from '../../src/lib/server/backups/restore-targets';
import { resolveBindFromMetadata, type SnapshotMetadata } from '../../src/lib/server/backups/restore-core';

describe('resolveRestoreTargets - in-place (target === what the swap binds)', () => {
	const meta: SnapshotMetadata = {
		volumes: [
			{ key: 'html', name: '/srv/app/html', source: '/srv/app/html', type: 'bind' },
			{ key: 'pgdata', name: 'pgdata', source: 'pgdata', type: 'volume' },
		],
	};

	test('bind volume target equals resolveBindFromMetadata source (identity)', () => {
		const r = resolveRestoreTargets({ job: { mode: 'in-place' }, volumes: ['html'], metadata: meta, stackDir: null });
		expect(r.volumes[0]).toMatchObject({ key: 'html', type: 'bind', target: '/srv/app/html', origin: 'in-place-metadata' });
		// the exact identity the preview relies on - target AND the full bind equal the leaf fn:
		expect(r.volumes[0].target).toBe(resolveBindFromMetadata(meta, 'html').source);
		expect(r.volumes[0].bind).toBe(resolveBindFromMetadata(meta, 'html').bind);
	});

	test('named volume target equals the volume name', () => {
		const r = resolveRestoreTargets({ job: { mode: 'in-place' }, volumes: ['pgdata'], metadata: meta, stackDir: null });
		expect(r.volumes[0]).toMatchObject({ key: 'pgdata', type: 'volume', target: 'pgdata', origin: 'in-place-metadata', bind: 'pgdata:/volumes/pgdata:rw' });
		expect(r.volumes[0].target).toBe(resolveBindFromMetadata(meta, 'pgdata').source);
	});

	test('a bind whose source cannot be recovered goes to unresolved, does NOT throw', () => {
		// legacy string list: 'data_config' slugs from a bind path but no absolute source recorded.
		const bad: SnapshotMetadata = { volumes: ['/data/config'] };
		const r = resolveRestoreTargets({ job: { mode: 'in-place' }, volumes: ['data_config'], metadata: bad, stackDir: null });
		expect(r.volumes).toEqual([]);
		expect(r.unresolved).toHaveLength(1);
		expect(r.unresolved[0].key).toBe('data_config');
	});
});

describe('resolveRestoreTargets - clone (verbatim from volumeDestinations)', () => {
	const meta: SnapshotMetadata = {
		volumes: [{ key: 'html', name: '/orig/html', source: '/orig/html', type: 'bind' }],
	};

	test('a path destination is used verbatim as a bind host path', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', volumeDestinations: [{ volume: 'html', kind: 'path', target: '/new/custom/html' }] },
			volumes: ['html'], metadata: meta, stackDir: null,
		});
		expect(r.volumes[0]).toMatchObject({ key: 'html', type: 'bind', target: '/new/custom/html', origin: 'clone', include: '/volumes/html', bind: '/new/custom/html:/volumes/html:rw' });
	});

	test('a volume destination is a named volume target', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', volumeDestinations: [{ volume: 'html', kind: 'volume', target: 'html_clone' }] },
			volumes: ['html'], metadata: meta, stackDir: null,
		});
		expect(r.volumes[0]).toMatchObject({ key: 'html', type: 'volume', target: 'html_clone', origin: 'clone', bind: 'html_clone:/volumes/html:rw' });
	});

	test('an unmapped volume falls back to loose-files under targetPath', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetPath: '/restore/here', volumeDestinations: [] },
			volumes: ['html'], metadata: meta, stackDir: null,
		});
		expect(r.volumes[0]).toMatchObject({ key: 'html', type: 'bind', target: '/restore/here', origin: 'loose-files', bind: '/restore/here:/restore/here' });
	});

	test('an unmapped volume with no targetPath is unresolved (fail-closed, no throw)', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', volumeDestinations: [] },
			volumes: ['html'], metadata: meta, stackDir: null,
		});
		expect(r.volumes).toEqual([]);
		expect(r.unresolved[0].key).toBe('html');
	});
});

describe('resolveRestoreTargets - stack files', () => {
	test('writes the managed stack dir for a stack restore', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetType: 'stack', targetName: 'blog' },
			volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.stackFiles).toEqual({ targetDir: '/app/data/stacks/anton/blog', willWrite: true, overwrite: true });
	});

	test('skipStackFiles -> willWrite false (data-only restore)', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetType: 'stack', targetName: 'blog', skipStackFiles: true },
			volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.stackFiles?.willWrite).toBe(false);
	});

	// willWrite answers "does the restore REPLACE this directory". A redeploy materialises the
	// managed stack dir itself (redeployStack -> materialiseStackFiles with overwrite), so opting
	// out of stack files does not spare it - and the overwrite gate reads willWrite to decide
	// whether to ask. Reporting false here lets a redeploy delete the user's compose unasked.
	test('skipStackFiles with a redeploy still writes the stack dir', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetType: 'stack', targetName: 'blog', skipStackFiles: true, postRestore: 'redeploy' },
			volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.stackFiles?.willWrite).toBe(true);
	});

	// The near misses: only a redeploy materialises the dir on its own, so no other post-restore
	// action may override the opt-out.
	test('skipStackFiles with any other post-restore action stays false', () => {
		for (const postRestore of ['none', 'recreate', 'start', undefined, null]) {
			const r = resolveRestoreTargets({
				job: { mode: 'new-location', targetType: 'stack', targetName: 'blog', skipStackFiles: true, postRestore },
				volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
			});
			expect(r.stackFiles?.willWrite).toBe(false);
		}
	});

	test('a redeploy without skipStackFiles is unchanged', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetType: 'stack', targetName: 'blog', postRestore: 'redeploy' },
			volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.stackFiles?.willWrite).toBe(true);
	});

	// A missing target name means there is no stack dir to write, whatever runs afterwards.
	test('no target name is never a write', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetType: 'stack', postRestore: 'redeploy' },
			volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.stackFiles?.willWrite).toBe(false);
	});

	test('mergeStackFiles -> overwrite false', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'new-location', targetType: 'stack', targetName: 'blog', mergeStackFiles: true },
			volumes: [], metadata: null, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.stackFiles?.overwrite).toBe(false);
	});

	test('a container restore has no stackFiles', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'in-place', targetType: 'container', targetName: 'nginx' },
			volumes: [], metadata: null, stackDir: null,
		});
		expect(r.stackFiles).toBeNull();
	});
});

describe('resolveRestoreTargets - the stack-dir synthetic volume is not a user volume', () => {
	test('the reserved __dockhand_stackdir__ key is ignored in volumes (handled via stackFiles)', () => {
		const r = resolveRestoreTargets({
			job: { mode: 'in-place', targetType: 'stack', targetName: 'blog' },
			volumes: ['__dockhand_stackdir__'], metadata: { volumes: [] }, stackDir: '/app/data/stacks/anton/blog',
		});
		expect(r.volumes).toEqual([]);
		expect(r.unresolved).toEqual([]);
	});
});

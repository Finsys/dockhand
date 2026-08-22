/**
 * Unit tests for backups/validate.ts — pure fail-fast validation. Every
 * rejection path is covered, and the all-errors-at-once behaviour is asserted.
 */
import { describe, it, expect } from 'bun:test';
import {
	validateBackupConfig,
	validateRestoreRequest,
	retentionWouldPrune,
	assertBackupableWith,
} from '../../src/lib/server/backups/validate';

const okConfig = {
	type: 'container',
	targetName: 'web',
	destinationId: 1,
};

describe('validateBackupConfig', () => {
	it('accepts a minimal valid config', () => {
		expect(validateBackupConfig(okConfig)).toEqual({ ok: true });
	});
	it('rejects a bad type', () => {
		const r = validateBackupConfig({ ...okConfig, type: 'vm' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.map((i) => i.field)).toContain('type');
	});
	it('rejects a missing/blank target', () => {
		expect(validateBackupConfig({ ...okConfig, targetName: '' }).ok).toBe(false);
		expect(validateBackupConfig({ ...okConfig, targetName: '   ' }).ok).toBe(false);
	});
	it('rejects a missing/invalid destination', () => {
		expect(validateBackupConfig({ ...okConfig, destinationId: null }).ok).toBe(false);
		expect(validateBackupConfig({ ...okConfig, destinationId: 0 }).ok).toBe(false);
		expect(validateBackupConfig({ ...okConfig, destinationId: -1 }).ok).toBe(false);
	});
	it('accepts a valid cron and rejects an invalid one', () => {
		expect(validateBackupConfig({ ...okConfig, schedule: '0 2 * * *' }).ok).toBe(true);
		const r = validateBackupConfig({ ...okConfig, schedule: 'not a cron' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.map((i) => i.field)).toContain('schedule');
	});
	it('ignores an empty schedule (manual-only config)', () => {
		expect(validateBackupConfig({ ...okConfig, schedule: '' }).ok).toBe(true);
		expect(validateBackupConfig({ ...okConfig, schedule: null }).ok).toBe(true);
	});
	it('rejects invalid retention JSON but accepts a valid blob', () => {
		expect(validateBackupConfig({ ...okConfig, retention: '{bad' }).ok).toBe(false);
		expect(validateBackupConfig({ ...okConfig, retention: '{"keepLast":5}' }).ok).toBe(true);
		expect(validateBackupConfig({ ...okConfig, retention: '' }).ok).toBe(true);
	});
	it('requires a non-empty selection when allVolumes is false', () => {
		expect(validateBackupConfig({ ...okConfig, allVolumes: false, selectedVolumes: [] }).ok).toBe(false);
		expect(validateBackupConfig({ ...okConfig, allVolumes: false, selectedVolumes: null }).ok).toBe(false);
		expect(validateBackupConfig({ ...okConfig, allVolumes: false, selectedVolumes: ['data'] }).ok).toBe(true);
	});
	it('reports ALL problems at once, not just the first', () => {
		const r = validateBackupConfig({ type: 'vm', targetName: '', destinationId: null, schedule: 'bad' });
		expect(r.ok).toBe(false);
		if (!r.ok) {
			const fields = r.issues.map((i) => i.field).sort();
			expect(fields).toEqual(['destinationId', 'schedule', 'targetName', 'type']);
		}
	});
});

const validSnap = 'a'.repeat(64);
const okInPlace = { destinationId: 1, snapshotId: validSnap, mode: 'in-place' as const, confirmOverwrite: true };
const okNewLoc = { destinationId: 1, snapshotId: validSnap, mode: 'new-location' as const, targetPath: '/restore/here' };

describe('validateRestoreRequest', () => {
	it('accepts a confirmed in-place restore', () => {
		expect(validateRestoreRequest(okInPlace)).toEqual({ ok: true });
	});
	it('accepts a new-location restore with a target path', () => {
		expect(validateRestoreRequest(okNewLoc)).toEqual({ ok: true });
	});
	it('rejects a missing/invalid destination or snapshot', () => {
		expect(validateRestoreRequest({ ...okInPlace, destinationId: 0 }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okInPlace, snapshotId: 'nothex!' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okInPlace, snapshotId: '' }).ok).toBe(false);
	});
	it('rejects a bad mode', () => {
		expect(validateRestoreRequest({ ...okInPlace, mode: 'wipe' as any }).ok).toBe(false);
	});
	it('REQUIRES explicit confirmation for a destructive in-place restore', () => {
		const r = validateRestoreRequest({ ...okInPlace, confirmOverwrite: false });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.map((i) => i.field)).toContain('confirmOverwrite');
		// omitted entirely is also rejected
		expect(validateRestoreRequest({ destinationId: 1, snapshotId: validSnap, mode: 'in-place' }).ok).toBe(false);
	});
	it('requires a target path for a new-location restore', () => {
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: '' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: null }).ok).toBe(false);
	});
	it('rejects an unsafe stack name (traversal)', () => {
		expect(validateRestoreRequest({ ...okInPlace, stackName: '../etc' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okInPlace, stackName: 'a/b' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okInPlace, stackName: 'my-stack' }).ok).toBe(true);
	});
	it('rejects a new-location targetPath pointing at a protected system dir', () => {
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: '/etc' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: '/' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: '/root/.ssh' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: '/srv/../etc' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: 'relative' }).ok).toBe(false);
		expect(validateRestoreRequest({ ...okNewLoc, targetPath: '/mnt/restore' }).ok).toBe(true);
	});
	it('reports all problems at once', () => {
		const r = validateRestoreRequest({ destinationId: null, snapshotId: 'bad', mode: 'in-place' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.length).toBeGreaterThanOrEqual(3); // dest + snap + confirm
	});

	// --- clone (new-location with per-volume destinations) --------------------
	const cloneOk = {
		destinationId: 1, snapshotId: validSnap, mode: 'new-location' as const,
		volumes: ['data'], targetName: 'web', postRestore: 'recreate' as const,
		volumeDestinations: [{ volume: 'data', kind: 'volume' as const, target: 'data' }],
	};
	it('accepts a fully-mapped clone WITHOUT a target path', () => {
		// A clone whose volumes all map to destinations extracts nothing loose.
		expect(validateRestoreRequest(cloneOk)).toEqual({ ok: true });
	});
	it('requires a target path when a clone has un-mapped (loose) volumes', () => {
		const r = validateRestoreRequest({ ...cloneOk, volumes: ['data', 'logs'] }); // 'logs' un-mapped
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.some((i) => i.field === 'targetPath')).toBe(true);
	});
	it('requires a target name to recreate/redeploy after a clone', () => {
		const r = validateRestoreRequest({ ...cloneOk, targetName: '' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.some((i) => i.field === 'targetName')).toBe(true);
	});
	it('rejects a non-absolute path destination', () => {
		const r = validateRestoreRequest({ ...cloneOk, volumeDestinations: [{ volume: 'data', kind: 'path', target: 'relative/dir' }] });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.some((i) => i.field === 'volumeDestinations')).toBe(true);
	});
	it('rejects a path destination containing ".."', () => {
		const r = validateRestoreRequest({ ...cloneOk, volumeDestinations: [{ volume: 'data', kind: 'path', target: '/srv/../etc' }] });
		expect(r.ok).toBe(false);
	});
	it('rejects a CLEAN absolute path destination inside a protected system dir (arbitrary host write)', () => {
		// /etc is absolute with no "..", so the old check passed it - the helper would then mount
		// /etc:rw and cp the snapshot over it (root RCE). The protected-root guard must reject it.
		for (const target of ['/etc', '/etc/cron.d', '/var/run', '/root/.ssh']) {
			const r = validateRestoreRequest({ ...cloneOk, volumeDestinations: [{ volume: 'data', kind: 'path', target }] });
			expect(r.ok, `${target} must be rejected`).toBe(false);
			if (!r.ok) expect(r.issues.some((i) => i.field === 'volumeDestinations')).toBe(true);
		}
	});
	it('rejects an invalid volume-name destination', () => {
		const r = validateRestoreRequest({ ...cloneOk, volumeDestinations: [{ volume: 'data', kind: 'volume', target: 'bad name!' }] });
		expect(r.ok).toBe(false);
	});
	it('rejects a destination for a volume not among the restored set', () => {
		const r = validateRestoreRequest({ ...cloneOk, volumeDestinations: [{ volume: 'nope', kind: 'volume', target: 'nope' }] });
		expect(r.ok).toBe(false);
	});
});

describe('retentionWouldPrune', () => {
	it('is false for none/empty, true when configured', () => {
		expect(retentionWouldPrune(null)).toBe(false);
		expect(retentionWouldPrune('')).toBe(false);
		expect(retentionWouldPrune({ keepLast: 5 })).toBe(true);
	});
});

describe('assertBackupableWith', () => {
	it('a container is always backupable (no compose lookup)', async () => {
		let looked = false;
		const r = await assertBackupableWith(async () => { looked = true; return {}; }, 'container', 'web');
		expect(r).toEqual({ ok: true });
		expect(looked).toBe(false);
	});
	it('a stack with a known compose file is backupable', async () => {
		const r = await assertBackupableWith(async () => ({ needsFileLocation: false }), 'stack', 'app');
		expect(r).toEqual({ ok: true });
	});
	it('an external stack (unknown compose file) is refused with a reason', async () => {
		const r = await assertBackupableWith(async () => ({ needsFileLocation: true }), 'stack', 'app');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/external/);
	});
	it('passes the target name and env id through to the lookup', async () => {
		let seen: [string, number | undefined] = ['', undefined];
		await assertBackupableWith(async (name, env) => { seen = [name, env]; return {}; }, 'stack', 'app', 5);
		expect(seen).toEqual(['app', 5]);
	});
});

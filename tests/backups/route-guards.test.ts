/**
 * Unit tests for backups/route-guards.ts — the RBAC + per-environment access
 * layer for backup routes (closes the cross-env snapshot/config bypass, task
 * #14). Security-critical + fail-closed, so every deny branch is pinned here.
 *
 * The module transitively imports the DB/engine via ./index, so we mock.module()
 * ./index and ../../db BEFORE importing it — the guard LOGIC under test is pure
 * (decisions over an injected AuthorizationContext + the two resolver results).
 */
import { describe, it, expect, mock, beforeAll } from 'bun:test';

// Controllable fakes for the heavy imports, set per-test.
let resolveResult: { envId: number | null | undefined; resolved: boolean } | (() => never) = { envId: 5, resolved: true };
let configById: (id: number) => any = () => null;

mock.module('../../src/lib/server/backups/index', () => ({
	resolveSnapshotEnvId: async () => {
		if (typeof resolveResult === 'function') resolveResult();
		return resolveResult;
	},
	filterSnapshotsByAccessibleEnv: async (snaps: any[], can: (id: number) => Promise<boolean>) => {
		const out: any[] = [];
		for (const s of snaps) {
			const envTag = (s.tags ?? []).find((t: string) => t.startsWith('dockhand:envid='));
			const v = envTag ? envTag.slice('dockhand:envid='.length) : null;
			if (v === 'local' || v == null) { out.push(s); continue; } // unscoped kept
			const n = Number(v);
			if (Number.isInteger(n) && (await can(n))) out.push(s); // else dropped (fail closed)
		}
		return out;
	},
}));
mock.module('../../src/lib/server/db', () => ({
	getBackupConfig: async (id: number) => configById(id),
}));

let rg: typeof import('../../src/lib/server/backups/route-guards');
beforeAll(async () => { rg = await import('../../src/lib/server/backups/route-guards'); });

/** Build an AuthorizationContext with just the fields the guards read. */
function auth(over: Partial<{ authEnabled: boolean; isEnterprise: boolean; can: boolean; accessibleEnvs: number[] | 'all' }> = {}): any {
	const accessible = over.accessibleEnvs ?? 'all';
	return {
		authEnabled: over.authEnabled ?? true,
		isEnterprise: over.isEnterprise ?? true,
		can: async () => over.can ?? true,
		canAccessEnvironment: async (id: number) => accessible === 'all' || accessible.includes(id),
	};
}
const status = (r: Response | null) => (r ? r.status : null);

describe('requireBackups — global RBAC gate', () => {
	it('allows when auth is disabled (no gate)', async () => {
		expect(await rg.requireBackups(auth({ authEnabled: false, can: false }), 'manage')).toBeNull();
	});
	it('allows when the permission is granted', async () => {
		expect(await rg.requireBackups(auth({ can: true }), 'view')).toBeNull();
	});
	it('DENIES with 403 when the permission is missing', async () => {
		expect(status(await rg.requireBackups(auth({ can: false }), 'manage'))).toBe(403);
	});
});

describe('loadConfigGateEnv — config load + per-env gate in one', () => {
	it('400 on a non-numeric id', async () => {
		const r = await rg.loadConfigGateEnv('abc', auth());
		expect('response' in r && r.response.status).toBe(400);
	});
	it('404 when the config does not exist', async () => {
		configById = () => null;
		const r = await rg.loadConfigGateEnv('7', auth());
		expect('response' in r && r.response.status).toBe(404);
	});
	it('403 when enterprise caller lacks access to the config env', async () => {
		configById = (id) => ({ id, environmentId: 9 });
		const r = await rg.loadConfigGateEnv('7', auth({ isEnterprise: true, accessibleEnvs: [1, 2] }));
		expect('response' in r && r.response.status).toBe(403);
	});
	it('returns the config when access is allowed', async () => {
		configById = (id) => ({ id, environmentId: 2 });
		const r = await rg.loadConfigGateEnv('7', auth({ accessibleEnvs: [2] }));
		expect('config' in r && r.config.id).toBe(7);
	});
	it('does NOT env-gate a non-enterprise caller (free edition)', async () => {
		configById = (id) => ({ id, environmentId: 9 });
		const r = await rg.loadConfigGateEnv('7', auth({ isEnterprise: false, accessibleEnvs: [] }));
		expect('config' in r).toBe(true);
	});
	it('does NOT env-gate a config with no environmentId', async () => {
		configById = (id) => ({ id, environmentId: null });
		const r = await rg.loadConfigGateEnv('7', auth({ accessibleEnvs: [] }));
		expect('config' in r).toBe(true);
	});
});

describe('guardSnapshotEnvAccess — per-env snapshot content gate (fail closed)', () => {
	it('no-op (null) for a non-enterprise caller', async () => {
		expect(await rg.guardSnapshotEnvAccess(auth({ isEnterprise: false }), 1, 'snap')).toBeNull();
	});
	it('DENIES (403) when the snapshot env cannot be resolved (fail closed)', async () => {
		resolveResult = { envId: undefined, resolved: false };
		expect(status(await rg.guardSnapshotEnvAccess(auth(), 1, 'snap'))).toBe(403);
	});
	it('DENIES (403) when resolving the env THROWS (fail closed)', async () => {
		resolveResult = () => { throw new Error('restic down'); };
		expect(status(await rg.guardSnapshotEnvAccess(auth(), 1, 'snap'))).toBe(403);
	});
	it('allows an unscoped (local, envId=null) snapshot', async () => {
		resolveResult = { envId: null, resolved: true };
		expect(await rg.guardSnapshotEnvAccess(auth({ accessibleEnvs: [] }), 1, 'snap')).toBeNull();
	});
	it('DENIES (403) when the caller cannot access the resolved env', async () => {
		resolveResult = { envId: 9, resolved: true };
		expect(status(await rg.guardSnapshotEnvAccess(auth({ accessibleEnvs: [1] }), 1, 'snap'))).toBe(403);
	});
	it('allows when the caller CAN access the resolved env', async () => {
		resolveResult = { envId: 3, resolved: true };
		expect(await rg.guardSnapshotEnvAccess(auth({ accessibleEnvs: [3] }), 1, 'snap')).toBeNull();
	});
});

describe('filterSnapshotsByEnvAccess — drop inaccessible-env snapshots (list branch)', () => {
	const mk = (envid: string) => ({ id: envid, tags: [`dockhand:envid=${envid}`] });
	it('returns all snapshots unchanged for a non-enterprise caller', async () => {
		const snaps = [mk('9'), mk('local')];
		expect(await rg.filterSnapshotsByEnvAccess(auth({ isEnterprise: false }), snaps)).toHaveLength(2);
	});
	it('keeps accessible + local, DROPS inaccessible (fail closed)', async () => {
		const snaps = [mk('3'), mk('9'), mk('local')];
		const out = await rg.filterSnapshotsByEnvAccess(auth({ accessibleEnvs: [3] }), snaps);
		const ids = out.map((s: any) => s.id).sort();
		expect(ids).toEqual(['3', 'local']); // env 9 dropped
	});
	it('is a no-op on an empty list', async () => {
		expect(await rg.filterSnapshotsByEnvAccess(auth(), [])).toEqual([]);
	});
});

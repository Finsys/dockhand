/**
 * Unit tests for backups/repo.ts — repository lifecycle ops + failure
 * classification, driven by an injected restic runner.
 */
import { describe, it, expect } from 'bun:test';
import {
	classifyRepoFailure,
	initRepository,
	testRepository,
	checkRepository,
	pruneRepository,
	unlockRepository,
	rotateDestinationPassword,
	type ResticLocal,
	type RotatePorts,
} from '../../src/lib/server/backups/repo';
import type { ResticRun } from '../../src/lib/server/backups/models';

/** A runner that captures its args and returns a fixed run. */
function runner(run: ResticRun): ResticLocal & { lastArgs: string[]; lastTier?: string } {
	const box: any = {
		lastArgs: [],
		async runLocal(_dest: any, args: string[], tier?: string) {
			box.lastArgs = args;
			box.lastTier = tier;
			return run;
		},
	};
	return box;
}

const ok = (stdout = 'ok'): ResticRun => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode: number | undefined, stderr: string): ResticRun => ({ exitCode, stdout: '', stderr });

describe('classifyRepoFailure', () => {
	it('exit 10 → REPO_NOT_INITIALIZED', () => {
		expect(classifyRepoFailure(fail(10, 'x')).code).toBe('REPO_NOT_INITIALIZED');
	});
	it('"is not a restic repository" → REPO_NOT_INITIALIZED', () => {
		expect(classifyRepoFailure(fail(1, 'Fatal: is not a restic repository')).code).toBe('REPO_NOT_INITIALIZED');
	});
	it('wrong password → WRONG_PASSWORD', () => {
		expect(classifyRepoFailure(fail(1, 'wrong password or no key found')).code).toBe('WRONG_PASSWORD');
	});
	it('locked → REPO_LOCKED', () => {
		expect(classifyRepoFailure(fail(1, 'repository is already locked exclusively')).code).toBe('REPO_LOCKED');
	});
	it('undefined exit → RESTIC unknown outcome', () => {
		expect(classifyRepoFailure(fail(undefined, '')).code).toBe('RESTIC');
		expect(classifyRepoFailure(fail(undefined, '')).error).toMatch(/unknown outcome/);
	});
	it('other failure → RESTIC with the stderr', () => {
		const c = classifyRepoFailure(fail(1, 'some other error'));
		expect(c.code).toBe('RESTIC');
		expect(c.error).toBe('some other error');
	});
});

describe('initRepository', () => {
	it('ok on a fresh init', async () => {
		expect(await initRepository(runner(ok('created restic repository')), {})).toEqual({ ok: true, output: 'repository initialised' });
	});
	it('treats "already initialized" as success', async () => {
		const r = await initRepository(runner(fail(1, 'Fatal: config file already exists / already initialized')), {});
		expect(r.ok).toBe(true);
	});
	it('classifies a real failure', async () => {
		const r = await initRepository(runner(fail(1, 'permission denied')), {});
		expect(r.ok).toBe(false);
	});
});

describe('testRepository', () => {
	it('reads the repo config (cat config)', async () => {
		const run = runner(ok());
		await testRepository(run, {});
		expect(run.lastArgs).toEqual(['cat', 'config', '--no-lock']);
	});
	it('reports not-initialised clearly', async () => {
		const r = await testRepository(runner(fail(10, '')), {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('REPO_NOT_INITIALIZED');
	});
});

describe('checkRepository', () => {
	it('structure-only check omits --read-data-subset', async () => {
		const run = runner(ok());
		await checkRepository(run, {});
		expect(run.lastArgs).toEqual(['check', '--no-lock']);
	});
	it('data check adds the subset and uses the long timeout tier', async () => {
		const run = runner(ok());
		await checkRepository(run, {}, '5%');
		expect(run.lastArgs).toContain('--read-data-subset');
		expect(run.lastArgs).toContain('5%');
		expect(run.lastTier).toBe('data');
	});
});

describe('pruneRepository / unlockRepository', () => {
	it('prune uses retry-lock and the long tier, optional max-unused', async () => {
		const run = runner(ok());
		await pruneRepository(run, {}, '10%');
		expect(run.lastArgs).toContain('--retry-lock');
		expect(run.lastArgs).toContain('--max-unused');
		expect(run.lastArgs).toContain('10%');
		expect(run.lastTier).toBe('data');
	});
	it('unlock defaults to --remove-all (the explicit user Unlock action)', async () => {
		// --remove-all clears locks left by a crashed/killed helper whose container-
		// hostname restic won't age out as stale for 30min. Only the explicit button.
		const run = runner(ok());
		await unlockRepository(run, {});
		expect(run.lastArgs).toEqual(['unlock', '--remove-all']);
	});
	it('unlock with removeAll=false is a plain unlock (automatic/scheduled path)', async () => {
		// The scheduled auto-unlock MUST NOT --remove-all: on a shared repo it would wipe
		// a live foreign lock of another instance's in-flight backup. Plain unlock reaps
		// only provably-stale locks and leaves a live one alone.
		const run = runner(ok());
		await unlockRepository(run, {}, false);
		expect(run.lastArgs).toEqual(['unlock']);
		expect(run.lastArgs).not.toContain('--remove-all');
	});
});

describe('rotateDestinationPassword', () => {
	const CURRENT = 'current-password';

	/** Build injectable ports over a fake restic + destination store. */
	function ports(opts: {
		restic: ResticLocal;
		current?: string;
		updateThrows?: boolean;
	}): RotatePorts & { updated: string | null; serializedCount: number } {
		const box: any = {
			updated: null,
			serializedCount: 0,
			restic: opts.restic,
			async getDecryptedDestination(id: number) {
				return { id, decryptedPassword: opts.current ?? CURRENT };
			},
			async updatePassword(_id: number, password: string) {
				if (opts.updateThrows) throw new Error('db write failed');
				box.updated = password;
			},
			async serializeDestination(_id: number, fn: () => Promise<any>) {
				box.serializedCount++;
				return fn();
			},
		};
		return box;
	}

	it('rejects a new password shorter than 8 characters (no restic call)', async () => {
		const run = runner(ok());
		const r = await rotateDestinationPassword(ports({ restic: run }), 1, CURRENT, 'short');
		expect(r.ok).toBe(false);
		expect(run.lastArgs).toEqual([]); // restic never ran
	});

	it('rejects a new password equal to the current', async () => {
		const run = runner(ok());
		const r = await rotateDestinationPassword(ports({ restic: run }), 1, CURRENT, CURRENT);
		expect(r).toEqual({ ok: false, error: 'New password must differ from current password' });
		expect(run.lastArgs).toEqual([]);
	});

	it('rejects a wrong current password (constant-time compare) without touching restic', async () => {
		const run = runner(ok());
		const r = await rotateDestinationPassword(ports({ restic: run }), 1, 'wrong-current', 'a-new-password');
		expect(r).toEqual({ ok: false, error: 'Current password does not match' });
		expect(run.lastArgs).toEqual([]);
	});

	it('reports destination-not-found', async () => {
		const p = ports({ restic: runner(ok()) });
		p.getDecryptedDestination = async () => null;
		const r = await rotateDestinationPassword(p, 1, CURRENT, 'a-new-password');
		expect(r).toEqual({ ok: false, error: 'Destination not found' });
	});

	it('happy path: runs restic key passwd (serialized) then persists', async () => {
		const run = runner(ok());
		const p = ports({ restic: run });
		const r = await rotateDestinationPassword(p, 1, CURRENT, 'a-new-password');
		expect(r).toEqual({ ok: true });
		expect(run.lastArgs.slice(0, 2)).toEqual(['key', 'passwd']);
		expect(run.lastArgs).toContain('--new-password-file');
		expect(p.updated).toBe('a-new-password');
		expect(p.serializedCount).toBe(1);
	});

	it('surfaces a restic failure and does NOT persist', async () => {
		const run = runner(fail(1, 'wrong password or no key found'));
		const p = ports({ restic: run });
		const r = await rotateDestinationPassword(p, 1, CURRENT, 'a-new-password');
		expect(r.ok).toBe(false);
		expect(p.updated).toBeNull();
	});

	it('flags dbOutOfSync when restic succeeds but the DB update throws', async () => {
		const run = runner(ok());
		const p = ports({ restic: run, updateThrows: true });
		const r = await rotateDestinationPassword(p, 1, CURRENT, 'a-new-password');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.dbOutOfSync).toBe(true);
	});
});

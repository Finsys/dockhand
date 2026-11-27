/**
 * Environment rename: dirs and stored stack paths are undone exactly when a later step fails.
 */

import { describe, test, expect } from 'bun:test';
import { renameEnvStorage, type EnvRenameDeps } from '../src/lib/server/env-rename-core';

const STACKS = { from: '/data/stacks/home', to: '/data/stacks/house' };
const REPOS = { from: '/data/git-repos/home', to: '/data/git-repos/house' };

interface Row { id: number; path: string }

function setup(opts: { dirs: string[]; rows: Row[]; failRename?: string; failRebaseAfter?: number; failRevertRows?: boolean; update?: () => Promise<any> }) {
	const dirs = new Set(opts.dirs);
	const rows = opts.rows.map((r) => ({ ...r }));
	const log: string[] = [];
	const deps: EnvRenameDeps<any> = {
		fs: {
			exists: (p) => dirs.has(p),
			// Behaves like renameSync: a missing source or an existing target throws.
			rename: (from, to) => {
				log.push(`try ${from} ${to}`);
				if (from === opts.failRename) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
				if (!dirs.has(from)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				if (dirs.has(to)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
				dirs.delete(from);
				dirs.add(to);
				log.push(`mv ${from} ${to}`);
			}
		},
		dirs: [STACKS, REPOS],
		stacks: STACKS,
		rebaseRows: async (from, to, changed, onlyIds) => {
			if (onlyIds && opts.failRevertRows) throw new Error('db still locked');
			for (const r of rows) {
				if (onlyIds && !onlyIds.includes(r.id)) continue;
				if (!r.path.startsWith(from + '/')) continue;
				if (opts.failRebaseAfter !== undefined && !onlyIds && changed.length === opts.failRebaseAfter) throw new Error('db busy');
				r.path = to + r.path.slice(from.length);
				changed.push(r.id);
				log.push(`row ${r.id} -> ${to}`);
			}
		},
		update: opts.update ?? (async () => ({ name: 'house' }))
	};
	return { deps, dirs, rows, log };
}

describe('renameEnvStorage', () => {
	test('moves both dirs, repoints rows and writes the env', async () => {
		const s = setup({ dirs: [STACKS.from, REPOS.from], rows: [{ id: 1, path: '/data/stacks/home/web/compose.yaml' }] });
		const r = await renameEnvStorage(s.deps);
		expect(r).toEqual({ value: { name: 'house' }, repointed: 1 });
		expect([...s.dirs].sort()).toEqual([REPOS.to, STACKS.to].sort());
		expect(s.rows[0].path).toBe('/data/stacks/house/web/compose.yaml');
	});

	test('a failed env write reverts the rows first, then the dirs', async () => {
		const s = setup({
			dirs: [STACKS.from, REPOS.from],
			rows: [{ id: 1, path: '/data/stacks/home/web/compose.yaml' }],
			update: async () => { throw new Error('UNIQUE constraint failed'); }
		});
		await expect(renameEnvStorage(s.deps)).rejects.toThrow('UNIQUE');
		expect([...s.dirs].sort()).toEqual([REPOS.from, STACKS.from].sort());
		expect(s.rows[0].path).toBe('/data/stacks/home/web/compose.yaml');
		const undo = s.log.slice(s.log.indexOf('row 1 -> /data/stacks/house') + 1).filter((l) => !l.startsWith('try '));
		expect(undo).toEqual([
			'row 1 -> /data/stacks/home',
			`mv ${REPOS.to} ${REPOS.from}`,
			`mv ${STACKS.to} ${STACKS.from}`
		]);
	});

	test('an env that vanished (update returns undefined) is undone too', async () => {
		const s = setup({ dirs: [STACKS.from], rows: [{ id: 1, path: '/data/stacks/home/a/compose.yaml' }], update: async () => undefined });
		const r = await renameEnvStorage(s.deps);
		expect(r).toEqual({ value: undefined, repointed: 0 });
		expect([...s.dirs]).toEqual([STACKS.from]);
		expect(s.rows[0].path).toBe('/data/stacks/home/a/compose.yaml');
	});

	test('a rebase that fails part way reverts only the rows it changed', async () => {
		const s = setup({
			dirs: [STACKS.from],
			rows: [
				{ id: 1, path: '/data/stacks/home/a/compose.yaml' },
				{ id: 2, path: '/data/stacks/home/b/compose.yaml' }
			],
			failRebaseAfter: 1
		});
		await expect(renameEnvStorage(s.deps)).rejects.toThrow('db busy');
		expect(s.rows.map((r) => r.path)).toEqual(['/data/stacks/home/a/compose.yaml', '/data/stacks/home/b/compose.yaml']);
		expect([...s.dirs]).toEqual([STACKS.from]);
	});

	test('the undo leaves rows and dirs it never moved alone', async () => {
		// Env "home" has no stacks dir; a leftover dir and a stale row already sit under the new name.
		const s = setup({
			dirs: [REPOS.from, STACKS.to],
			rows: [{ id: 7, path: '/data/stacks/house/old/compose.yaml' }],
			update: async () => { throw new Error('boom'); }
		});
		await expect(renameEnvStorage(s.deps)).rejects.toThrow('boom');
		expect([...s.dirs].sort()).toEqual([REPOS.from, STACKS.to].sort());
		expect(s.rows[0].path).toBe('/data/stacks/house/old/compose.yaml');
	});

	test('the row revert is limited to the rows this rename changed', async () => {
		const s = setup({
			dirs: [STACKS.from],
			rows: [
				{ id: 1, path: '/data/stacks/home/a/compose.yaml' },
				{ id: 7, path: '/data/stacks/house/old/compose.yaml' }
			],
			update: async () => { throw new Error('boom'); }
		});
		await expect(renameEnvStorage(s.deps)).rejects.toThrow('boom');
		expect(s.rows.map((r) => r.path)).toEqual(['/data/stacks/home/a/compose.yaml', '/data/stacks/house/old/compose.yaml']);
	});

	test('a failed dir move reverts the dirs already moved and touches no row', async () => {
		const s = setup({ dirs: [STACKS.from, REPOS.from], rows: [{ id: 1, path: '/data/stacks/home/a/compose.yaml' }], failRename: REPOS.from });
		const r = await renameEnvStorage(s.deps);
		expect('moveError' in r && (r.moveError as any).code).toBe('EXDEV');
		expect([...s.dirs].sort()).toEqual([REPOS.from, STACKS.from].sort());
		expect(s.rows[0].path).toBe('/data/stacks/home/a/compose.yaml');
		// The repos dir never moved, so no move back is even attempted for it.
		expect(s.log.filter((l) => l.startsWith(`try ${REPOS.to}`))).toEqual([]);
	});

	test('a row revert that fails still moves the dirs back and rethrows the original error', async () => {
		const s = setup({
			dirs: [STACKS.from, REPOS.from],
			rows: [{ id: 1, path: '/data/stacks/home/a/compose.yaml' }],
			failRevertRows: true,
			update: async () => { throw new Error('UNIQUE constraint failed'); }
		});
		await expect(renameEnvStorage(s.deps)).rejects.toThrow('UNIQUE');
		expect([...s.dirs].sort()).toEqual([REPOS.from, STACKS.from].sort());
	});

	test('a dir revert that fails does not stop the other dir from moving back', async () => {
		const s = setup({
			dirs: [STACKS.from, REPOS.from],
			rows: [],
			update: async () => {
				// Something takes the old repos name before the revert runs.
				s.dirs.add(REPOS.from);
				throw new Error('boom');
			}
		});
		await expect(renameEnvStorage(s.deps)).rejects.toThrow('boom');
		expect(s.dirs.has(STACKS.from)).toBe(true);
		expect(s.dirs.has(STACKS.to)).toBe(false);
	});
});

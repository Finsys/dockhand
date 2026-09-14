/**
 * Unit tests for the pure per-stack version store (src/lib/server/stack-versions).
 *
 * Style + discipline follow tests/stack-versioning.test.ts / tests/stack-path-utils.test.ts:
 * bun:test, isolated temp dirs via fs.mkdtempSync (cleaned in afterEach), and
 * importing the REAL production module. Importing this module under bun test also
 * proves the no-better-sqlite3 constraint — the module is PURE (node:fs + node:path
 * only), so it loads without the better-sqlite3 seed that a stacks.ts/db.ts import
 * would trigger.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StackVersion } from '../src/lib/server/stack-versions';
import {
	assertSecretFree,
	atomicWriteFile,
	boundVersions,
	collapseDuplicateVersions,
	collapseHistoryFile,
	DEFAULT_MAX_VERSIONS,
	filterSecretVars,
	historyPath,
	listVersions,
	prune,
	readHistoryFile,
	saveVersion
} from '../src/lib/server/stack-versions';
import { parseEnvVars } from '../src/lib/server/env-parser';

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		// Best-effort: a failure test may have left a read-only dir, so force.
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failure
		}
	}
});

/** Create + register an isolated temp dir for a single test. */
function newTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-versions-'));
	tempDirs.push(dir);
	return dir;
}

/** Deterministic, strictly-increasing ISO timestamps for ordering tests. */
function ts(i: number): string {
	return new Date(i * 1000).toISOString();
}

/** True when `s` is a canonical ISO-8601 timestamp (round-trips via toISOString). */
function validIso(s: string): boolean {
	return typeof s === 'string' && Number.isNaN(Date.parse(s)) === false && new Date(s).toISOString() === s;
}

describe('compose round-trip', () => {
	it('save then list shows the content and a valid ISO timestamp', () => {
		const dir = newTempDir();
		const yaml = 'services:\n  app:\n    image: nginx\n';
		const res = saveVersion(dir, 'compose', yaml);

		// Default id = timestamp (no collision yet).
		expect(res.id).toBe(res.timestamp);
		expect(validIso(res.timestamp)).toBe(true);

		const list = listVersions(dir, 'compose');
		expect(list.length).toBe(1);
		expect(list[0].content).toBe(yaml);
		expect(list[0].id).toBe(res.id);
		expect(validIso(list[0].timestamp)).toBe(true);
	});
});

describe('env round-trip', () => {
	it('save a non-secret record then list shows the vars', () => {
		const dir = newTempDir();
		const vars: Record<string, string> = { FOO: 'bar', BAZ: 'qux' };
		const res = saveVersion(dir, 'env', vars);
		expect(validIso(res.timestamp)).toBe(true);

		const list = listVersions(dir, 'env');
		expect(list.length).toBe(1);
		expect(list[0].content).toEqual(vars);
		expect(list[0].id).toBe(res.id);
	});
});

describe('bounded-N', () => {
	it('saveVersion bounds the file to maxVersions (oldest dropped at save)', () => {
		const dir = newTempDir();
		for (let i = 1; i <= 21; i++) {
			saveVersion(dir, 'compose', `v${i}`, { id: `v${i}`, timestamp: ts(i) });
		}
		// Default max (20): the 21st save drops the oldest (v1).
		const all = listVersions(dir, 'compose', 100);
		expect(all.length).toBe(DEFAULT_MAX_VERSIONS);
		expect(all[0].id).toBe('v21'); // newest first
		const ids = new Set(all.map((v) => v.id));
		expect(ids.has('v1')).toBe(false); // oldest dropped
		expect(ids.has('v21')).toBe(true);
	});

	it('listVersions(limit) returns the newest `limit`, dropping the oldest', () => {
		const dir = newTempDir();
		// Save WITHOUT bounding so the file holds all 21.
		for (let i = 1; i <= 21; i++) {
			saveVersion(dir, 'compose', `v${i}`, { id: `v${i}`, timestamp: ts(i), maxVersions: 100 });
		}
		const newest20 = listVersions(dir, 'compose', 20);
		expect(newest20.length).toBe(20);
		expect(newest20[0].id).toBe('v21');
		expect(newest20[19].id).toBe('v2'); // v1 (oldest) dropped
		const ids = new Set(newest20.map((v) => v.id));
		expect(ids.has('v1')).toBe(false);
		expect(ids.has('v2')).toBe(true);
	});
});

describe('prune keeps the safe version', () => {
	it('preserves the safe version even when it is the oldest', () => {
		const dir = newTempDir();
		// Seed 25 versions v1..v25 (v1 oldest) without bounding.
		for (let i = 1; i <= 25; i++) {
			saveVersion(dir, 'compose', `v${i}`, { id: `v${i}`, timestamp: ts(i), maxVersions: 100 });
		}
		// Prune to 10, keeping the OLDEST (v1) as safe.
		const { pruned } = prune(dir, 'compose', 10, 'v1');
		expect(pruned).toBe(15); // 25 -> 10

		const all = listVersions(dir, 'compose', 100);
		expect(all.length).toBe(10);
		// Safe preserved; oldest NON-safe (v2..v16) dropped first; newest kept.
		expect([...all.map((v) => v.id)].sort()).toEqual(['v1', 'v17', 'v18', 'v19', 'v20', 'v21', 'v22', 'v23', 'v24', 'v25']);
	});

	it('drops the oldest non-safe first when the safe version is the newest', () => {
		const dir = newTempDir();
		for (let i = 1; i <= 25; i++) {
			saveVersion(dir, 'compose', `v${i}`, { id: `v${i}`, timestamp: ts(i), maxVersions: 100 });
		}
		// Keep the NEWEST (v25) as safe: v25 plus the next-newest 9 non-safe (v16..v24).
		const { pruned } = prune(dir, 'compose', 10, 'v25');
		expect(pruned).toBe(15);
		const ids = new Set(listVersions(dir, 'compose', 100).map((v) => v.id));
		expect(ids.has('v25')).toBe(true);
		expect(ids.has('v1')).toBe(false); // oldest dropped
		expect(ids.has('v16')).toBe(true); // v16 is the 10th-newest kept
		expect(ids.has('v15')).toBe(false);
	});
});

describe('boundVersions (pure)', () => {
	it('drops the oldest non-safe first, never the safe version', () => {
		const versions: StackVersion[] = [1, 2, 3, 4, 5].map((i) => ({ id: `v${i}`, timestamp: ts(i), content: `c${i}` }));
		// maxN=3, safe=v1 (oldest): keep v1 (safe) + v4, v5 (newest 2 non-safe).
		const bounded = boundVersions(versions, 3, 'v1');
		expect(bounded.map((v) => v.id).sort()).toEqual(['v1', 'v4', 'v5']);
	});

	it('within the bound keeps everything (no drop)', () => {
		const versions: StackVersion[] = [1, 2, 3].map((i) => ({ id: `v${i}`, timestamp: ts(i), content: `c${i}` }));
		const bounded = boundVersions(versions, 5);
		expect(bounded.map((v) => v.id)).toEqual(['v1', 'v2', 'v3']);
	});

	it('never drops the safe version even when it is the oldest', () => {
		const versions: StackVersion[] = [1, 2, 3, 4].map((i) => ({ id: `v${i}`, timestamp: ts(i), content: `c${i}` }));
		// maxN=2, safe=v1 (oldest): keep v1 + v4 (newest non-safe).
		const bounded = boundVersions(versions, 2, 'v1');
		expect(bounded.map((v) => v.id).sort()).toEqual(['v1', 'v4']);
	});
});

describe('id dedup', () => {
	it('dedups the default id on a timestamp collision', () => {
		const dir = newTempDir();
		const fixedTs = '2026-01-01T00:00:00.000Z';
		const a = saveVersion(dir, 'compose', 'x', { timestamp: fixedTs });
		const b = saveVersion(dir, 'compose', 'y', { timestamp: fixedTs });
		expect(a.id).toBe(fixedTs);
		expect(b.id).toBe(`${fixedTs}-1`); // deduped so ids stay unique
		const list = listVersions(dir, 'compose', 10);
		expect(new Set(list.map((v) => v.id)).size).toBe(2);
	});
});

describe('atomicWriteFile', () => {
	it('a successful write leaves the final file equal to the new data with no .tmp leftover', () => {
		const dir = newTempDir();
		const filePath = join(dir, 'compose.json');
		atomicWriteFile(filePath, 'hello');
		expect(readFileSync(filePath, 'utf8')).toBe('hello');
		expect(existsSync(filePath + '.tmp')).toBe(false);
	});

	it('a pre-existing stale .tmp is replaced, never merged', () => {
		const dir = newTempDir();
		const filePath = join(dir, 'compose.json');
		writeFileSync(filePath, 'v1');
		writeFileSync(filePath + '.tmp', 'garbage');
		atomicWriteFile(filePath, 'v2');
		expect(readFileSync(filePath, 'utf8')).toBe('v2');
		expect(existsSync(filePath + '.tmp')).toBe(false);
	});

	it('a forced tmp-write failure throws, preserves the prior final, leaves no tmp', () => {
		const dir = newTempDir();
		const filePath = join(dir, 'compose.json');
		writeFileSync(filePath, 'v1'); // prior final content
		let threw = false;
		try {
			chmodSync(dir, 0o555); // read-only: creating the tmp file must fail
			try {
				atomicWriteFile(filePath, 'v2');
			} catch {
				threw = true;
			}
		} finally {
			chmodSync(dir, 0o755); // restore so afterEach cleanup works
		}
		expect(threw).toBe(true);
		expect(readFileSync(filePath, 'utf8')).toBe('v1'); // prior content preserved
		expect(existsSync(filePath + '.tmp')).toBe(false); // no tmp left
	});
});

describe('missing dir/file', () => {
	it('listVersions returns [] and readHistoryFile returns empty', () => {
		const dir = newTempDir(); // exists, but no .history/
		expect(listVersions(dir, 'compose')).toEqual([]);
		expect(listVersions(dir, 'env')).toEqual([]);
		expect(readHistoryFile(dir, 'compose')).toEqual({ versions: [] });
	});

	it('a stack dir that does not exist at all also yields []', () => {
		const base = newTempDir();
		const missing = join(base, 'does-not-exist');
		expect(listVersions(missing, 'compose')).toEqual([]);
		expect(readHistoryFile(missing, 'env')).toEqual({ versions: [] });
	});
});

describe('malformed history file', () => {
	it('invalid JSON: readHistoryFile and listVersions throw', () => {
		const dir = newTempDir();
		const file = historyPath(dir, 'compose');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{ this is not valid json');
		expect(() => readHistoryFile(dir, 'compose')).toThrow();
		expect(() => listVersions(dir, 'compose')).toThrow();
	});

	it('valid JSON with the wrong shape (no versions array): readHistoryFile throws', () => {
		const dir = newTempDir();
		const file = historyPath(dir, 'env');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{"foo": 1}');
		expect(() => readHistoryFile(dir, 'env')).toThrow();
		expect(() => listVersions(dir, 'env')).toThrow();
	});
});

describe('assertSecretFree', () => {
	it('does not throw for a clean payload (no secret keys present)', () => {
		const vars: Record<string, string> = { FOO: 'bar', BAZ: 'qux' };
		expect(() => assertSecretFree(vars, ['DB_PASSWORD', 'API_KEY'])).not.toThrow();
	});

	it('does not throw when secretKeys is empty', () => {
		const vars: Record<string, string> = { FOO: 'bar' };
		expect(() => assertSecretFree(vars, [])).not.toThrow();
	});

	it('throws naming the FIRST leaked key (object key order)', () => {
		const vars: Record<string, string> = { FOO: 'bar', DB_PASSWORD: 'hunter2', API_KEY: 'abc' };
		expect(() => assertSecretFree(vars, ['DB_PASSWORD', 'API_KEY'])).toThrow(/DB_PASSWORD/);
	});
});

describe('filterSecretVars', () => {
	it('removes only the secret keys and preserves every non-secret key', () => {
		const vars: Record<string, string> = { FOO: 'bar', DB_PASSWORD: 'hunter2', BAZ: 'qux', API_KEY: 'abc' };
		expect(filterSecretVars(vars, ['DB_PASSWORD', 'API_KEY'])).toEqual({ FOO: 'bar', BAZ: 'qux' });
	});

	it('returns an empty object when every key is secret', () => {
		expect(filterSecretVars({ DB_PASSWORD: 'x', API_KEY: 'y' }, ['DB_PASSWORD', 'API_KEY'])).toEqual({});
	});

	it('does not mutate the input object', () => {
		const vars: Record<string, string> = { FOO: 'bar', DB_PASSWORD: 'hunter2' };
		const filtered = filterSecretVars(vars, ['DB_PASSWORD']);
		expect(vars).toEqual({ FOO: 'bar', DB_PASSWORD: 'hunter2' }); // input unchanged
		expect(vars.DB_PASSWORD).toBe('hunter2');
		expect(filtered).not.toBe(vars); // a new object, not the input
	});
});

describe('end-to-end env secret-free', () => {
	it('parseEnvVars -> filterSecretVars -> saveVersion stores ONLY the non-secret keys', () => {
		const dir = newTempDir();
		const raw = ['# a comment line', 'FOO=bar', 'DB_PASSWORD=hunter2', 'BAZ=qux', 'API_KEY=abc123'].join('\n');
		const secretKeys = ['DB_PASSWORD', 'API_KEY'];
		const filtered = filterSecretVars(parseEnvVars(raw), secretKeys);
		expect(filtered).toEqual({ FOO: 'bar', BAZ: 'qux' });

		saveVersion(dir, 'env', filtered, { secretKeys });

		// Read the saved .history/env.json back via listVersions.
		const list = listVersions(dir, 'env');
		expect(list.length).toBe(1);
		const stored = list[0].content as Record<string, string>;
		// Contains ONLY the non-secret keys ...
		expect(stored).toEqual({ FOO: 'bar', BAZ: 'qux' });
		// ... and NONE of the secret keys.
		for (const k of secretKeys) expect(k in stored).toBe(false);
	});
});

describe('saveVersion env with a leaked secret', () => {
	it('rejects a leaked secret (assertSecretFree throws) and stores nothing', () => {
		const dir = newTempDir();
		const secretKeys = ['DB_PASSWORD'];
		const vars: Record<string, string> = { FOO: 'bar', DB_PASSWORD: 'hunter2' };
		expect(() => saveVersion(dir, 'env', vars, { secretKeys })).toThrow(/DB_PASSWORD/);
		expect(listVersions(dir, 'env')).toEqual([]); // nothing stored
	});

	it('the guard is env-only: compose content is stored as-is even with secretKeys', () => {
		const dir = newTempDir();
		saveVersion(dir, 'compose', 'services:\n', { secretKeys: ['DB_PASSWORD'] });
		expect(listVersions(dir, 'compose').length).toBe(1);
	});
		it('cross-list dedup: saving content equal to an OLDER version drops that older duplicate', () => {
			const dir = newTempDir();
			const t1 = '2026-01-01T00:00:00.000Z';
			const t2 = '2026-01-02T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			// t1: A, t2: B, then (revert-then-save) A again -> t1 dropped, t3 kept.
			saveVersion(dir, 'compose', 'A', { timestamp: t1, id: t1 });
			saveVersion(dir, 'compose', 'B', { timestamp: t2, id: t2 });
			saveVersion(dir, 'compose', 'A', { timestamp: t3, id: t3 });
			const list = listVersions(dir, 'compose');
			expect(list.length).toBe(2);
			expect(list[0].id).toBe(t3);
			expect(list[0].content).toBe('A');
			expect(list[1].id).toBe(t2);
			// t1 is gone - no two identical entries.
			expect(list.some((v) => v.id === t1)).toBe(false);
		});

		it('cross-list dedup: the SAFE (deployed) version survives even when its content matches', () => {
			const dir = newTempDir();
			const t1 = '2026-01-01T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			saveVersion(dir, 'compose', 'A', { timestamp: t1, id: t1 });
			// t1 is the deployed anchor; a new save of the same content appends next
			// to it instead of dropping it.
			saveVersion(dir, 'compose', 'A', { timestamp: t3, id: t3, safe: t1 });
			const list = listVersions(dir, 'compose');
			expect(list.length).toBe(2);
			expect(list.some((v) => v.id === t1)).toBe(true);
			expect(list.some((v) => v.id === t3)).toBe(true);
		});

		it('cross-list dedup applies to env Records (key/value equality)', () => {
			const dir = newTempDir();
			const t1 = '2026-01-01T00:00:00.000Z';
			const t2 = '2026-01-02T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			saveVersion(dir, 'env', { FOO: 'bar' }, { timestamp: t1, id: t1 });
			saveVersion(dir, 'env', { FOO: 'bar', BAZ: 'qux' }, { timestamp: t2, id: t2 });
			// Re-save {FOO: bar} -> the t1 duplicate is dropped; t2 (different) kept.
			saveVersion(dir, 'env', { FOO: 'bar' }, { timestamp: t3, id: t3 });
			const list = listVersions(dir, 'env');
			expect(list.length).toBe(2);
			expect(list[0].id).toBe(t3);
			expect(list[0].content).toEqual({ FOO: 'bar' });
			expect(list[1].id).toBe(t2);
		});

	describe('distinct-content collapse', () => {
		it('collapses the WHOLE list: an older duplicate of any content is dropped on the next save, not just the incoming content', () => {
			const dir = newTempDir();
			const t1 = '2026-01-01T00:00:00.000Z';
			const t2 = '2026-01-02T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			const t4 = '2026-01-04T00:00:00.000Z';
			// Legacy list (as pre-fix code would have left it): A, B, A.
			saveVersion(dir, 'compose', 'A', { timestamp: t1, id: t1 });
			saveVersion(dir, 'compose', 'B', { timestamp: t2, id: t2 });
			// Simulate the pre-fix entry by writing the raw file directly.
			atomicWriteFile(
				historyPath(dir, 'compose'),
				JSON.stringify({
					versions: [
						{ id: t1, timestamp: t1, content: 'A' },
						{ id: t2, timestamp: t2, content: 'B' },
						{ id: t3, timestamp: t3, content: 'A' }
					]
				}, null, 2)
			);
			// Save C: the t1 entry is dropped even though C !== A - the list is a
			// distinct-content timeline, newest representative wins.
			saveVersion(dir, 'compose', 'C', { timestamp: t4, id: t4 });
			const list = listVersions(dir, 'compose');
			expect(list.map((v) => v.id)).toEqual([t4, t3, t2]);
			expect(list.some((v) => v.id === t1)).toBe(false);
		});

		it('pure helper: keeps the newest per content, preserves a SAFE duplicate, reports changed', () => {
			const t1 = '2026-01-01T00:00:00.000Z';
			const t2 = '2026-01-02T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			const v1 = { id: t1, timestamp: t1, content: 'A' };
			const v2 = { id: t2, timestamp: t2, content: 'B' };
			const v3 = { id: t3, timestamp: t3, content: 'A' };
			const r = collapseDuplicateVersions([v1, v2, v3], t1);
			// t1 is the safe anchor: kept even though the newer v3 holds the same
			// content. t2 differs from everything kept. v3 is the newest A.
			expect(r.collapsed.map((v) => v.id)).toEqual([t1, t2, t3]);
			expect(r.changed).toBe(false);
			// Without the safe anchor, t1 is the older duplicate of v3 and drops.
			const r2 = collapseDuplicateVersions([v1, v2, v3]);
			expect(r2.collapsed.map((v) => v.id)).toEqual([t2, t3]);
			expect(r2.changed).toBe(true);
			// Clean list -> unchanged (no rewrite churn).
			expect(collapseDuplicateVersions(r2.collapsed).changed).toBe(false);
		});

		it('collapseHistoryFile rewrites only when the list actually changes', () => {
			const dir = newTempDir();
			const t1 = '2026-01-01T00:00:00.000Z';
			const t2 = '2026-01-02T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			atomicWriteFile(
				historyPath(dir, 'compose'),
				JSON.stringify({
					versions: [
						{ id: t1, timestamp: t1, content: 'A' },
						{ id: t2, timestamp: t2, content: 'B' },
						{ id: t3, timestamp: t3, content: 'A' }
					]
				}, null, 2)
			);
			expect(collapseHistoryFile(dir, 'compose')).toBe(true);
			expect(listVersions(dir, 'compose').map((v) => v.id)).toEqual([t3, t2]);
			// Second pass on the now-clean list: no-op, no rewrite.
			expect(collapseHistoryFile(dir, 'compose')).toBe(false);
		});
	});
});

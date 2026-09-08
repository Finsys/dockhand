/**
 * Integration tests for the PURE stack-version-wiring orchestration module
 * (saveStackVersion / findSafeVersionId / computeRevertedEnvVars /
 * serializeEnvVars).
 *
 * These exercise the REAL module against REAL tmp dirs (node:fs mkdtemp in
 * os.tmpdir) with INJECTABLE writeLive / recordVersion / advancePointer so the
 * crash-safe ordering, rollback, and best-effort pointer semantics can be
 * observed deterministically.
 *
 * ## Purity (MEM016) — do NOT import stacks.ts or db.ts here.
 * A top-level import of either would load better-sqlite3 and crash every test.
 * The module under test is imported directly; importing it successfully under
 * bun:test is itself the strongest purity proof. The explicit grep-style purity
 * check at the bottom re-verifies the module has no stacks.js / db.js /
 * better-sqlite3 import.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	saveStackVersion,
	findSafeVersionId,
	computeRevertedEnvVars,
	serializeEnvVars
} from '../src/lib/server/stack-version-wiring';
import { atomicWriteFile, historyPath, listVersions, saveVersion } from '../src/lib/server/stack-versions';
import type { StackVersion } from '../src/lib/server/stack-versions';

/** Fresh temp dir per test, cleaned up afterwards (mirrors tests/stack-versions.test.ts). */
const tempDirs: string[] = [];
function newTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'sdv-wiring-'));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tempDirs.length) {
		const d = tempDirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
});

/** Fixed millisecond-based ISO timestamp helper for deterministic ordering. */
const ts = (ms: number): string => new Date(ms).toISOString();

/** Is this a valid ISO-8601 timestamp? */
function validIso(s: string): boolean {
	if (typeof s !== 'string' || s.length < 19) return false;
	return !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s);
}

/** Type for the pointer-advance values the module passes to advancePointer. */
type PointerValues = { lastSavedAt?: string; lastDeployedAt?: string };

describe('saveStackVersion — compose', () => {
	it('records .history/compose.json (id + ISO timestamp), writes the live file, advances the pointer', async () => {
		const dir = newTempDir();
		const yaml = 'services:\n  app:\n    image: nginx\n';
		const livePath = join(dir, 'compose.yaml');
		let pointerValues: PointerValues | null = null;

		const res = await saveStackVersion({
			stackDir: dir,
			type: 'compose',
			content: yaml,
			livePath,
			advancePointer: async (values) => {
				pointerValues = values;
			}
		});

		// .history/compose.json created (newest-first) with id + ISO timestamp.
		const list = listVersions(dir, 'compose');
		expect(list.length).toBe(1);
		expect(list[0].id).toBe(res.id);
		expect(validIso(list[0].timestamp)).toBe(true);
		expect(list[0].content).toBe(yaml);
		// Live file written to the new content.
		expect(readFileSync(livePath, 'utf8')).toBe(yaml);
		// Pointer advanced with the returned timestamp.
		expect(pointerValues).toEqual({ lastSavedAt: res.timestamp });
		expect(res.liveWritten).toBe(true);
		expect(res.rolledBack).toBe(false);
	});
});

describe('saveStackVersion — env', () => {
	it('stores ONLY the non-secret Record in .history/env.json, writes the live file, advances the pointer', async () => {
		const dir = newTempDir();
		const content = ['# comment', 'FOO=bar', 'DB_PASSWORD=hunter2', 'BAZ=qux'].join('\n');
		const secretKeys = ['DB_PASSWORD'];
		const livePath = join(dir, '.env');
		let pointerValues: PointerValues | null = null;

		const res = await saveStackVersion({
			stackDir: dir,
			type: 'env',
			content,
			secretKeys,
			livePath,
			advancePointer: async (values) => {
				pointerValues = values;
			}
		});

		// .history/env.json stores only the non-secret record.
		const list = listVersions(dir, 'env');
		expect(list.length).toBe(1);
		const stored = list[0].content as Record<string, string>;
		expect(stored).toEqual({ FOO: 'bar', BAZ: 'qux' });
		expect('DB_PASSWORD' in stored).toBe(false);
		// Live file written verbatim.
		expect(readFileSync(livePath, 'utf8')).toBe(content);
		// Pointer advanced.
		expect(pointerValues).toEqual({ lastSavedAt: res.timestamp });
		expect(res.liveWritten).toBe(true);
	});

	it('filters a leaked secret key out before store; save does NOT throw', async () => {
		const dir = newTempDir();
		const content = ['FOO=bar', 'DB_PASSWORD=hunter2', 'API_KEY=abc'].join('\n');
		const secretKeys = ['DB_PASSWORD', 'API_KEY'];

		// recordVersion = saveVersion (default); if the secret were NOT filtered it
		// would trip saveVersion's assertSecretFree guard and throw. It is filtered,
		// so the save succeeds.
		const res = await saveStackVersion({
			stackDir: dir,
			type: 'env',
			content,
			secretKeys
		});

		const list = listVersions(dir, 'env');
		expect(list.length).toBe(1);
		const stored = list[0].content as Record<string, string>;
		expect(stored).toEqual({ FOO: 'bar' });
		expect('DB_PASSWORD' in stored).toBe(false);
		expect('API_KEY' in stored).toBe(false);
		expect(res.id).toBeTruthy();
		expect(res.liveWritten).toBe(false); // livePath omitted
	});
});

	describe('saveStackVersion — no-op duplicate content', () => {
		it('identical compose content: no new version, pointer NOT advanced, skipped=true', async () => {
			const dir = newTempDir();
			const livePath = join(dir, 'compose.yaml');
			const yaml = 'services:\n  app:\n    image: nginx\n';
			const advances: PointerValues[] = [];

			const r1 = await saveStackVersion({
				stackDir: dir,
				type: 'compose',
				content: yaml,
				livePath,
				advancePointer: (values) => {
					advances.push(values);
				}
			});
			expect(r1.skipped).toBe(false);

			const r2 = await saveStackVersion({
				stackDir: dir,
				type: 'compose',
				content: yaml,
				livePath,
				advancePointer: (values) => {
					advances.push(values);
				}
			});
			expect(r2.skipped).toBe(true);
			// References the pre-existing version; no pointer churn, no duplicate entry.
			expect(r2.id).toBe(r1.id);
			expect(r2.timestamp).toBe(r1.timestamp);
			expect(advances.length).toBe(1);
			expect(listVersions(dir, 'compose').length).toBe(1);
		});

		it('env: comment-only change is a no-op (live file keeps the formatting); a value change is not', async () => {
			const dir = newTempDir();
			const livePath = join(dir, '.env');
			const advances: PointerValues[] = [];
			const advance = (values: PointerValues) => {
				advances.push(values);
			};

			const r1 = await saveStackVersion({
				stackDir: dir,
				type: 'env',
				content: 'FOO=bar\n',
				livePath,
				advancePointer: advance
			});
			expect(r1.skipped).toBe(false);

			// Same parsed vars (plus a comment) -> no-op, but the live file picks
			// up the new formatting (live write precedes the no-op check).
			const r2 = await saveStackVersion({
				stackDir: dir,
				type: 'env',
				content: '# note\nFOO=bar\n',
				livePath,
				advancePointer: advance
			});
			expect(r2.skipped).toBe(true);
			expect(r2.id).toBe(r1.id);
			expect(advances.length).toBe(1);
			expect(listVersions(dir, 'env').length).toBe(1);
			expect(readFileSync(livePath, 'utf8')).toBe('# note\nFOO=bar\n');

			// A real value change records a new version and advances the pointer.
			const r3 = await saveStackVersion({
				stackDir: dir,
				type: 'env',
				content: '# note\nFOO=baz\n',
				livePath,
				advancePointer: advance
			});
			expect(r3.skipped).toBe(false);
			expect(advances.length).toBe(2);
			const list = listVersions(dir, 'env');
			expect(list.length).toBe(2);
			expect(list[0].content).toEqual({ FOO: 'baz' });
		});

		it('revert-then-save: an older duplicate is dropped and the new entry is the single representative', async () => {
			const dir = newTempDir();
			const livePath = join(dir, 'compose.yaml');
			const advances: PointerValues[] = [];
			const advance = (values: PointerValues) => {
				advances.push(values);
			};

			// v1: A, v2: B (both saved live).
			const r1 = await saveStackVersion({
				stackDir: dir,
				type: 'compose',
				content: 'A',
				livePath,
				advancePointer: advance
			});
			await saveStackVersion({
				stackDir: dir,
				type: 'compose',
				content: 'B',
				livePath,
				advancePointer: advance
			});

			// Revert to A (live file back to A) and SAVE it: not a no-op (newest is
			// B), so a new entry is recorded AND the older A duplicate is dropped.
			const r3 = await saveStackVersion({
				stackDir: dir,
				type: 'compose',
				content: 'A',
				livePath,
				advancePointer: advance
			});
			expect(r3.skipped).toBe(false);
			expect(r3.id).not.toBe(r1.id);
			const list = listVersions(dir, 'compose');
			expect(list.length).toBe(2);
			expect(list[0].id).toBe(r3.id);
			expect(list[0].content).toBe('A');
			expect(list[1].content).toBe('B');
			// The older A (r1) is gone; the pointer advanced once per actual save.
			expect(list.some((v) => v.id === r1.id)).toBe(false);
			expect(advances.length).toBe(3);
		});

		it('no-op save normalizes a stale duplicate list left by pre-fix code', async () => {
			const dir = newTempDir();
			const livePath = join(dir, 'compose.yaml');
			const t1 = '2026-01-01T00:00:00.000Z';
			const t2 = '2026-01-02T00:00:00.000Z';
			const t3 = '2026-01-03T00:00:00.000Z';
			const advances: PointerValues[] = [];

			// Legacy list: A, B, A (as pre-fix saves would have left it).
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

			// Saving A (== newest) is a NO-OP - but it still collapses the stale
			// duplicate (t1), and advances no pointer.
			const r = await saveStackVersion({
				stackDir: dir,
				type: 'compose',
				content: 'A',
				livePath,
				advancePointer: (values) => {
					advances.push(values);
				}
			});
			expect(r.skipped).toBe(true);
			expect(r.id).toBe(t3);
			expect(advances.length).toBe(0);
			const list = listVersions(dir, 'compose');
			expect(list.map((v) => v.id)).toEqual([t3, t2]);
			expect(list.some((v) => v.id === t1)).toBe(false);
		});
	});

describe('saveStackVersion — failure / rollback / ordering', () => {
	it('mid-write failure: recordVersion throws -> live file restored, .history unchanged, advancePointer NOT called', async () => {
		const dir = newTempDir();
		const livePath = join(dir, '.env');

		// Pre-create the live file with previous content.
		writeFileSync(livePath, 'PREV=content');
		// Pre-create a .history file with an existing version.
		saveVersion(dir, 'env', { PREV: 'content' }, { id: 'v1', timestamp: ts(1_000), maxVersions: 100 });
		expect(listVersions(dir, 'env').length).toBe(1);

		let pointerCalled = false;
		let threw = false;
		try {
			await saveStackVersion({
				stackDir: dir,
				type: 'env',
				content: 'NEW=content',
				livePath,
				advancePointer: async () => {
					pointerCalled = true;
				},
				// Inject a recordVersion that THROWS (simulates a version-write failure).
				recordVersion: () => {
					throw new Error('version write failed');
				}
			});
		} catch {
			threw = true;
		}

		expect(threw).toBe(true);
		// Live file RESTORED to the previous content.
		expect(readFileSync(livePath, 'utf8')).toBe('PREV=content');
		// .history file UNCHANGED (still only the previous version v1).
		const list = listVersions(dir, 'env');
		expect(list.length).toBe(1);
		expect(list[0].id).toBe('v1');
		// advancePointer NOT called (it runs after recordVersion, which threw).
		expect(pointerCalled).toBe(false);
	});

	it('crash-safe ordering: writeLive precedes recordVersion (live-file-first)', async () => {
		const dir = newTempDir();
		const livePath = join(dir, 'compose.yaml');
		const log: string[] = [];

		await saveStackVersion({
			stackDir: dir,
			type: 'compose',
			content: 'yaml',
			livePath,
			writeLive: () => {
				log.push('writeLive');
			},
			recordVersion: () => {
				log.push('recordVersion');
				return { id: 'x', timestamp: ts(5_000) };
			}
		});

		expect(log).toEqual(['writeLive', 'recordVersion']);
	});
});

describe('saveStackVersion — GIT env (livePath omitted)', () => {
	it('records the version, writes NO live file (writeLive not called), advances the pointer', async () => {
		const dir = newTempDir();
		const content = 'FOO=bar\nDB_PASSWORD=hunter2';
		const secretKeys = ['DB_PASSWORD'];
		let writeLiveCalled = false;
		let pointerValues: PointerValues | null = null;

		const res = await saveStackVersion({
			stackDir: dir,
			type: 'env',
			content,
			secretKeys,
			// livePath omitted: GIT env, DB is the live source.
			writeLive: () => {
				writeLiveCalled = true;
			},
			advancePointer: async (values) => {
				pointerValues = values;
			}
		});

		// Version recorded (default recordVersion = saveVersion -> .history/env.json).
		const list = listVersions(dir, 'env');
		expect(list.length).toBe(1);
		expect(list[0].content).toEqual({ FOO: 'bar' });
		// NO live file written.
		expect(writeLiveCalled).toBe(false);
		expect(res.liveWritten).toBe(false);
		// Pointer advanced.
		expect(pointerValues).toEqual({ lastSavedAt: res.timestamp });
	});
});

describe('findSafeVersionId', () => {
	it('returns the newest id whose timestamp <= lastDeployedAt', () => {
		const versions: StackVersion[] = [
			{ id: 'a', timestamp: ts(1_000), content: 'x' },
			{ id: 'b', timestamp: ts(2_000), content: 'y' },
			{ id: 'c', timestamp: ts(3_000), content: 'z' }
		];
		// lastDeployedAt between ts(2000) and ts(3000) -> b is the newest <= it.
		expect(findSafeVersionId(versions, ts(2_500))).toBe('b');
		// Exactly at a version boundary -> that version.
		expect(findSafeVersionId(versions, ts(3_000))).toBe('c');
		// Before the earliest -> the earliest.
		expect(findSafeVersionId(versions, ts(1_500))).toBe('a');
	});

	it('returns undefined for null / undefined lastDeployedAt', () => {
		const versions: StackVersion[] = [{ id: 'a', timestamp: ts(1_000), content: 'x' }];
		expect(findSafeVersionId(versions, null)).toBeUndefined();
		expect(findSafeVersionId(versions, undefined)).toBeUndefined();
	});

	it('returns undefined when no version timestamp is <= lastDeployedAt', () => {
		const versions: StackVersion[] = [
			{ id: 'a', timestamp: ts(5_000), content: 'x' },
			{ id: 'b', timestamp: ts(6_000), content: 'y' }
		];
		expect(findSafeVersionId(versions, ts(1_000))).toBeUndefined();
	});

	it('ties (identical timestamp) are broken by id (larger id wins)', () => {
		const t = ts(3_000);
		const versions: StackVersion[] = [
			{ id: 'a', timestamp: t, content: 'x' },
			{ id: 'b', timestamp: t, content: 'y' },
			{ id: 'z', timestamp: t, content: 'w' }
		];
		expect(findSafeVersionId(versions, t)).toBe('z');
	});
});

describe('computeRevertedEnvVars', () => {
	it('version non-secret values override current; current secrets preserved verbatim; current non-secrets absent from the version are dropped; no secret lost', () => {
		const currentVars = [
			{ key: 'FOO', value: 'c-foo', isSecret: false },
			{ key: 'BAZ', value: 'c-baz', isSecret: false },
			{ key: 'EXTRA', value: 'c-extra', isSecret: false }, // not in version -> dropped
			{ key: 'DB_PASSWORD', value: 'c-secret', isSecret: true }, // preserved
			{ key: 'API_KEY', value: 'c-key', isSecret: true } // preserved
		];
		const versionRecord = { FOO: 'v-foo', BAZ: 'v-baz' };

		const result = computeRevertedEnvVars(currentVars, versionRecord);
		const byKey: Record<string, { value: string; isSecret?: boolean }> = Object.fromEntries(
			result.map((v) => [v.key, v])
		);

		// Version non-secret values override current.
		expect(byKey.FOO.value).toBe('v-foo');
		expect(byKey.FOO.isSecret).toBe(false);
		expect(byKey.BAZ.value).toBe('v-baz');
		expect(byKey.BAZ.isSecret).toBe(false);
		// Current secrets preserved verbatim.
		expect(byKey.DB_PASSWORD.value).toBe('c-secret');
		expect(byKey.DB_PASSWORD.isSecret).toBe(true);
		expect(byKey.API_KEY.value).toBe('c-key');
		expect(byKey.API_KEY.isSecret).toBe(true);
		// Current non-secret absent from the version is dropped.
		expect('EXTRA' in byKey).toBe(false);
		// Exactly 4 entries (2 version non-secrets + 2 preserved secrets).
		expect(result.length).toBe(4);
	});

	it('empty version record -> only current secrets survive', () => {
		const currentVars = [
			{ key: 'ONLY_NONSECRET', value: 'x', isSecret: false },
			{ key: 'S', value: 'secret', isSecret: true }
		];
		const result = computeRevertedEnvVars(currentVars, {});
		expect(result.length).toBe(1);
		expect(result[0].key).toBe('S');
		expect(result[0].value).toBe('secret');
		expect(result[0].isSecret).toBe(true);
	});

	it('empty current + version -> empty result', () => {
		expect(computeRevertedEnvVars([], {})).toEqual([]);
	});
});

describe('serializeEnvVars', () => {
	it('joins KEY=VALUE lines with \\n', () => {
		expect(serializeEnvVars({ FOO: 'bar', BAZ: 'qux' })).toBe('FOO=bar\nBAZ=qux');
	});

	it('empty record -> empty string', () => {
		expect(serializeEnvVars({})).toBe('');
	});
});

describe('module purity (MEM016)', () => {
	// The module source, resolved relative to this test file.
	const MODULE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'server', 'stack-version-wiring.ts');

	/** Extract every import/require specifier (from 'x', import('x'), require('x')). */
	function extractImportSpecifiers(src: string): string[] {
		const specifiers: string[] = [];
		const fromRe = /from\s+['"]([^'"]+)['"]/g;
		const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		let m: RegExpExecArray | null;
		while ((m = fromRe.exec(src)) !== null) specifiers.push(m[1]);
		while ((m = dynamicRe.exec(src)) !== null) specifiers.push(m[1]);
		while ((m = requireRe.exec(src)) !== null) specifiers.push(m[1]);
		return specifiers;
	}

	it('imports ONLY node:fs / node:path / ./stack-versions.js / ./env-parser.js', () => {
		const src = readFileSync(MODULE_SRC, 'utf8');
		const specifiers = extractImportSpecifiers(src);
		// There must be imports at all (node:fs + ./stack-versions.js).
		expect(specifiers.length).toBeGreaterThanOrEqual(2);
		const allowed = new Set(['node:fs', 'node:path', './stack-versions.js', './env-parser.js']);
		for (const s of specifiers) {
			expect(allowed.has(s), `unexpected import specifier: ${s}`).toBe(true);
		}
	});

	it('has NO import of stacks.js / db.js / better-sqlite3', () => {
		const src = readFileSync(MODULE_SRC, 'utf8');
		const specifiers = extractImportSpecifiers(src);
		for (const s of specifiers) {
			expect(s.includes('stacks.js'), `unexpected stacks.js import: ${s}`).toBe(false);
			expect(s.endsWith('db.js') || s.includes('/db.js'), `unexpected db.js import: ${s}`).toBe(false);
			expect(s.includes('better-sqlite3'), `unexpected better-sqlite3 import: ${s}`).toBe(false);
		}
	});
});

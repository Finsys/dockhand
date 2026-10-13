/**
 * Unit tests for mergeGitStackEnvVars + isGitStackOverride.
 *
 * A git stack's editor must show the full effective env set on reopen: the repo
 * .env vars (base) plus the DB overrides/secrets on top. The save path stores only
 * overrides (isGitStackOverride), so the merged output fed back through that predicate
 * must still drop untouched file vars - otherwise a save would persist the whole .env
 * into the DB and break git-sync pickup.
 */

import { describe, test, expect } from 'bun:test';
import { mergeGitStackEnvVars, isGitStackOverride, type EnvVar } from '../src/lib/env-merge';

describe('mergeGitStackEnvVars', () => {
	test('(a) untouched file var is shown non-secret, straight from the file', () => {
		const merged = mergeGitStackEnvVars({ TZ: 'Europe/Berlin' }, []);
		expect(merged).toEqual([{ key: 'TZ', value: 'Europe/Berlin', isSecret: false }]);
	});

	test('(b) a DB non-secret override wins over the file value', () => {
		const merged = mergeGitStackEnvVars(
			{ TZ: 'UTC', PORT: '8080' },
			[{ key: 'TZ', value: 'Europe/Berlin', isSecret: false }]
		);
		expect(merged).toEqual([
			{ key: 'TZ', value: 'Europe/Berlin', isSecret: false },
			{ key: 'PORT', value: '8080', isSecret: false }
		]);
	});

	test('(c) a DB-only user var (no file entry) is preserved', () => {
		const merged = mergeGitStackEnvVars(
			{ TZ: 'UTC' },
			[{ key: 'EXTRA', value: 'x', isSecret: false }]
		);
		expect(merged).toEqual([
			{ key: 'TZ', value: 'UTC', isSecret: false },
			{ key: 'EXTRA', value: 'x', isSecret: false }
		]);
	});

	test('(d) a DB secret (masked) wins over a same-named file key and stays secret', () => {
		const merged = mergeGitStackEnvVars(
			{ API_KEY: 'plain-from-file', TZ: 'UTC' },
			[{ key: 'API_KEY', value: '***', isSecret: true }]
		);
		expect(merged).toEqual([
			{ key: 'API_KEY', value: '***', isSecret: true },
			{ key: 'TZ', value: 'UTC', isSecret: false }
		]);
	});

	test('(e) empty fileVars (default .env missing) yields just the DB set', () => {
		const merged = mergeGitStackEnvVars({}, [
			{ key: 'OVERRIDE', value: 'v', isSecret: false },
			{ key: 'SECRET', value: '***', isSecret: true }
		]);
		expect(merged).toEqual([
			{ key: 'OVERRIDE', value: 'v', isSecret: false },
			{ key: 'SECRET', value: '***', isSecret: true }
		]);
	});

	test('(g) DB keys are trimmed and blank DB keys are dropped', () => {
		// A padded key must override the same file key (not append a duplicate row);
		// a whitespace-only key must be dropped entirely.
		const merged = mergeGitStackEnvVars({ TZ: 'UTC' }, [
			{ key: ' TZ ', value: 'X', isSecret: false },
			{ key: '   ', value: 'phantom', isSecret: false }
		]);
		expect(merged).toEqual([{ key: 'TZ', value: 'X', isSecret: false }]);
	});
});

describe('isGitStackOverride (the save/preserve predicate)', () => {
	const fileVars = { TZ: 'UTC', PORT: '8080' };

	test('drops a blank key', () => {
		expect(isGitStackOverride({ key: '  ', value: 'x', isSecret: false }, fileVars)).toBe(false);
	});
	test('drops a non-secret var equal to the file value', () => {
		expect(isGitStackOverride({ key: 'TZ', value: 'UTC', isSecret: false }, fileVars)).toBe(false);
	});
	test('keeps a non-secret var that differs from the file value', () => {
		expect(isGitStackOverride({ key: 'PORT', value: '9090', isSecret: false }, fileVars)).toBe(true);
	});
	test('keeps a var with no file counterpart', () => {
		expect(isGitStackOverride({ key: 'NEW', value: 'y', isSecret: false }, fileVars)).toBe(true);
	});
	test('keeps a secret even when equal to the file value', () => {
		expect(isGitStackOverride({ key: 'TZ', value: 'UTC', isSecret: true }, fileVars)).toBe(true);
	});
});

describe('round-trip: merge output through the save predicate persists nothing new', () => {
	test('(f) merged output drops untouched file vars, keeps override + secret', () => {
		const fileVars = { TZ: 'UTC', PORT: '8080', HOST: 'localhost' };
		const dbVars: EnvVar[] = [
			{ key: 'PORT', value: '9090', isSecret: false }, // real override
			{ key: 'API_KEY', value: '***', isSecret: true } // secret, no file entry
		];

		const merged = mergeGitStackEnvVars(fileVars, dbVars);
		// The editor shows everything: TZ, PORT(override), HOST, API_KEY.
		expect(merged.map((v) => v.key)).toEqual(['TZ', 'PORT', 'HOST', 'API_KEY']);

		// Saving persists ONLY the override + the secret - the untouched TZ/HOST
		// (equal to file) are dropped, so the DB stays override-only (git-sync intact).
		const persisted = merged.filter((v) => isGitStackOverride(v, fileVars));
		expect(persisted).toEqual([
			{ key: 'PORT', value: '9090', isSecret: false },
			{ key: 'API_KEY', value: '***', isSecret: true }
		]);
	});

	test('(f2) round-trip with NO overrides persists nothing (pure untouched .env)', () => {
		const fileVars = { A: '1', B: '2' };
		const merged = mergeGitStackEnvVars(fileVars, []);
		expect(merged.filter((v) => isGitStackOverride(v, fileVars))).toEqual([]);
	});
});

describe('re-populate never clobbers the current editor (the populateEnvVars path)', () => {
	// populateEnvVars refreshes the file base from the repo, then merges the current
	// editor (trimmed) on top. Merge lets the editor (DB side) win, so any value the
	// user is looking at survives a re-populate; only NEW repo keys are added. This is
	// the "don't clobber my edits" contract - a non-secret editor value that differs
	// from the fresh repo cannot be distinguished from a real edit, so it is kept.
	// The round-trip stays consistent: a kept value that differs from the fresh repo is
	// then persisted as a real override and the deploy reflects exactly what was shown.
	test('editor values win; new repo keys are added', () => {
		const currentEditor: EnvVar[] = [
			{ key: 'TZ', value: 'UTC', isSecret: false }, // kept (differs from fresh repo)
			{ key: 'PORT', value: '9090', isSecret: false }, // user override, kept
			{ key: 'API_KEY', value: '***', isSecret: true }, // secret, kept
			{ key: '  ', value: 'blank', isSecret: false } // blank key, dropped
		];
		const freshRepo = { TZ: 'Europe/Berlin', PORT: '80', HOST: 'example' };

		const merged = mergeGitStackEnvVars(freshRepo, currentEditor.filter((v) => v.key.trim()));

		expect(merged).toEqual([
			{ key: 'TZ', value: 'UTC', isSecret: false }, // editor value wins (not clobbered)
			{ key: 'PORT', value: '9090', isSecret: false }, // override preserved
			{ key: 'HOST', value: 'example', isSecret: false }, // new repo var appears
			{ key: 'API_KEY', value: '***', isSecret: true } // secret preserved
		]);
	});
});

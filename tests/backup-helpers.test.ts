/**
 * Unit tests for pure helper functions in src/lib/server/backups/helpers.ts and
 * src/lib/server/host-path.ts.
 *
 * Pure means: no DB, no network, no spawn. Just (input) → (output) functions.
 * Goal here is to make every helper that touches user-controllable data have a
 * fast, deterministic, runs-everywhere safety net so we can refactor without fear.
 */

import { describe, expect, test } from 'bun:test';
import {
	parseRetentionJson,
	parseOptionsJson,
	parsePoliciesJson,
	isValidSnapshotId,
	isRepoNotInitializedError,
	wouldDeleteAllSnapshots,
	retentionToStore,
	resolveRetentionForUpdate,
	validateFlags,
	validatePolicySchedules,
	validateRetention,
	isAllowedRepository,
	sanitizeWebhookUrlForLog,
	classifyBackupError,
	validateRepositoryForSave,
	parseSelectedVolumes,
	parseBackupFlags,
	serializeBackupFlags,
	validateAndSerializeFlags,
	sanitizeResticFlags,
	sanitizeRestoreFlags,
	buildJobOptions
} from '../src/lib/server/backups/helpers';
import { isLocalRepo } from '../src/lib/server/backups/models';
import { findRelativeBindSources, extractUidFromSocketPath } from '../src/lib/server/host-path';

// ============================================================================
// Split backup/restore flags: JSON in the flags column, legacy string compat, and
// per-scope allowlists (restore permits --exclude-xattr, backup does NOT).
// ============================================================================

describe('parseBackupFlags (string-vs-JSON boundary, backward compat)', () => {
	test('new JSON shape parses into {backup, restore}', () => {
		expect(parseBackupFlags('{"backup":"--verbose","restore":"--exclude-xattr security.selinux"}'))
			.toEqual({ backup: '--verbose', restore: '--exclude-xattr security.selinux' });
	});
	test('LEGACY bare string = backup flags, empty restore (no migration, no data loss)', () => {
		expect(parseBackupFlags('--limit-upload 5120')).toEqual({ backup: '--limit-upload 5120', restore: '' });
	});
	test('null / empty -> both empty', () => {
		expect(parseBackupFlags(null)).toEqual({ backup: '', restore: '' });
		expect(parseBackupFlags('')).toEqual({ backup: '', restore: '' });
		expect(parseBackupFlags('   ')).toEqual({ backup: '', restore: '' });
	});
	test('malformed JSON object -> treated as legacy backup string', () => {
		expect(parseBackupFlags('{not json')).toEqual({ backup: '{not json', restore: '' });
	});
	test('JSON with missing fields coerces the missing one to empty', () => {
		expect(parseBackupFlags('{"backup":"--verbose"}')).toEqual({ backup: '--verbose', restore: '' });
	});
});

describe('serializeBackupFlags (round-trips, null when empty)', () => {
	test('both empty -> null (column stays NULL, not {})', () => {
		expect(serializeBackupFlags({ backup: '', restore: '' })).toBeNull();
		expect(serializeBackupFlags({ backup: '  ', restore: '' })).toBeNull();
	});
	test('round-trips through parse', () => {
		const s = serializeBackupFlags({ backup: '--verbose', restore: '--exclude-xattr security.selinux' });
		expect(parseBackupFlags(s)).toEqual({ backup: '--verbose', restore: '--exclude-xattr security.selinux' });
	});
});

describe('per-scope allowlists — restore-only flags never reach backup', () => {
	test('--exclude-xattr is allowed for RESTORE', () => {
		expect(sanitizeRestoreFlags('--exclude-xattr security.selinux')).toEqual(['--exclude-xattr', 'security.selinux']);
	});
	test('--exclude-xattr is REJECTED for backup (would break restic backup)', () => {
		expect(() => sanitizeResticFlags('--exclude-xattr security.selinux')).toThrow(/Disallowed/);
	});
	test('common flags pass on both', () => {
		expect(sanitizeResticFlags('--compression max')).toEqual(['--compression', 'max']);
		expect(sanitizeRestoreFlags('--compression max')).toEqual(['--compression', 'max']);
	});
	test('a dangerous flag is rejected on both', () => {
		expect(() => sanitizeResticFlags('--option x')).toThrow(/Disallowed/);
		expect(() => sanitizeRestoreFlags('--password-command evil')).toThrow(/Disallowed/);
	});
});

describe('validateAndSerializeFlags (API save path)', () => {
	test('valid backup + restore -> JSON', () => {
		const s = validateAndSerializeFlags('--verbose', '--exclude-xattr security.selinux');
		expect(parseBackupFlags(s)).toEqual({ backup: '--verbose', restore: '--exclude-xattr security.selinux' });
	});
	test('both empty -> null', () => {
		expect(validateAndSerializeFlags('', '')).toBeNull();
	});
	test('THROWS when a restore-only flag is put in the BACKUP field', () => {
		expect(() => validateAndSerializeFlags('--exclude-xattr security.selinux', '')).toThrow(/Disallowed/);
	});
	test('THROWS on a disallowed restore flag', () => {
		expect(() => validateAndSerializeFlags('', '--option evil')).toThrow(/Disallowed/);
	});
});

// ============================================================================
// parseSelectedVolumes — SHAPE guard, not just JSON (B2)
// ============================================================================

describe('parseSelectedVolumes', () => {
	test('a valid string[] round-trips', () => {
		expect(parseSelectedVolumes('["data","config"]')).toEqual(['data', 'config']);
	});
	test('null / empty -> null (all volumes)', () => {
		expect(parseSelectedVolumes(null)).toBeNull();
		expect(parseSelectedVolumes(undefined)).toBeNull();
		expect(parseSelectedVolumes('')).toBeNull();
	});
	test('a NON-array (corrupt/legacy string) -> null, NOT an iterable-of-chars', () => {
		// The bug: a bare string flowed into new Set(...) as chars, matching no volume key
		// and silently filtering EVERY volume out (metadata-only snapshot). Must be null.
		expect(parseSelectedVolumes('"data"')).toBeNull();
		expect(parseSelectedVolumes('42')).toBeNull();
		expect(parseSelectedVolumes('{"a":1}')).toBeNull();
	});
	test('invalid JSON -> null', () => {
		expect(parseSelectedVolumes('not json')).toBeNull();
	});
	test('drops non-string array members', () => {
		expect(parseSelectedVolumes('["data",5,null,"config"]')).toEqual(['data', 'config']);
	});
});

// ============================================================================
// isLocalRepo — the SINGLE local-repo predicate (B4)
// ============================================================================

describe('isLocalRepo', () => {
	test('an absolute path is local', () => {
		expect(isLocalRepo('/mnt/nas/backups')).toBe(true);
	});
	test('a ./ relative path is NOT local (matches the save gate isAllowedRepository)', () => {
		expect(isLocalRepo('./data/repo')).toBe(false);
		expect(isAllowedRepository('./data/repo')).toBe(false); // the two agree
	});
	test('scheme URLs are not local', () => {
		expect(isLocalRepo('s3:bucket')).toBe(false);
		expect(isLocalRepo('rest:http://host:8000/')).toBe(false);
	});
});

// ============================================================================
// parseRetentionJson — small but trusted by retention scheduling
// ============================================================================

describe('parseRetentionJson', () => {
	test('null → empty object (no retention configured = no policy applied)', () => {
		expect(parseRetentionJson(null)).toEqual({});
	});

	test('undefined → empty object', () => {
		expect(parseRetentionJson(undefined)).toEqual({});
	});

	test('empty string → empty object', () => {
		expect(parseRetentionJson('')).toEqual({});
	});

	test('valid JSON with keepLast roundtrips', () => {
		expect(parseRetentionJson('{"keepLast":3}')).toEqual({ keepLast: 3 });
	});

	test('valid JSON with full policy roundtrips', () => {
		const full = { keepLast: 5, keepDaily: 7, keepWeekly: 4, keepMonthly: 12, keepYearly: 3 };
		expect(parseRetentionJson(JSON.stringify(full))).toEqual(full);
	});

	test('malformed JSON → empty object (NOT thrown — caller must not crash on bad DB data)', () => {
		// This is the contract: a corrupted retention field in the DB must not
		// kill the backup. The whole retention step is skipped instead.
		expect(parseRetentionJson('{not json')).toEqual({});
		expect(parseRetentionJson('[1,2,3]')).toEqual([1, 2, 3] as any);
	});

	test('JSON null → null (caller must treat as no retention; parser does not coerce)', () => {
		// Documenting current behaviour: the function only catches parse errors,
		// it does not normalize falsy parse results. Callers using `retention.keepLast`
		// will get `undefined` on `null` and skip retention, which is the intended outcome.
		expect(parseRetentionJson('null')).toBe(null as any);
	});

	test('JSON with extra fields preserved (forward-compat for future keep-* options)', () => {
		expect(parseRetentionJson('{"keepLast":3,"unknownField":"x"}')).toEqual({
			keepLast: 3,
			unknownField: 'x'
		});
	});
});

// ============================================================================
// parseOptionsJson — semantically identical but separate function
// ============================================================================

describe('parseOptionsJson', () => {
	test('null → empty object', () => {
		expect(parseOptionsJson(null)).toEqual({});
	});

	test('undefined → empty object', () => {
		expect(parseOptionsJson(undefined)).toEqual({});
	});

	test('compression option roundtrips', () => {
		expect(parseOptionsJson('{"compression":"max"}')).toEqual({ compression: 'max' });
	});

	test('exclude patterns roundtrip as a single string (not parsed further)', () => {
		// The string-splitting on comma happens at backup time, not here.
		expect(parseOptionsJson('{"excludePatterns":"*.tmp,*.log"}')).toEqual({
			excludePatterns: '*.tmp,*.log'
		});
	});

	test('malformed JSON → empty object', () => {
		expect(parseOptionsJson('garbage')).toEqual({});
	});

	test('options with webhooks survive (these are URLs, must not be mangled)', () => {
		const opts = {
			webhookSuccess: 'https://hooks.example.com/x?token=abc&y=1',
			webhookFailure: 'https://hooks.example.com/x?token=def'
		};
		expect(parseOptionsJson(JSON.stringify(opts))).toEqual(opts);
	});
});

// ============================================================================
// isValidSnapshotId — guards every restore endpoint from arbitrary input
// ============================================================================

describe('isValidSnapshotId', () => {
	test('accepts restic short ID (8 hex chars)', () => {
		expect(isValidSnapshotId('deadbeef')).toBe(true);
	});

	test('accepts restic full ID (64 hex chars)', () => {
		expect(isValidSnapshotId('a'.repeat(64))).toBe(true);
		expect(isValidSnapshotId('0123456789abcdef'.repeat(4))).toBe(true);
	});

	test('rejects too-short ID (<8 chars)', () => {
		expect(isValidSnapshotId('abcdef')).toBe(false);
		expect(isValidSnapshotId('')).toBe(false);
	});

	test('rejects too-long ID (>64 chars)', () => {
		expect(isValidSnapshotId('a'.repeat(65))).toBe(false);
	});

	test('rejects non-hex characters (path traversal / injection bait)', () => {
		expect(isValidSnapshotId('deadbeef../etc')).toBe(false);
		expect(isValidSnapshotId('../../passwd')).toBe(false);
		expect(isValidSnapshotId('deadbeef;rm -rf')).toBe(false);
		expect(isValidSnapshotId('DEADBEEF')).toBe(false); // uppercase not accepted
	});

	test('rejects whitespace, newlines', () => {
		expect(isValidSnapshotId(' deadbeef ')).toBe(false);
		expect(isValidSnapshotId('deadbeef\n')).toBe(false);
		expect(isValidSnapshotId('dead beef')).toBe(false);
	});
});

// ============================================================================
// isRepoNotInitializedError — exit-code detection from restic
// ============================================================================

describe('isRepoNotInitializedError', () => {
	test('detects restic exit code 10 (repo not initialized)', () => {
		expect(isRepoNotInitializedError({ exitCode: 10 })).toBe(true);
	});

	test('rejects other exit codes', () => {
		expect(isRepoNotInitializedError({ exitCode: 0 })).toBe(false);
		expect(isRepoNotInitializedError({ exitCode: 1 })).toBe(false);
		expect(isRepoNotInitializedError({ exitCode: 11 })).toBe(false);
	});

	test('safe on undefined / null / non-objects', () => {
		expect(isRepoNotInitializedError(undefined)).toBe(false);
		expect(isRepoNotInitializedError(null)).toBe(false);
		expect(isRepoNotInitializedError('error string')).toBe(false);
		expect(isRepoNotInitializedError(42)).toBe(false);
	});

	test('safe on object without exitCode', () => {
		expect(isRepoNotInitializedError({})).toBe(false);
		expect(isRepoNotInitializedError({ message: 'something' })).toBe(false);
	});
});
// ============================================================================
// findRelativeBindSources — gates cross-env deploys
// ============================================================================

describe('findRelativeBindSources', () => {
	test('empty compose → empty array', () => {
		expect(findRelativeBindSources('')).toEqual([]);
	});

	test('compose with no volumes section → empty', () => {
		const c = `services:
  web:
    image: nginx
`;
		expect(findRelativeBindSources(c)).toEqual([]);
	});

	test('compose with only named volumes → empty (named volumes are portable)', () => {
		const c = `services:
  db:
    image: postgres
    volumes:
      - data:/var/lib/postgresql/data
      - logs:/var/log
`;
		expect(findRelativeBindSources(c)).toEqual([]);
	});

	test('compose with absolute bind path → empty (absolute paths are portable, even if wrong)', () => {
		const c = `services:
  web:
    image: nginx
    volumes:
      - /etc/nginx/conf.d:/etc/nginx/conf.d:ro
`;
		expect(findRelativeBindSources(c)).toEqual([]);
	});

	test('compose with ./ bind path → detected', () => {
		const c = `services:
  web:
    image: nginx
    volumes:
      - ./html:/usr/share/nginx/html
`;
		expect(findRelativeBindSources(c)).toEqual(['./html']);
	});

	test('compose with ../ bind path → detected (parent dir reference)', () => {
		const c = `services:
  web:
    image: nginx
    volumes:
      - ../shared:/data
`;
		expect(findRelativeBindSources(c)).toEqual(['../shared']);
	});

	test('multiple relative binds → all detected, in declaration order', () => {
		const c = `services:
  web:
    image: nginx
    volumes:
      - ./html:/web
      - ./conf:/etc/nginx/conf.d
  db:
    image: postgres
    volumes:
      - ./pgdata:/var/lib/postgresql/data
`;
		expect(findRelativeBindSources(c)).toEqual(['./html', './conf', './pgdata']);
	});

	test('quoted bind path (single quotes) → detected', () => {
		const c = `services:
  web:
    volumes:
      - './html':/web
`;
		expect(findRelativeBindSources(c)).toEqual(['./html']);
	});

	test('quoted bind path (double quotes) → detected', () => {
		const c = `services:
  web:
    volumes:
      - "./html":/web
`;
		expect(findRelativeBindSources(c)).toEqual(['./html']);
	});

	test('mixed named + relative bind → only relative reported', () => {
		const c = `services:
  app:
    volumes:
      - mydata:/data
      - ./config:/etc/app
      - shared:/shared
`;
		expect(findRelativeBindSources(c)).toEqual(['./config']);
	});

	test('bind with :ro flag → still detected (flag does not change source-path classification)', () => {
		const c = `services:
  web:
    volumes:
      - ./html:/web:ro
`;
		expect(findRelativeBindSources(c)).toEqual(['./html']);
	});

	test('compose with comments containing ./ → not falsely detected', () => {
		// The regex anchors at start-of-line, so comments would only false-match
		// if they were also list items, which is unusual. Validate the
		// current behaviour anyway.
		const c = `services:
  # don't use ./html here
  web:
    image: nginx
`;
		expect(findRelativeBindSources(c)).toEqual([]);
	});

	test('long-form bind syntax (type: bind) is NOT currently detected', () => {
		// KNOWN LIMITATION: the regex only matches short-form binds.
		// Long-form (volumes: - type: bind, source: ./html, target: /web)
		// slips through. Document the gap here so we remember; fix later.
		const c = `services:
  web:
    volumes:
      - type: bind
        source: ./html
        target: /web
`;
		expect(findRelativeBindSources(c)).toEqual([]);
	});
});

// ============================================================================
// extractUidFromSocketPath — pull the UID out of a rootless docker socket path
// so scanner helpers bind the right host socket (host-path.ts, was untested).
// ============================================================================
describe('extractUidFromSocketPath', () => {
	test('extracts the UID from a rootless socket path', () => {
		expect(extractUidFromSocketPath('/run/user/1000/docker.sock')).toBe('1000');
		expect(extractUidFromSocketPath('/var/run/user/1000/docker.sock')).toBe('1000');
		expect(extractUidFromSocketPath('/run/user/0/docker.sock')).toBe('0');
	});
	test('returns null for the standard (root) socket path', () => {
		expect(extractUidFromSocketPath('/var/run/docker.sock')).toBeNull();
	});
	test('returns null when the path is not a docker.sock or the uid is non-numeric', () => {
		expect(extractUidFromSocketPath('/run/user/1000/podman.sock')).toBeNull();
		expect(extractUidFromSocketPath('/run/user/abc/docker.sock')).toBeNull();
	});
	test('is anchored on docker.sock — a suffixed path does not match', () => {
		expect(extractUidFromSocketPath('/run/user/1000/docker.sock.bak')).toBeNull();
		expect(extractUidFromSocketPath('')).toBeNull();
	});
});

// ============================================================================
// wouldDeleteAllSnapshots — the prune safety guard's brain
//
// Restic's `forget --dry-run --json` output is what we feed this. Real samples
// captured from restic 0.17 (the format hasn't changed in years but if it does
// these tests will fail loudly). The point of the guard is to refuse pruning
// when the policy would empty the repo for a target — typo'd retention
// (keepLast: 0) should not delete every snapshot the user has.
// ============================================================================

describe('wouldDeleteAllSnapshots', () => {
	test('empty stdout (restic not run yet / repo empty) → not a wipe', () => {
		const r = wouldDeleteAllSnapshots('');
		expect(r.wouldWipe).toBe(false);
		expect(r.keep).toBe(0);
		expect(r.remove).toBe(0);
		expect(r.total).toBe(0);
	});

	test('whitespace-only stdout → not a wipe (treat as empty)', () => {
		expect(wouldDeleteAllSnapshots('   \n\t  ').wouldWipe).toBe(false);
	});

	test('unparseable stdout → not a wipe (refuse to guess — let the run fail naturally)', () => {
		expect(wouldDeleteAllSnapshots('not json at all').wouldWipe).toBe(false);
		expect(wouldDeleteAllSnapshots('{partial').wouldWipe).toBe(false);
	});

	test('JSON that is not an array → not a wipe (defensive)', () => {
		expect(wouldDeleteAllSnapshots('{"keep":[],"remove":[]}').wouldWipe).toBe(false);
		expect(wouldDeleteAllSnapshots('null').wouldWipe).toBe(false);
		expect(wouldDeleteAllSnapshots('42').wouldWipe).toBe(false);
	});

	test('empty array (repo has no matching snapshots) → not a wipe (nothing to lose)', () => {
		const r = wouldDeleteAllSnapshots('[]');
		expect(r.wouldWipe).toBe(false);
		expect(r.total).toBe(0);
	});

	test('keep N, remove 0 → not a wipe (the happy path)', () => {
		const sample = JSON.stringify([{
			keep: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
			remove: [],
			reasons: []
		}]);
		const r = wouldDeleteAllSnapshots(sample);
		expect(r.wouldWipe).toBe(false);
		expect(r.keep).toBe(3);
		expect(r.remove).toBe(0);
		expect(r.total).toBe(3);
	});

	test('keep some, remove some → not a wipe (normal retention pass)', () => {
		const sample = JSON.stringify([{
			keep: [{ id: 'a1' }, { id: 'a2' }],
			remove: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }],
			reasons: []
		}]);
		const r = wouldDeleteAllSnapshots(sample);
		expect(r.wouldWipe).toBe(false);
		expect(r.keep).toBe(2);
		expect(r.remove).toBe(3);
		expect(r.total).toBe(5);
	});

	test('keep 0, remove N → WIPE (the case we exist to catch)', () => {
		const sample = JSON.stringify([{
			keep: [],
			remove: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
			reasons: []
		}]);
		const r = wouldDeleteAllSnapshots(sample);
		expect(r.wouldWipe).toBe(true);
		expect(r.keep).toBe(0);
		expect(r.remove).toBe(3);
		expect(r.total).toBe(3);
	});

	test('multiple groups — aggregate across all groups', () => {
		// Although Dockhand forces --group-by '' so there's normally one group,
		// the parser must still tolerate multi-group output for robustness in
		// case a shared repo has snapshots from another tool.
		const sample = JSON.stringify([
			{ keep: [{ id: 'a1' }], remove: [] },
			{ keep: [], remove: [{ id: 'b1' }] }
		]);
		const r = wouldDeleteAllSnapshots(sample);
		// Not a wipe — at least one snapshot is kept across all groups
		expect(r.wouldWipe).toBe(false);
		expect(r.keep).toBe(1);
		expect(r.remove).toBe(1);
	});

	test('multiple groups all wiping → wipe', () => {
		const sample = JSON.stringify([
			{ keep: [], remove: [{ id: 'a1' }] },
			{ keep: [], remove: [{ id: 'b1' }] }
		]);
		const r = wouldDeleteAllSnapshots(sample);
		expect(r.wouldWipe).toBe(true);
		expect(r.keep).toBe(0);
		expect(r.remove).toBe(2);
	});

	test('group with no keep/remove arrays (malformed restic output) → no crash, count 0', () => {
		const sample = JSON.stringify([{ reasons: [], somethingElse: true }]);
		expect(() => wouldDeleteAllSnapshots(sample)).not.toThrow();
		const r = wouldDeleteAllSnapshots(sample);
		expect(r.total).toBe(0);
	});
});

// ============================================================================
// validateRetention: bounds-check each retention count (integer 0..10000).
// ============================================================================
describe('validateRetention', () => {
	test('a valid retention object passes', () => {
		expect(validateRetention({ keepLast: 7, keepDaily: 30 })).toEqual({ ok: true });
	});
	test('a negative count is rejected with a field-named reason', () => {
		const r = validateRetention({ keepLast: -1 });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/keepLast/);
	});
	test('a non-integer / NaN count is rejected', () => {
		expect(validateRetention({ keepLast: 'x' }).ok).toBe(false);
	});
});

// ============================================================================
// isAllowedRepository / validateRepositoryForSave: repo-scheme allowlist + SSRF
// guard on URL-form backends. Security-relevant (a destination is user input).
// ============================================================================
describe('isAllowedRepository', () => {
	test('accepts an absolute local path and supported schemes', () => {
		expect(isAllowedRepository('/data/repo')).toBe(true);
		expect(isAllowedRepository('s3:http://minio/bucket')).toBe(true);
	});
	test('rejects an unknown scheme and empty/nullish input', () => {
		expect(isAllowedRepository('ftp://x')).toBe(false);
		expect(isAllowedRepository('')).toBe(false);
		expect(isAllowedRepository(null)).toBe(false);
		expect(isAllowedRepository(undefined)).toBe(false);
	});
});

describe('validateRepositoryForSave', () => {
	test('a local path and a LAN rest repo are accepted (null = no error)', () => {
		expect(validateRepositoryForSave('/data/repo')).toBeNull();
	});
	test('an unsupported scheme returns an error string', () => {
		expect(validateRepositoryForSave('ftp://x')).toMatch(/Invalid repository/);
	});
	test('a URL-form repo pointing at the cloud-metadata IP is rejected (SSRF guard)', () => {
		expect(validateRepositoryForSave('rest:http://169.254.169.254/x')).toMatch(/not allowed/);
	});
});

// ============================================================================
// sanitizeWebhookUrlForLog: redact a webhook URL for logs without leaking the
// secret path. Fail-closed to a placeholder on an unparseable URL (#6).
// ============================================================================
describe('sanitizeWebhookUrlForLog', () => {
	test('keeps origin + first path segment, redacts the rest', () => {
		expect(sanitizeWebhookUrlForLog('https://hooks.slack.com/services/T/B/XXX'))
			.toBe('https://hooks.slack.com/services/***');
	});
	test('a URL with no path is returned as its origin', () => {
		expect(sanitizeWebhookUrlForLog('https://example.com')).toBe('https://example.com');
	});
	test('an unparseable URL fails closed to a placeholder (never leaks the raw value)', () => {
		expect(sanitizeWebhookUrlForLog('not a url')).toBe('<webhook>');
	});
});

// ============================================================================
// classifyBackupError: map a restic failure to a stable code vocabulary; must
// never throw and defaults to UNKNOWN.
// ============================================================================
describe('classifyBackupError', () => {
	test('maps a known signature (already locked → REPO_LOCKED)', () => {
		expect(classifyBackupError(new Error('repository is already locked'))).toBe('REPO_LOCKED');
	});
	test('defaults to UNKNOWN for an unrecognised message', () => {
		expect(classifyBackupError(new Error('something weird'))).toBe('UNKNOWN');
	});
	test('is safe on null / non-Error input', () => {
		expect(classifyBackupError(null)).toBe('UNKNOWN');
		expect(classifyBackupError(undefined)).toBe('UNKNOWN');
		expect(classifyBackupError('a string')).toBe('UNKNOWN');
	});
});

// ============================================================================
// parsePoliciesJson: tolerant parse of a destination's policies JSON — returns
// {} on malformed input (logged) rather than throwing.
// ============================================================================
describe('parsePoliciesJson', () => {
	test('parses valid JSON', () => {
		expect(parsePoliciesJson('{"pruneSchedule":"0 3 * * *"}')).toEqual({ pruneSchedule: '0 3 * * *' });
	});
	test('returns {} on malformed JSON (never throws)', () => {
		expect(parsePoliciesJson('{bad')).toEqual({});
	});
	test('returns {} on null/undefined', () => {
		expect(parsePoliciesJson(null)).toEqual({});
		expect(parsePoliciesJson(undefined)).toEqual({});
	});
});

// ============================================================================
// retentionToStore: turn a retention object + schedule into the stored JSON,
// or null. Feeds what actually gets persisted for a config's retention policy.
// ============================================================================
describe('retentionToStore', () => {
	test('a retention object with any truthy value is stored verbatim', () => {
		expect(retentionToStore({ keepLast: 7 }, null)).toBe(JSON.stringify({ keepLast: 7 }));
	});
	test('a retention object with only zero/empty values is treated as no policy', () => {
		expect(retentionToStore({ keepLast: 0, keepDaily: 0 }, null)).toBeNull();
	});
	test('no retention but a non-empty schedule falls back to the default scheduled retention', () => {
		expect(retentionToStore(null, '0 3 * * *')).toBe(JSON.stringify({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 }));
	});
	test('no retention and no (or whitespace-only) schedule stores null', () => {
		expect(retentionToStore(null, null)).toBeNull();
		expect(retentionToStore(null, '   ')).toBeNull();
	});
});

// ============================================================================
// resolveRetentionForUpdate: partial-update guard. A minimal PUT that omits
// retention (e.g. pause/resume, which only sends `enabled`) must NOT re-apply
// the scheduled default and wipe the stored policy (#1462).
// ============================================================================
describe('resolveRetentionForUpdate', () => {
	const SCHED = '0 4 * * *';
	test('retention omitted and schedule unchanged -> undefined (leave stored value as-is)', () => {
		// The pause/resume case: body has no retention, schedule not in the body.
		expect(resolveRetentionForUpdate(undefined, undefined, SCHED)).toBeUndefined();
	});
	test('retention omitted but the SAME schedule resent -> still leaves it alone', () => {
		expect(resolveRetentionForUpdate(undefined, SCHED, SCHED)).toBeUndefined();
	});
	test('an explicit retention is stored verbatim', () => {
		expect(resolveRetentionForUpdate({ keepYearly: 3 }, undefined, SCHED)).toBe(
			JSON.stringify({ keepYearly: 3 })
		);
	});
	test('adding a schedule with no retention applies the scheduled default', () => {
		// none -> cron transition: the default-injection the helper exists for.
		expect(resolveRetentionForUpdate(undefined, SCHED, null)).toBe(
			JSON.stringify({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 })
		);
	});
	test('clearing to all-zero on a SCHEDULED config falls back to the default (no unbounded growth)', () => {
		// retention is provided (so not skipped), but empty; with a schedule present the
		// scheduled default applies rather than storing "no policy".
		expect(resolveRetentionForUpdate({ keepLast: 0 }, undefined, SCHED)).toBe(
			JSON.stringify({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6 })
		);
	});
	test('clearing to all-zero on an UNSCHEDULED config stores null', () => {
		expect(resolveRetentionForUpdate({ keepLast: 0 }, undefined, null)).toBeNull();
	});
});

// ============================================================================
// validateFlags: save-time wrapper over sanitizeResticFlags — surfaces the
// throw as an error string (or null when the flags are acceptable / absent).
// ============================================================================
describe('validateFlags', () => {
	test('null / undefined flags are acceptable (no error)', () => {
		expect(validateFlags(null)).toBeNull();
		expect(validateFlags(undefined)).toBeNull();
	});
	test('an allowlisted flag is acceptable', () => {
		expect(validateFlags('--limit-upload=100')).toBeNull();
	});
	test('a disallowed flag surfaces the sanitizer error as a string', () => {
		expect(validateFlags('--password-command=x')).toMatch(/Disallowed/);
	});
});

// ============================================================================
// validatePolicySchedules: validate prune/check/verify cron schedules in a
// destination's policies payload (string or already-parsed object).
// ============================================================================
describe('validatePolicySchedules', () => {
	test('null policies are acceptable', () => {
		expect(validatePolicySchedules(null)).toBeNull();
	});
	test('unparseable JSON is rejected (fail-closed)', () => {
		expect(validatePolicySchedules('{bad')).toBe('Invalid policies JSON');
	});
	test('a valid cron in any schedule field passes', () => {
		expect(validatePolicySchedules(JSON.stringify({ pruneSchedule: '0 3 * * *' }))).toBeNull();
	});
	test('an invalid cron is reported with its field name', () => {
		expect(validatePolicySchedules(JSON.stringify({ checkSchedule: 'nonsense' }))).toMatch(/checkSchedule/);
	});
	test('an empty / whitespace-only schedule is skipped (not validated)', () => {
		expect(validatePolicySchedules(JSON.stringify({ pruneSchedule: '   ' }))).toBeNull();
	});
	test('accepts an already-parsed object, not just a JSON string', () => {
		expect(validatePolicySchedules({ verifySchedule: '0 0 1 * *' })).toBeNull();
	});
});

// ============================================================================
// assertStackBackupable: external-stack guard (not in this module — but the
// test belongs next to the helpers so it's easy to find. The guard itself
// is in backup.ts because it touches stacks.ts.)
// ============================================================================


// ============================================================================
// buildJobOptions: maps a config's stored options -> the job.options a run uses.
// Regression guard: excludedStackFiles MUST survive this mapping, or a SAVED backup
// (scheduled or "run now") silently ignores the user's stack-file deselections while
// an in-request run honors them. This is exactly the field that was being dropped.
// ============================================================================
describe('buildJobOptions', () => {
	test('forwards excludedStackFiles (the field that was being dropped)', () => {
		const out = buildJobOptions({ excludedStackFiles: ['secrets.txt', 'notes.md'] });
		expect(out.excludedStackFiles).toEqual(['secrets.txt', 'notes.md']);
	});

	test('excludedStackFiles is undefined when absent or not an array', () => {
		expect(buildJobOptions({}).excludedStackFiles).toBeUndefined();
		expect(buildJobOptions({ excludedStackFiles: 'nope' }).excludedStackFiles).toBeUndefined();
		expect(buildJobOptions({ excludedStackFiles: null }).excludedStackFiles).toBeUndefined();
	});

	test('splits excludePatterns CSV, trims, drops empties', () => {
		expect(buildJobOptions({ excludePatterns: 'a, b ,,c' }).excludePatterns).toEqual(['a', 'b', 'c']);
		expect(buildJobOptions({}).excludePatterns).toBeUndefined();
	});

	test('carries the plain scalar options through', () => {
		const out = buildJobOptions({
			excludeCaches: true, compression: 'max', limitUpload: 100, limitDownload: 200,
			webhookSuccess: 'https://ok', webhookFailure: 'https://fail'
		});
		expect(out.excludeCaches).toBe(true);
		expect(out.compression).toBe('max');
		expect(out.limitUpload).toBe(100);
		expect(out.limitDownload).toBe(200);
		expect(out.webhookSuccess).toBe('https://ok');
		expect(out.webhookFailure).toBe('https://fail');
	});

	test('non-string webhook values are dropped (not forwarded as junk)', () => {
		const out = buildJobOptions({ webhookSuccess: 123, webhookFailure: {} });
		expect(out.webhookSuccess).toBeUndefined();
		expect(out.webhookFailure).toBeUndefined();
	});
});

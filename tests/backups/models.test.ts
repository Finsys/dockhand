/**
 * Unit tests for backups/models.ts — pure DTO parsers, tag builders, result
 * helpers. No mocks. Covers the coverage-checklist row for models.ts, and the
 * behavioral guarantee that a garbage/partial/absent restic summary NEVER throws and
 * a missing summary yields null (so the service fails the backup).
 */
import { describe, it, expect } from 'bun:test';
import {
	parseResticLine,
	parseResticBackupSummary,
	parseResticProgress,
	parseSnapshots,
	resticOk,
	resticPartial,
	buildSnapshotTags,
	retentionTagFilter,
	instanceTagFilter,
	readEnvIdFromTags,
	readConfigIdFromTags,
	BackupError,
	TIMEOUTS,
	type ResticRun,
} from '../../src/lib/server/backups/models';

describe('parseResticLine', () => {
	it('parses a JSON object line', () => {
		expect(parseResticLine('{"a":1}')).toEqual({ a: 1 });
	});
	it('returns null for non-JSON / empty / non-object', () => {
		expect(parseResticLine('')).toBeNull();
		expect(parseResticLine('not json')).toBeNull();
		expect(parseResticLine('[1,2]')).toBeNull(); // array, not object
		expect(parseResticLine('  ')).toBeNull();
		expect(parseResticLine('12')).toBeNull();
	});
	it('never throws on garbage', () => {
		expect(() => parseResticLine('{unterminated')).not.toThrow();
	});
});

describe('parseResticBackupSummary (no summary ⇒ null, never throw)', () => {
	it('extracts the summary with all fields', () => {
		const stdout = [
			'{"message_type":"status","percent_done":0.5}',
			'{"message_type":"summary","snapshot_id":"abcd1234","files_new":3,"files_changed":1,"files_unmodified":10,"data_added":2048,"total_bytes_processed":4096,"total_files_processed":14}',
		].join('\n');
		expect(parseResticBackupSummary(stdout)).toEqual({
			snapshotId: 'abcd1234', filesNew: 3, filesChanged: 1, filesUnmodified: 10,
			dataAdded: 2048, totalBytesProcessed: 4096, totalFilesProcessed: 14,
		});
	});
	it('coerces missing numeric fields to 0 (truncated summary never throws)', () => {
		const s = parseResticBackupSummary('{"message_type":"summary","snapshot_id":"x"}');
		expect(s).toEqual({ snapshotId: 'x', filesNew: 0, filesChanged: 0, filesUnmodified: 0, dataAdded: 0, totalBytesProcessed: 0, totalFilesProcessed: 0 });
	});
	it('returns null when there is NO summary line (unknown outcome ⇒ fail)', () => {
		expect(parseResticBackupSummary('{"message_type":"status","percent_done":1}')).toBeNull();
		expect(parseResticBackupSummary('')).toBeNull();
		expect(parseResticBackupSummary('total garbage\nmore garbage')).toBeNull();
	});
	it('returns null when summary lacks a snapshot_id', () => {
		expect(parseResticBackupSummary('{"message_type":"summary","files_new":1}')).toBeNull();
		expect(parseResticBackupSummary('{"message_type":"summary","snapshot_id":""}')).toBeNull();
	});
});

describe('parseResticProgress', () => {
	it('parses a status line', () => {
		expect(parseResticProgress('{"message_type":"status","percent_done":0.42,"bytes_done":10,"total_bytes":100}'))
			.toEqual({ percentDone: 0.42, bytesDone: 10, totalBytes: 100 });
	});
	it('returns null for non-status / garbage', () => {
		expect(parseResticProgress('{"message_type":"summary"}')).toBeNull();
		expect(parseResticProgress('garbage')).toBeNull();
	});
	it('defaults numerics to 0', () => {
		expect(parseResticProgress('{"message_type":"status"}')).toEqual({ percentDone: 0, bytesDone: 0, totalBytes: 0 });
	});
});

describe('parseSnapshots', () => {
	it('parses and sorts newest-first', () => {
		const stdout = JSON.stringify([
			{ id: 'old', short_id: 'old', time: '2024-01-01T00:00:00Z', hostname: 'h', tags: ['a'], paths: ['/v'] },
			{ id: 'new', short_id: 'new', time: '2024-06-01T00:00:00Z', hostname: 'h', tags: [], paths: [] },
		]);
		const snaps = parseSnapshots(stdout);
		expect(snaps.map((s) => s.id)).toEqual(['new', 'old']);
		expect(snaps[1].tags).toEqual(['a']);
	});
	it('returns [] on garbage or non-array (unparseable ≠ populated repo)', () => {
		expect(parseSnapshots('not json')).toEqual([]);
		expect(parseSnapshots('{"not":"array"}')).toEqual([]);
		expect(parseSnapshots('')).toEqual([]);
	});
	it('skips malformed entries, keeps valid ones', () => {
		const stdout = JSON.stringify([{ notid: 1 }, { id: 'good', time: '2024-01-01' }]);
		const snaps = parseSnapshots(stdout);
		expect(snaps.map((s) => s.id)).toEqual(['good']);
		expect(snaps[0].shortId).toBe('good'.slice(0, 8));
	});
	it('filters non-string tags/paths defensively', () => {
		const stdout = JSON.stringify([{ id: 'x', tags: ['ok', 5, null], paths: ['/p', {}] }]);
		expect(parseSnapshots(stdout)[0].tags).toEqual(['ok']);
		expect(parseSnapshots(stdout)[0].paths).toEqual(['/p']);
	});
});

describe('resticOk / resticPartial (undefined exit is not ok)', () => {
	const run = (exitCode: number | undefined): ResticRun => ({ exitCode, stdout: '', stderr: '' });
	it('ok only for exit 0', () => {
		expect(resticOk(run(0))).toBe(true);
		expect(resticOk(run(1))).toBe(false);
		expect(resticOk(run(3))).toBe(false);
		expect(resticOk(run(undefined))).toBe(false); // the critical case
	});
	it('partial only for exit 3', () => {
		expect(resticPartial(run(3))).toBe(true);
		expect(resticPartial(run(0))).toBe(false);
		expect(resticPartial(run(undefined))).toBe(false);
	});
});

describe('snapshot tags — stable ids, never normalized names', () => {
	it('builds instance/configid/envid + decoration tags', () => {
		const tags = buildSnapshotTags({ instanceId: 'inst', configId: 7, environmentId: 3, targetName: 'web', type: 'container' });
		expect(tags).toContain('dockhand:instance=inst');
		expect(tags).toContain('dockhand:configid=7');
		expect(tags).toContain('dockhand:envid=3');
		expect(tags).toContain('dockhand:type=container');
		expect(tags).toContain('dockhand:name=web');
	});
	it('uses "local" for a null environment', () => {
		const tags = buildSnapshotTags({ instanceId: 'i', configId: 1, environmentId: null, targetName: 't', type: 'stack' });
		expect(tags).toContain('dockhand:envid=local');
	});
	it('retention filter ANDs instance + configid (collision-proof scope)', () => {
		expect(retentionTagFilter('inst', 7)).toBe('dockhand:instance=inst,dockhand:configid=7');
	});
	it('instance filter is instance-only', () => {
		expect(instanceTagFilter('inst')).toBe('dockhand:instance=inst');
	});
});

describe('reading ids back from tags (fail closed on missing/malformed)', () => {
	it('reads envid: local, numeric, or null', () => {
		expect(readEnvIdFromTags(['dockhand:envid=local'])).toBe('local');
		expect(readEnvIdFromTags(['dockhand:envid=5'])).toBe(5);
		expect(readEnvIdFromTags(['dockhand:envid=0'])).toBeNull(); // 0 not a valid id
		expect(readEnvIdFromTags(['dockhand:envid=abc'])).toBeNull();
		expect(readEnvIdFromTags(['other'])).toBeNull(); // absent ⇒ fail closed
		expect(readEnvIdFromTags([])).toBeNull();
	});
	it('reads configid or null', () => {
		expect(readConfigIdFromTags(['dockhand:configid=9'])).toBe(9);
		expect(readConfigIdFromTags(['dockhand:configid=x'])).toBeNull();
		expect(readConfigIdFromTags([])).toBeNull();
	});
});

describe('BackupError', () => {
	it('carries a code + optional context', () => {
		const e = new BackupError('INTEGRITY', 'snapshot unreadable', { snapshotId: 'x' });
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe('INTEGRITY');
		expect(e.message).toBe('snapshot unreadable');
		expect(e.context).toEqual({ snapshotId: 'x' });
	});
});

describe('TIMEOUTS — unbounded by default (#1382)', () => {
	it('both tiers default to 0 (no timeout) so a long backup/list is never killed', () => {
		// A fixed cap killed healthy long-running ops mid-run; a stuck op is handled by
		// manual cancel + the helper reaper instead. Operators can still opt into a cap via
		// the single RESTIC_TIMEOUT env (not set in the test env).
		expect(TIMEOUTS.interactive).toBe(0);
		expect(TIMEOUTS.data).toBe(0);
	});

	it('both tiers read the SAME env, so there is one RESTIC_TIMEOUT to set', () => {
		// Folded from two envs into one: interactive and data must stay in lockstep.
		expect(TIMEOUTS.interactive).toBe(TIMEOUTS.data);
	});
});

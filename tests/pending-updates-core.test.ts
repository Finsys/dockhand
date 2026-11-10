/**
 * Unit tests for pendingRowsToClear (#1311).
 *
 * A stack redeploy with "Pull images" recreates containers with new ids, orphaning
 * the pending_container_updates rows keyed by the OLD id — the dashboard then shows a
 * permanent false "update available". We clear a row ONLY when we can prove the
 * container now runs the newest local image; every ambiguity keeps the row so a REAL
 * pending update is never hidden (the user's core concern when --pull always doesn't
 * land the latest: per-service pull failure, build:, pull_policy:never).
 */
import { describe, test, expect } from 'bun:test';
import { pendingRowsToClear, countLivePending, countImageUpdates, isImageUpdateRow, countLivePinnedDigest, countPinnedDigest, isPinnedDigestRow, countLiveNewerVersion, countNewerVersion, isNewerVersionRow, type PendingRow, type LiveContainer } from '../src/lib/server/pending-updates-core';

const STACK = 'shop';
const LATEST = 'sha256:newnewnew';
const OLD = 'sha256:oldoldold';
// tag -> newest local id after --pull always
const latestIdForTag = (tag: string) => (tag === 'nginx:latest' ? LATEST : tag === 'unresolvable:tag' ? null : LATEST);

const row = (name: string, id: string, img = 'nginx:latest'): PendingRow => ({ containerId: id, containerName: name, currentImage: img });
const live = (name: string, imageId: string, project?: string): LiveContainer => ({ name, imageId, project });

describe('pendingRowsToClear', () => {
	test('1. CLEARS a stack container recreated on the newest image', () => {
		const out = pendingRowsToClear(
			[row('shop-web-1', 'old-id')],
			[live('shop-web-1', LATEST, STACK)],
			latestIdForTag, STACK
		);
		expect(out).toEqual(['old-id']);
	});

	test('2. KEEPS a stack container still on the OLD image (pull failed / build: / never)', () => {
		const out = pendingRowsToClear(
			[row('shop-web-1', 'old-id')],
			[live('shop-web-1', OLD, STACK)], // recreated but still old image
			latestIdForTag, STACK
		);
		expect(out).toEqual([]); // a real pending update must NOT be hidden
	});

	test('3. KEEPS when the tag cannot be resolved to a local id (fail-safe)', () => {
		const out = pendingRowsToClear(
			[row('shop-web-1', 'old-id', 'unresolvable:tag')],
			[live('shop-web-1', LATEST, STACK)],
			latestIdForTag, STACK
		);
		expect(out).toEqual([]);
	});

	test('4. CLEARS a genuine orphan (no live container carries that name)', () => {
		const out = pendingRowsToClear(
			[row('shop-gone-1', 'old-id')],
			[live('shop-web-1', LATEST, STACK)], // different name still around
			latestIdForTag, STACK
		);
		expect(out).toEqual(['old-id']);
	});

	test('5. leaves another stack\'s container untouched', () => {
		const out = pendingRowsToClear(
			[row('other-web-1', 'old-id')],
			[live('other-web-1', LATEST, 'other-stack')], // same name, different project
			latestIdForTag, STACK
		);
		expect(out).toEqual([]);
	});

	test('6. leaves a standalone (no project) container untouched', () => {
		const out = pendingRowsToClear(
			[row('lonely', 'old-id')],
			[live('lonely', LATEST, undefined)],
			latestIdForTag, STACK
		);
		expect(out).toEqual([]);
	});

	test('7a. empty pending -> []', () => {
		expect(pendingRowsToClear([], [live('shop-web-1', LATEST, STACK)], latestIdForTag, STACK)).toEqual([]);
	});

	test('7b. empty live -> every row is a true orphan, all cleared', () => {
		const out = pendingRowsToClear(
			[row('shop-web-1', 'a'), row('shop-db-1', 'b')],
			[], latestIdForTag, STACK
		);
		expect(out.sort()).toEqual(['a', 'b']);
	});

	test('7c. mixed batch: updated cleared, still-old kept, other-stack kept, orphan cleared', () => {
		const out = pendingRowsToClear(
			[
				row('shop-web-1', 'web'),   // updated -> clear
				row('shop-db-1', 'db'),     // still old -> keep
				row('other-x-1', 'other'),  // other stack -> keep
				row('shop-gone-1', 'gone')  // orphan -> clear
			],
			[
				live('shop-web-1', LATEST, STACK),
				live('shop-db-1', OLD, STACK),
				live('other-x-1', LATEST, 'other-stack')
			],
			latestIdForTag, STACK
		);
		expect(out.sort()).toEqual(['gone', 'web']);
	});

	test('7d. does not throw on malformed rows / missing fields', () => {
		const out = pendingRowsToClear(
			[{ containerId: '', containerName: 'x', currentImage: 'nginx:latest' } as PendingRow,
			 row('shop-web-1', 'ok')],
			[live('shop-web-1', LATEST, STACK)],
			latestIdForTag, STACK
		);
		expect(out).toEqual(['ok']); // blank-id row skipped, valid one cleared
	});

	test('non-array pending -> []', () => {
		// @ts-expect-error deliberate wrong type
		expect(pendingRowsToClear(null, [], latestIdForTag, STACK)).toEqual([]);
	});
});

describe('countLivePending (#1006 dashboard tile)', () => {
	const p = (id: string) => ({ containerId: id });

	test('counts only rows whose containerId is a live container', () => {
		expect(countLivePending([p('a'), p('b'), p('c')], ['a', 'c'])).toBe(2);
	});

	test('orphan rows (recreated/removed out-of-band) are not counted', () => {
		// old ids gone after a compose-CLI recreate; none map to a live id
		expect(countLivePending([p('old1'), p('old2')], ['new1', 'new2'])).toBe(0);
	});

	test('accepts a Set of live ids', () => {
		expect(countLivePending([p('a'), p('b')], new Set(['b']))).toBe(1);
	});

	test('null/empty pending -> 0', () => {
		// @ts-expect-error deliberate null
		expect(countLivePending(null, ['a'])).toBe(0);
		expect(countLivePending([], ['a'])).toBe(0);
	});

	// CONTRACT the call-site regression-guard depends on: with an EMPTY live list the
	// helper returns 0. That is correct here, which is exactly why the dashboard handler
	// must NOT feed it an empty list caused by a listContainers timeout (it would hide
	// real updates). The handler falls back to the raw count when containers.length === 0.
	test('empty live list -> 0 (guard must handle the timeout case at the call-site)', () => {
		expect(countLivePending([p('a'), p('b')], [])).toBe(0);
	});
});

describe('image-update counting ignores non-applicable rows (#1755)', () => {
	// The dashboard up-arrow tile is an IMAGE-update count. A row kept for a
	// newer-version suggestion, a cooldown, or a pinned-but-unapplied digest has
	// hasImageUpdate=false and must NOT be counted, or an environment of pinned
	// containers reads as "all out of date".
	const upd = (id: string) => ({ containerId: id, hasImageUpdate: true });
	const nonUpd = (id: string) => ({ containerId: id, hasImageUpdate: false });

	test('countLivePending counts only live rows with a real image update', () => {
		expect(countLivePending([upd('a'), nonUpd('b'), upd('c')], ['a', 'b', 'c'])).toBe(2);
	});

	test('a pinned/newer/cooldown row (hasImageUpdate=false) is not counted', () => {
		// The near miss: it IS a live row, so only the hasImageUpdate flag excludes it.
		expect(countLivePending([nonUpd('a')], ['a'])).toBe(0);
	});

	test('a row from before the flag existed (undefined) still counts', () => {
		// Back-compat: an old row with no hasImageUpdate must not be silently dropped.
		expect(countLivePending([{ containerId: 'a' }], ['a'])).toBe(1);
		expect(isImageUpdateRow({})).toBe(true);
	});

	test('countImageUpdates (seed, no live-match) also excludes non-updates', () => {
		expect(countImageUpdates([upd('a'), nonUpd('b'), nonUpd('c')])).toBe(1);
		expect(countImageUpdates([nonUpd('a')])).toBe(0);
		expect(countImageUpdates([{ hasImageUpdate: true }, {}])).toBe(2);
	});
});

describe('pinned-digest counting is separate from image updates (#1755)', () => {
	// A pinned-digest move is reported on its OWN tile - no bulk update can clear it,
	// so it must never mix into the applicable image-update count, and vice versa.
	const pinned = (id: string) => ({ containerId: id, pinnedToDigest: true });
	const upd = (id: string) => ({ containerId: id, hasImageUpdate: true, pinnedToDigest: false });
	const plain = (id: string) => ({ containerId: id });

	test('counts only rows flagged pinnedToDigest', () => {
		expect(countLivePinnedDigest([pinned('a'), upd('b'), plain('c')], ['a', 'b', 'c'])).toBe(1);
		expect(countPinnedDigest([pinned('a'), upd('b'), plain('c')])).toBe(1);
	});

	test('a near miss: an applicable image update is NOT a pinned-digest move', () => {
		expect(countLivePinnedDigest([upd('a')], ['a'])).toBe(0);
		expect(isPinnedDigestRow({ hasImageUpdate: true })).toBe(false);
	});

	test('absent flag is not pinned (back-compat, unlike hasImageUpdate)', () => {
		// pinnedToDigest defaults false, so an old row is never spuriously pinned.
		expect(isPinnedDigestRow({})).toBe(false);
		expect(countPinnedDigest([plain('a')])).toBe(0);
	});

	test('live-match drops a pinned row whose container is gone', () => {
		expect(countLivePinnedDigest([pinned('a')], [])).toBe(0);
		expect(countLivePinnedDigest([pinned('a')], ['a'])).toBe(1);
	});
});

describe('newer-version counting is separate from image updates (#1755 follow-up)', () => {
	// A newer-version-tag suggestion is advisory, never auto-applied, so it has its own
	// dashboard tile - it must not mix into the applicable image-update count.
	const newer = (id: string) => ({ containerId: id, newerVersion: { tag: 'v2.0.0', bump: 'major' } });
	const upd = (id: string) => ({ containerId: id, hasImageUpdate: true, newerVersion: null });
	const plain = (id: string) => ({ containerId: id });

	test('counts only rows carrying a newerVersion blob', () => {
		expect(countLiveNewerVersion([newer('a'), upd('b'), plain('c')], ['a', 'b', 'c'])).toBe(1);
		expect(countNewerVersion([newer('a'), upd('b'), plain('c')])).toBe(1);
	});

	test('a near miss: an applicable image update with no newerVersion is NOT counted', () => {
		expect(countLiveNewerVersion([upd('a')], ['a'])).toBe(0);
		expect(isNewerVersionRow({ hasImageUpdate: true, newerVersion: null })).toBe(false);
	});

	test('absent newerVersion is not counted', () => {
		expect(isNewerVersionRow({})).toBe(false);
		expect(countNewerVersion([plain('a')])).toBe(0);
	});

	test('live-match drops a newer-version row whose container is gone', () => {
		expect(countLiveNewerVersion([newer('a')], [])).toBe(0);
		expect(countLiveNewerVersion([newer('a')], ['a'])).toBe(1);
	});
});

import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_RETENTION,
	answerIsUsable,
	planRetention,
	stripUnstorableEscapes,
	type ScanRecord
} from '../src/lib/server/scan-retention-core';

/**
 * What a scan has to do to survive.
 *
 * Every scan carries its whole findings document, so keeping them all costs
 * gigabytes - but deleting the wrong one silently empties the dashboard for a
 * live image, which is worse. These pin both directions.
 */

const scan = (
	id: number,
	imageId: string,
	scannedAt: string,
	extra: Partial<ScanRecord> = {}
): ScanRecord => ({ id, environmentId: 1, imageId, scanner: 'grype', scannedAt, ...extra });

const NOW = new Date('2026-09-30T00:00:00Z');
const LIVE = new Set(['img-live']);
const REACHED = new Set<number | null>([1]);

describe('an image the host still has', () => {
	test('its newest scan is never deleted', () => {
		// Even a year old: it is the only record of that image's state.
		const plan = planRetention(
			[scan(1, 'img-live', '2025-01-01T00:00:00Z')], LIVE, REACHED, NOW);
		expect(plan.deleteIds).toEqual([]);
	});

	test('history beyond the keep count goes', () => {
		const scans = Array.from({ length: 15 }, (_, i) =>
			scan(i + 1, 'img-live', `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
		const plan = planRetention(scans, LIVE, REACHED, NOW, { keepPerImage: 10, graceDays: 7 });
		expect(plan.deleteIds.length).toBe(5);
		expect(plan.supersededCount).toBe(5);
		// The five oldest, not any five.
		expect(plan.deleteIds.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	});

	test('each scanner keeps its own history', () => {
		// grype and trivy scan the same image; one must not evict the other.
		const scans = [
			scan(1, 'img-live', '2026-09-01T00:00:00Z'),
			scan(2, 'img-live', '2026-09-02T00:00:00Z', { scanner: 'trivy' })
		];
		expect(planRetention(scans, LIVE, REACHED, NOW, { keepPerImage: 1, graceDays: 7 })
			.deleteIds).toEqual([]);
	});

	test('each environment keeps its own history', () => {
		const scans = [
			scan(1, 'img-live', '2026-09-01T00:00:00Z'),
			scan(2, 'img-live', '2026-09-02T00:00:00Z', { environmentId: 2 })
		];
		const reached = new Set<number | null>([1, 2]);
		expect(planRetention(scans, LIVE, reached, NOW, { keepPerImage: 1, graceDays: 7 })
			.deleteIds).toEqual([]);
	});
});

describe('an image the host no longer has', () => {
	test('everything goes once the grace period has passed', () => {
		const scans = [
			scan(1, 'img-gone', '2026-08-01T00:00:00Z'),
			scan(2, 'img-gone', '2026-08-02T00:00:00Z')
		];
		const plan = planRetention(scans, LIVE, REACHED, NOW);
		expect(plan.deleteIds.sort((a, b) => a - b)).toEqual([1, 2]);
		expect(plan.goneImageCount).toBe(2);
	});

	test('a recently scanned one is kept, because it may just be rebuilding', () => {
		// A prune before a pull, or a rebuild, makes an image briefly absent.
		const plan = planRetention(
			[scan(1, 'img-gone', '2026-09-29T00:00:00Z')], LIVE, REACHED, NOW);
		expect(plan.deleteIds).toEqual([]);
	});
});

describe('an environment that did not answer', () => {
	test('its scans are left alone rather than treated as vanished', () => {
		// A daemon that is down reports no images; deleting on that basis would
		// wipe the environment's entire scan history.
		const scans = [
			scan(1, 'img-a', '2026-01-01T00:00:00Z', { environmentId: 9 }),
			scan(2, 'img-b', '2026-01-01T00:00:00Z', { environmentId: 9 })
		];
		const plan = planRetention(scans, LIVE, REACHED, NOW);
		expect(plan.deleteIds).toEqual([]);
		expect(plan.goneImageCount).toBe(0);
	});

	test('history is still trimmed for it', () => {
		// Superseded scans are superseded whether or not the daemon answered.
		const scans = Array.from({ length: 12 }, (_, i) =>
			scan(i + 1, 'img-a', `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
				{ environmentId: 9 }));
		expect(planRetention(scans, LIVE, REACHED, NOW).supersededCount).toBe(2);
	});
});

describe('the defaults', () => {
	test('keep enough history for the scan export', () => {
		// getScansForImage returns up to ten.
		expect(DEFAULT_RETENTION.keepPerImage).toBeGreaterThanOrEqual(10);
	});

	test('a keep count below one would delete everything, so it is floored', () => {
		const scans = [scan(1, 'img-live', '2026-09-01T00:00:00Z')];
		expect(planRetention(scans, LIVE, REACHED, NOW, { keepPerImage: 0, graceDays: 7 })
			.deleteIds).toEqual([]);
	});
});

describe('ordering', () => {
	test('scans recorded at the same instant are ordered by id', () => {
		const scans = [
			scan(1, 'img-live', '2026-09-01T00:00:00Z'),
			scan(2, 'img-live', '2026-09-01T00:00:00Z')
		];
		// The higher id is the later write, so it is the one kept.
		expect(planRetention(scans, LIVE, REACHED, NOW, { keepPerImage: 1, graceDays: 7 })
			.deleteIds).toEqual([1]);
	});
});

describe('whether an environment may be deleted on', () => {
	test('a daemon that lists images is trustworthy', () => {
		expect(answerIsUsable([{ length: 1 }])).toBe(true);
	});

	test('an empty list is no evidence, so nothing is deleted on it', () => {
		// A fresh store, a prune, or a host still starting all answer with nothing;
		// acting on that would drop the environment's entire scan history.
		expect(answerIsUsable([])).toBe(false);
		expect(answerIsUsable(null)).toBe(false);
		expect(answerIsUsable(undefined)).toBe(false);
	});
});

describe('values a findings document may carry but a column cannot', () => {
	const NUL = String.fromCharCode(0);
	const HI = String.fromCharCode(0xd800);
	const LO = String.fromCharCode(0xdc00);

	test('a NUL in a description is dropped', () => {
		// It survives JSON.stringify as \\u0000, so nothing upstream rejects it, but
		// PostgreSQL will not convert it to text and fails the whole statement.
		const out = stripUnstorableEscapes(JSON.stringify([{ d: 'buf' + NUL + 'over' }]));
		expect(out).not.toContain('u0000');
		expect(JSON.parse(out)[0].d).toBe('bufover');
	});

	test('a lone surrogate is dropped, whichever half it is', () => {
		for (const half of [HI, LO]) {
			const out = stripUnstorableEscapes(JSON.stringify([{ d: half }]));
			expect(JSON.parse(out)[0].d).toBe('');
		}
	});

	test('a real character built from a surrogate pair survives', () => {
		// Dropping half of a valid pair would corrupt text the scanner meant to send.
		const out = stripUnstorableEscapes(JSON.stringify([{ d: HI + LO }]));
		expect(JSON.parse(out)[0].d).toBe(HI + LO);
	});

	test('a literal backslash before the same letters is left alone', () => {
		// A Windows path in a description reads like an escape but is not one, and
		// editing the text rather than the value cannot tell them apart.
		const input = JSON.stringify([{ d: 'C:' + String.fromCharCode(92) + 'ud800path' }]);
		const out = stripUnstorableEscapes(input);
		expect(JSON.parse(out)[0].d).toBe('C:' + String.fromCharCode(92) + 'ud800path');
	});

	test('a document that does not parse is returned untouched', () => {
		expect(stripUnstorableEscapes('not json at all')).toBe('not json at all');
	});

	test('a surrogate is dropped whatever case its escape was written in', () => {
		const out = stripUnstorableEscapes(JSON.stringify([{ d: HI }]).replace('ud800', 'uD800'));
		expect(JSON.parse(out)[0].d).toBe('');
	});

	test('an unstorable value nested deeper is still removed', () => {
		const doc = JSON.stringify([{ id: 'CVE-1', meta: { note: 'a' + NUL + 'b' } }]);
		expect(JSON.parse(stripUnstorableEscapes(doc))[0].meta.note).toBe('ab');
	});

	test('ordinary text is untouched and still parses', () => {
		const input = JSON.stringify([{ id: 'CVE-1', d: 'plain description' }]);
		expect(stripUnstorableEscapes(input)).toBe(input);
	});
});

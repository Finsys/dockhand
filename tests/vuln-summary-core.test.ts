import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	EMPTY_COUNTS,
	readSummaryRow,
	summaryDialect,
	summaryFragments,
	summarySelect
} from '../src/lib/server/vuln-summary-core';

/**
 * That the dashboard header is counted by the database.
 *
 * Counting four severities must not mean reading every scan's findings document
 * into the process, which for a long scan history is hundreds of megabytes of
 * heap. What the statement must not lose is the three rules the listing applies:
 * newest scan per image and scanner, only images the host still has, and one row
 * per image, CVE, package and version.
 */

const PG = summarySelect(true, '$1', '$2');
const LITE = summarySelect(false, '?', '?');

describe('the counting happens in SQL', () => {
	test('only counts come back, never a findings document', () => {
		for (const q of [PG, LITE]) {
			expect(q).toMatch(/count\(\*\) as total/);
			expect(q).toMatch(/count\(distinct image_id\) as images/);
			// Selecting the column itself would ship the documents back to the
			// process, which is the cost this exists to avoid.
			expect(q).not.toMatch(/select v\.vulnerabilities/);
		}
	});

	test('every severity the header shows is counted', () => {
		for (const q of [PG, LITE]) {
			for (const s of ['critical', 'high', 'medium', 'low']) expect(q).toContain('as ' + s);
		}
	});
});

describe('the rules the in-memory version applied', () => {
	test('only the newest scan per image and scanner', () => {
		for (const q of [PG, LITE]) {
			expect(q).toMatch(/partition by image_id, scanner/);
			expect(q).toMatch(/order by scanned_at desc, id desc/);
			expect(q).toMatch(/where v\.rn = 1/);
		}
	});

	test('only images the host still has', () => {
		expect(PG).toMatch(/v\.image_id in \(\$2\)/);
		expect(LITE).toMatch(/v\.image_id in \(\?\)/);
	});

	test('a key seen twice counts once, keeping the first occurrence', () => {
		// The listing keeps the first finding under a key, so a key whose severity
		// differs between scans must not count twice - a plain distinct including
		// severity would do exactly that.
		for (const q of [PG, LITE]) {
			expect(q).toMatch(/partition by v\.image_id,[\s\S]*?order by v\.scan_order/);
			expect(q).toContain('where seen = 1');
		}
	});
});

describe('the two dialects', () => {
	test('each unwraps the doubly-encoded column its own way', () => {
		// The column holds a JSON string whose content is the array, so neither
		// dialect iterates it without being told to unwrap first.
		expect(summaryDialect(true).parsed).toContain("#>> '{}'");
		expect(summaryDialect(false).parsed).toContain("json_extract(vulnerabilities, '$')");
	});

	test('neither borrows the other syntax', () => {
		expect(LITE).not.toContain('jsonb');
		expect(LITE).not.toContain('filter (where');
		expect(PG).not.toContain('json_each');
	});
});

describe('the fragments a caller binds values into', () => {
	test('rejoining them reproduces the statement', () => {
		for (const pg of [true, false]) {
			const { head, mid, tail } = summaryFragments(pg);
			expect(head + 'ENV' + mid + 'IMAGES' + tail).toBe(summarySelect(pg, 'ENV', 'IMAGES'));
		}
	});

	test('nothing after the image list is dropped', () => {
		// Two subqueries close after that point; losing the tail would leave a
		// syntactically broken statement.
		for (const pg of [true, false]) {
			expect(summaryFragments(pg).tail).toContain('seen = 1');
		}
	});
});

describe('reading the row back', () => {
	test('drivers that return strings still give numbers', () => {
		const out = readSummaryRow({ total: '5', critical: '1', high: '2', medium: '1', low: '1', images: '3' });
		expect(out).toEqual({ total: 5, critical: 1, high: 2, medium: 1, low: 1, images: 3 });
	});

	test('a missing row reads as zeroes rather than NaN', () => {
		expect(readSummaryRow(undefined)).toEqual(EMPTY_COUNTS);
		expect(readSummaryRow({})).toEqual(EMPTY_COUNTS);
	});

	test('a null count reads as zero', () => {
		// An aggregate over no rows returns null, which must not reach the header
		// as NaN.
		expect(readSummaryRow({ total: 0, critical: null }).critical).toBe(0);
	});
});

describe('the driver method each dialect needs', () => {
	test('postgres has no all(), sqlite has no execute() for rows', () => {
		// A statement that is never sent is still a broken page: drizzle exposes
		// `all` only on sqlite and `execute` only on postgres, so picking one for
		// both dialects breaks the other at runtime while every string assertion
		// here still passes.
		const pg = readFileSync(
			new URL('../node_modules/drizzle-orm/pg-core/db.d.ts', import.meta.url), 'utf8');
		const lite = readFileSync(
			new URL('../node_modules/drizzle-orm/sqlite-core/db.d.ts', import.meta.url), 'utf8');
		expect(pg).toMatch(/\n\s{4}execute</);
		expect(pg).not.toMatch(/\n\s{4}all</);
		expect(lite).toMatch(/\n\s{4}all</);
	});

	test('the caller picks the method by dialect', () => {
		const src = readFileSync(
			new URL('../src/lib/server/vuln-summary.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/isPostgres[\s\S]{0,120}\.execute\(/);
		expect(src).toMatch(/\.all\(/);
	});

	test('either result shape yields the row', () => {
		// postgres-js answers with the rows themselves, other drivers wrap them.
		const src = readFileSync(
			new URL('../src/lib/server/vuln-summary.ts', import.meta.url), 'utf8');
		expect(src).toContain('Array.isArray(result)');
		expect(src).toMatch(/\.rows/);
	});
});

describe('a scan whose document will not parse', () => {
	test('yields no findings instead of failing the whole count', () => {
		// One unreadable row must not blank the dashboard for every other image.
		for (const q of [PG, LITE]) {
			expect(q).toMatch(/case when/);
			expect(q).toMatch(/else '\[\]'/);
		}
		expect(LITE).toContain('json_valid(vulnerabilities)');
		expect(PG).toContain("jsonb_typeof(v.parsed) = 'array'");
	});

	test('a null column is skipped before it is unwrapped', () => {
		for (const q of [PG, LITE]) expect(q).toContain('vulnerabilities is not null');
	});
});

describe('how many images count as scanned', () => {
	test('the statement counts images with findings, which is not the same thing', () => {
		// An image scanned clean has no findings, so a count over findings would
		// drop it - the caller supplies the scanned count instead.
		const src = readFileSync(
			new URL('../src/lib/server/vuln-summary.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/images: liveImageIds\.length/);
	});
});

describe('repeated asks for the header', () => {
	const src = readFileSync(
		new URL('../src/lib/server/vulnerabilities.ts', import.meta.url), 'utf8');

	test('a second ask inside the window reuses the first answer', () => {
		// The metrics exporter asks on every scrape and the count endpoint on every
		// env switch, so recounting each time would undo the saving.
		expect(src).toMatch(/metaCache\.get\(envIdNum\)/);
		expect(src).toMatch(/Date\.now\(\) - cached\.at < CACHE_TTL_MS/);
	});

	test('concurrent asks share one pass', () => {
		expect(src).toMatch(/metaInflight\.get\(envIdNum\)/);
		expect(src).toMatch(/metaInflight\.set\(envIdNum/);
	});

	test('the cache is bounded and dropped when scans change', () => {
		expect(src).toMatch(/metaCache\.size > MAX_ENVS/);
		const cacheSrc = readFileSync(
			new URL('../src/lib/server/vulnerabilities-cache.ts', import.meta.url), 'utf8');
		expect(cacheSrc).toMatch(/metaCache\.(clear|delete)/);
	});
});

describe('when the count cannot be produced', () => {
	test('the page still renders instead of failing', () => {
		// The header is a summary of the data, not the data: a database error there
		// must not take the grid down with it.
		const src = readFileSync(
			new URL('../src/lib/server/vulnerabilities.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/countFindings\([^)]*\)\.catch/);
		expect(src).toMatch(/listScannedImageNames\([^)]*\)\.catch/);
	});
});

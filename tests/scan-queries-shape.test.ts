import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * That the newest-scan query lets the database do the discarding.
 *
 * Every scan row stores its whole findings document, so an image scanned nightly
 * for a month holds thirty of them and only one is ever shown. Choosing in
 * JavaScript means reading all thirty first, which is how a host with a long scan
 * history turned one page open into gigabytes of heap.
 *
 * The query reaches the database through better-sqlite3, which bun cannot load, so
 * the source is the available instrument - the behaviour itself is covered by
 * integration against a real instance.
 */

const src = readFileSync(new URL('../src/lib/server/scan-queries.ts', import.meta.url), 'utf8');

describe('the database decides which scan survives', () => {
	test('ranking happens in SQL, not in a Map over every row', () => {
		expect(src).toContain('row_number() over (');
		expect(src).toMatch(/partition by .*imageId.*,.*scanner/s);
		// The shape that made this expensive: fetch everything, keep the first seen.
		expect(src).not.toContain('latestMap');
		expect(src).not.toMatch(/new Map<string/);
	});

	test('the findings documents are read only for the rows that survive', () => {
		// The blob-carrying select is joined to the ranking and filtered by it.
		expect(src).toMatch(/innerJoin\(\s*ranked/);
		expect(src).toMatch(/where\(eq\(ranked\.rn, 1\)\)/);
	});

	test('a tie on scanned_at is broken deterministically', () => {
		// Two scans recorded in the same second must not pick a different winner
		// from one request to the next.
		expect(src).toMatch(/order by .*scannedAt.* desc, .*id.* desc/s);
	});

	test('the surviving ids are never bound as query parameters', () => {
		// One parameter per id would cap the result at the driver's variable limit
		// (32766 on SQLite) and turn a long scan history into a query error, so the
		// ranking and the filter have to stay inside a single statement.
		expect(src).not.toContain('inArray');
		expect(src).not.toMatch(/latestIds/);
	});
});

describe('both database dialects', () => {
	test('nothing dialect-specific is used', () => {
		// DISTINCT ON would be shorter and PostgreSQL-only; SQLite has had window
		// functions since 3.25 and the repo ships 3.47.
		expect(src).not.toMatch(/distinct on/i);
		expect(src).not.toMatch(/isPostgres|isSqlite/);
	});
});

describe('the three environment selectors', () => {
	test('undefined reads every environment, null the local one', () => {
		// `null` is a real environment (the local daemon), not "no filter" - an
		// isNull that became an eq would silently read nothing.
		expect(src).toMatch(/environmentId === undefined\s*\?\s*undefined/);
		expect(src).toMatch(/isNull\(vulnerabilityScans\.environmentId\)/);
		expect(src).toMatch(/eq\(vulnerabilityScans\.environmentId, environmentId\)/);
	});
});

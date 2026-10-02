/**
 * Settings written with setSetting are JSON; a reader that takes the column raw
 * hands back a quoted string. A quoted cron is not a cron - croner rejects it and
 * the schedule never registers.
 *
 * db.ts cannot be imported here (better-sqlite3 does not load under bun), so this
 * pins the encode/decode pair the accessors rely on.
 */
import { describe, test, expect } from 'bun:test';

/** What setSetting stores. */
const write = (v: unknown) => JSON.stringify(v);
/** What getSetting returns: parsed, or the raw text if it was never JSON. */
const read = (stored: string | undefined) => {
	if (stored === undefined) return null;
	try {
		return JSON.parse(stored);
	} catch {
		return stored;
	}
};

describe('settings round-trip', () => {
	test('a cron survives and carries no quotes', () => {
		const stored = write('0 3 * * 1');
		expect(stored).toBe('"0 3 * * 1"');
		expect(read(stored)).toBe('0 3 * * 1');
		expect(String(read(stored))).not.toContain('"');
	});

	test('reading the column raw is what produced the quoted cron', () => {
		// The shape of the defect: the stored text is not the value.
		const stored = write('30 4 * * *');
		expect(stored).not.toBe('30 4 * * *');
	});

	test('a boolean survives as a boolean', () => {
		expect(read(write(true))).toBe(true);
		expect(read(write(false))).toBe(false);
	});

	test('a number survives and parses', () => {
		expect(parseInt(String(read(write(25))), 10)).toBe(25);
		expect(Number.isNaN(parseInt(String(read(write(25))), 10))).toBe(false);
	});

	test('a value written by an older version - raw text, no JSON - still reads', () => {
		// getSetting falls back to the raw column when JSON.parse throws, so an
		// upgrade does not need a migration.
		expect(read('30 4 * * *')).toBe('30 4 * * *');
		expect(read('true')).toBe(true);
	});

	test('an absent row is null, which is what the defaults key off', () => {
		expect(read(undefined)).toBe(null);
	});
});

/**
 * The accessors themselves cannot be imported (db.ts pulls in better-sqlite3), so
 * assert on the source: every scan-retention reader must go through getSetting,
 * and the enabled flag must default to on.
 */
describe('scan-retention accessors (source-level)', () => {
	const src = Bun.file('src/lib/server/db.ts');

	test('no retention reader touches the settings column directly', async () => {
		const text = await src.text();
		const block = text.slice(
			text.indexOf('export async function getScanRetentionCron'),
			text.indexOf('export async function setScanRetentionGraceDays')
		);
		expect(block.length).toBeGreaterThan(0);
		// A direct db.select here is the defect: it returns the JSON text, quotes included.
		expect(block).not.toContain('db.select()');
		for (const fn of ['getScanRetentionCron', 'getScanRetentionEnabled']) {
			const body = block.slice(block.indexOf(`export async function ${fn}`));
			expect(body.slice(0, body.indexOf('\n}'))).toContain('getSetting');
		}
	});

	test('retention is on when nothing was ever saved', async () => {
		const text = await src.text();
		const body = text.slice(
			text.indexOf('export async function getScanRetentionEnabled'),
			text.indexOf('export async function setScanRetentionEnabled')
		);
		expect(body).toContain('if (value === null) return true;');
	});
});

/**
 * S01 test-only exit (T4).
 *
 * Proves the 0016_add_stack_versioning migration and the stack_sources version
 * pointers hold up without any user-visible behavior yet:
 *
 *   (a) Fresh SQLite — open a bun:sqlite in-memory DB (the app runtime path uses
 *       better-sqlite3 which bun test cannot load), apply the raw drizzle/00NN_*.sql
 *       files in order, assert 0016 applies cleanly and stack_sources gained
 *       last_saved_at / last_deployed_at, then round-trip those pointers on a bare
 *       internal stack (environment_id = NULL) through the T3 helper's emitted SQL.
 *   (b) drizzle-pg lockstep parity (CI-runnable, no live PG) — assert the PG 0016
 *       migration exists, both journals advanced together to a 0016 entry, and the
 *       PG ALTER targets the same stack_sources columns as the SQLite one. This
 *       catches the D004 missed-journal-entry silent failure.
 *
 * Part (c) of the S01 exit (definitive fresh-Postgres live-apply) is operational and
 * is exercised by scripts/emergency/fresh-postgres-migrate-check.sh (docker), not
 * here, because live Postgres is not runnable under bun test.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildRead,
	buildUpdate,
	buildInsert,
	type StackSourcePointerValues
} from '../src/lib/server/stack-source-pointers';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sqliteMigrationsDir = join(repoRoot, 'drizzle');
const pgMigrationsDir = join(repoRoot, 'drizzle-pg');

/**
 * Apply every drizzle/00NN_*.sql file in order against a fresh bun:sqlite DB.
 * This mirrors what the app's SQLite migrate path produces on a fresh DB, but
 * uses the raw migration SQL (the app's migrate() uses better-sqlite3, which is
 * not loadable under bun test).
 */
function applySqliteMigrations(db: Database): string[] {
	const files = readdirSync(sqliteMigrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	expect(files.length).toBeGreaterThan(0);
	for (const file of files) {
		const content = readFileSync(join(sqliteMigrationsDir, file), 'utf-8');
		for (const statement of content.split('--> statement-breakpoint')) {
			const trimmed = statement.trim();
			if (trimmed) db.exec(trimmed);
		}
	}
	return files;
}

function stackSourceColumns(db: Database): { name: string; notnull: number }[] {
	return db.prepare('PRAGMA table_info(stack_sources)').all() as { name: string; notnull: number }[];
}

/** Run the T3 helper's read SQL verbatim against bun:sqlite (env = null-safe). */
function readPointer(db: Database, name: string, env: number | null): { last_saved_at: string | null; last_deployed_at: string | null } | null {
	const { sql, params } = buildRead(name, env);
	const row = db.prepare(sql).get(...(params as any[])) as
		| { last_saved_at: string | null; last_deployed_at: string | null }
		| undefined;
	return row ?? null;
}

function updatePointer(db: Database, name: string, env: number | null, updates: StackSourcePointerValues, now: string): number {
	const { sql, params } = buildUpdate(name, env, updates, now);
	return db.prepare(sql).run(...(params as any[])).changes;
}

function insertPointer(db: Database, name: string, env: number | null, updates: StackSourcePointerValues, now: string): number {
	const { sql, params } = buildInsert(name, env, updates, now);
	return db.prepare(sql).run(...(params as any[])).changes;
}

describe('S01 test-only exit (T4)', () => {
	describe('(a) fresh SQLite apply + pointer round-trip', () => {
		let db: Database;
		let appliedFiles: string[];

		beforeAll(() => {
			db = new Database(':memory:');
			appliedFiles = applySqliteMigrations(db);
		});

		test('migration set includes 0016_add_stack_versioning', () => {
			expect(appliedFiles).toContain('0016_add_stack_versioning.sql');
		});

		test('0016 applied cleanly: stack_sources gained last_saved_at / last_deployed_at', () => {
			const cols = stackSourceColumns(db).map((c) => c.name);
			expect(cols).toContain('last_saved_at');
			expect(cols).toContain('last_deployed_at');
		});

		test('pointer columns are nullable (NOT NULL = 0, no default) — NULL = never saved/deployed', () => {
			const rows = stackSourceColumns(db);
			for (const col of ['last_saved_at', 'last_deployed_at']) {
				const info = rows.find((r) => r.name === col);
				expect(info).toBeDefined();
				expect(info!.notnull).toBe(0);
			}
		});

		test('bare internal stack (environment_id = NULL) pointer round-trip', () => {
			const name = 'bare-internal-stack';
			const now = '2026-09-02T00:00:00.000Z';

			// No keyed row yet -> read returns null.
			expect(readPointer(db, name, null)).toBeNull();

			// Mirror upsertStackSourcePointer: UPDATE first (no-op when the row is
			// missing), then INSERT to create the bare row.
			const updated = updatePointer(db, name, null, { lastSavedAt: 'SAVED-1', lastDeployedAt: 'DEPLOYED-1' }, now);
			expect(updated).toBe(0); // nothing to update yet
			const inserted = insertPointer(db, name, null, { lastSavedAt: 'SAVED-1', lastDeployedAt: 'DEPLOYED-1' }, now);
			expect(inserted).toBe(1); // created

			// Read back the round-tripped pointers.
			const after = readPointer(db, name, null);
			expect(after).not.toBeNull();
			expect(after!.last_saved_at).toBe('SAVED-1');
			expect(after!.last_deployed_at).toBe('DEPLOYED-1');

			// Idempotency: re-running the INSERT must NOT create a duplicate
			// (name, NULL) row (the key predicate uses environment_id IS NULL).
			const reinserted = insertPointer(db, name, null, { lastSavedAt: 'SAVED-1', lastDeployedAt: 'DEPLOYED-1' }, now);
			expect(reinserted).toBe(0);
			const count = db.prepare('SELECT count(*) AS n FROM stack_sources WHERE stack_name = ? AND environment_id IS NULL').get(name) as { n: number };
			expect(count.n).toBe(1);

			// Now advance only last_deployed_at on the existing row (COALESCE
			// preserves the untouched last_saved_at).
			const advanced = updatePointer(db, name, null, { lastDeployedAt: 'DEPLOYED-2' }, '2026-09-02T01:00:00.000Z');
			expect(advanced).toBe(1);
			const final = readPointer(db, name, null);
			expect(final!.last_saved_at).toBe('SAVED-1');
			expect(final!.last_deployed_at).toBe('DEPLOYED-2');
		});

		test('a keyed stack (environment_id set) is isolated from the bare stack', () => {
			const name = 'keyed-stack';
			const now = '2026-09-02T00:00:00.000Z';
			insertPointer(db, name, 7, { lastSavedAt: 'SAVED-K' }, now);
			const keyed = readPointer(db, name, 7);
			expect(keyed!.last_saved_at).toBe('SAVED-K');
			// The same stack_name with env NULL has no row -> isolated.
			expect(readPointer(db, name, null)).toBeNull();
		});
	});

	describe('(b) drizzle-pg lockstep parity (CI-runnable, no live PG)', () => {
		test('drizzle-pg/0016_add_stack_versioning.sql exists', () => {
			expect(existsSync(join(pgMigrationsDir, '0016_add_stack_versioning.sql'))).toBe(true);
		});

		test('both journals advanced together to an idx-16 0016_add_stack_versioning entry (lockstep)', () => {
			const sqliteJournal = JSON.parse(readFileSync(join(sqliteMigrationsDir, 'meta', '_journal.json'), 'utf-8'));
			const pgJournal = JSON.parse(readFileSync(join(pgMigrationsDir, 'meta', '_journal.json'), 'utf-8'));
			const sqliteEntry = sqliteJournal.entries.find((e: { tag: string }) => e.tag === '0016_add_stack_versioning');
			const pgEntry = pgJournal.entries.find((e: { tag: string }) => e.tag === '0016_add_stack_versioning');
			expect(sqliteEntry).toBeDefined();
			expect(pgEntry).toBeDefined();
			expect(pgEntry.idx).toBe(16);
			// Lockstep: both dialects advanced to the same index.
			expect(pgEntry.idx).toBe(sqliteEntry.idx);
		});

		test('PG 0016 ALTER targets the same stack_sources columns as SQLite 0016', () => {
			const sqliteSql = readFileSync(join(sqliteMigrationsDir, '0016_add_stack_versioning.sql'), 'utf-8');
			const pgSql = readFileSync(join(pgMigrationsDir, '0016_add_stack_versioning.sql'), 'utf-8');

			const extractAddedColumns = (sqlText: string): string[] => {
				const cols: string[] = [];
				for (const raw of sqlText.split('--> statement-breakpoint')) {
					const stmt = raw.trim();
					// Each statement is a single "ALTER TABLE ... ADD [COLUMN] <col> ...".
					const m = stmt.match(/ADD\s+(?:COLUMN\s+)?['"`]?([a-zA-Z_][a-zA-Z0-9_]*)['"`]?/);
					if (m) cols.push(m[1]);
				}
				return [...new Set(cols)].sort();
			};

			const sqliteCols = extractAddedColumns(sqliteSql);
			const pgCols = extractAddedColumns(pgSql);
			expect(sqliteCols).toEqual(['last_deployed_at', 'last_saved_at']);
			expect(pgCols).toEqual(sqliteCols);
			// Both dialects target the same table.
			expect(sqliteSql).toContain('stack_sources');
			expect(pgSql).toContain('stack_sources');
		});
	});
});

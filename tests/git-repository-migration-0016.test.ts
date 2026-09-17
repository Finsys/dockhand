import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const SQLITE_MIGRATION = resolve(
	new URL('../drizzle/0016_compose_paths.sql', import.meta.url).pathname
);
const PG_MIGRATION = resolve(
	new URL('../drizzle-pg/0016_compose_paths.sql', import.meta.url).pathname
);

const COLUMNS_REQUIRED_BY_MIGRATION = `
CREATE TABLE git_stacks (
	id INTEGER PRIMARY KEY,
	stack_name TEXT,
	compose_path TEXT
);
CREATE TABLE stack_sources (
	id INTEGER PRIMARY KEY
);
`;

function runMigration() {
	const db = new Database(':memory:');
	db.exec(COLUMNS_REQUIRED_BY_MIGRATION);
	const sql = readFileSync(SQLITE_MIGRATION, 'utf8');
	for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
		db.exec(statement);
	}
	const stackColumns = (db.prepare("PRAGMA table_info('git_stacks')").all() as Array<{ name: string }>).map((c) => c.name);
	const sourceColumns = (db.prepare("PRAGMA table_info('stack_sources')").all() as Array<{ name: string }>).map((c) => c.name);
	return { stackColumns, sourceColumns };
}

describe('migration 0016 (compose_paths)', () => {
	it('is additive: adds compose_paths to git_stacks', () => {
		const { stackColumns } = runMigration();
		assert.ok(stackColumns.includes('compose_paths'), 'expected git_stacks to gain compose_paths');
	});

	it('is additive: adds compose_paths to stack_sources', () => {
		const { sourceColumns } = runMigration();
		assert.ok(sourceColumns.includes('compose_paths'), 'expected stack_sources to gain compose_paths');
	});
});

describe('migration 0016 file guards', () => {
	for (const [name, path] of [
		['sqlite', SQLITE_MIGRATION],
		['postgres', PG_MIGRATION]
	] as const) {
		it(`(${name}) is additive and does not drop columns`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.ok(!/DROP COLUMN/.test(sql), 'migration must stay additive');
			assert.ok(!/UPDATE\s+["`]?git_/.test(sql), '0016 must not mutate git data');
		});
	}
});

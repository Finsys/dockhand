import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const SQLITE_MIGRATION = resolve(
	new URL('../drizzle/0012_centralized_git.sql', import.meta.url).pathname
);
const PG_MIGRATION = resolve(
	new URL('../drizzle-pg/0012_centralized_git.sql', import.meta.url).pathname
);

const COLUMNS_REQUIRED_BY_MIGRATION = `
CREATE TABLE git_repositories (
	id INTEGER PRIMARY KEY,
	name TEXT,
	auto_update INTEGER DEFAULT 0,
	auto_update_schedule TEXT,
	auto_update_cron TEXT,
	webhook_enabled INTEGER DEFAULT 0,
	webhook_secret TEXT
);
CREATE TABLE git_stacks (
	id INTEGER PRIMARY KEY,
	repository_id INTEGER,
	stack_name TEXT,
	auto_update INTEGER DEFAULT 0,
	auto_update_schedule TEXT,
	auto_update_cron TEXT,
	webhook_enabled INTEGER DEFAULT 0,
	webhook_secret TEXT,
	force_redeploy INTEGER DEFAULT 0
);
CREATE TABLE stack_sources (
	id INTEGER PRIMARY KEY
);
CREATE TABLE environments (
	id INTEGER PRIMARY KEY
);
`;

function runMigration(): { stackColumns: string[]; sourceColumns: string[] } {
	const db = new Database(':memory:');
	db.exec(COLUMNS_REQUIRED_BY_MIGRATION);

	const sql = readFileSync(SQLITE_MIGRATION, 'utf8');
	for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
		db.exec(statement);
	}

	const stackColumns = (db.prepare("PRAGMA table_info('git_stacks')").all() as Array<{ name: string }>)
		.map((c) => c.name);
	const sourceColumns = (db.prepare("PRAGMA table_info('stack_sources')").all() as Array<{ name: string }>)
		.map((c) => c.name);

	return { stackColumns, sourceColumns };
}

describe('migration 0012 (apply_commit_changes)', () => {
	it('is additive: adds compose_paths to git_stacks', () => {
		const { stackColumns } = runMigration();
		assert.ok(stackColumns.includes('compose_paths'), 'expected git_stacks to gain compose_paths');
	});

	it('is additive: adds compose_paths to stack_sources', () => {
		const { sourceColumns } = runMigration();
		assert.ok(sourceColumns.includes('compose_paths'), 'expected stack_sources to gain compose_paths');
	});

	it('keeps the stack-level auto_update / webhook / force_redeploy columns for downgrade compatibility', () => {
		const { stackColumns } = runMigration();
		for (const column of ['auto_update', 'auto_update_schedule', 'auto_update_cron', 'webhook_enabled', 'webhook_secret', 'force_redeploy']) {
			assert.ok(stackColumns.includes(column), `expected git_stacks to keep column "${column}"`);
		}
	});

	it('adds engine as NOT NULL default stack — existing rows backfill to the default', () => {
		const db = new Database(':memory:');
		db.exec(COLUMNS_REQUIRED_BY_MIGRATION);
		db.exec("INSERT INTO git_stacks (stack_name, repository_id) VALUES ('legacy', 1)");
		const sql = readFileSync(SQLITE_MIGRATION, 'utf8');
		for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
			db.exec(statement);
		}
		const columns = (db.prepare("PRAGMA table_info('git_stacks')").all() as Array<{ name: string }>)
			.map((c) => c.name);
		assert.ok(columns.includes('engine'), 'expected git_stacks to gain engine');
		const row = db.prepare('SELECT engine FROM git_stacks WHERE stack_name = ?').get('legacy') as { engine: string };
		assert.equal(row.engine, 'stack', 'existing rows must backfill to the column default');
	});

	it('creates the git_migration_state job table with state default idle', () => {
		const db = new Database(':memory:');
		db.exec(COLUMNS_REQUIRED_BY_MIGRATION);
		const sql = readFileSync(SQLITE_MIGRATION, 'utf8');
		for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
			db.exec(statement);
		}
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
			.map((t) => t.name);
		assert.ok(tables.includes('git_migration_state'), 'expected git_migration_state table to be created');
		const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='git_migration_state'").get() as { sql: string }).sql;
		assert.match(ddl, /`?state`?\s+TEXT\s+DEFAULT\s+'idle'\s+NOT\s+NULL/i, 'state must default to idle so the narrow lock never wedges');
	});
});

describe('migration 0012 file guards', () => {
	for (const [name, path] of [
		['sqlite', SQLITE_MIGRATION],
		['postgres', PG_MIGRATION]
	] as const) {
		it(`(${name}) never drops the stack-level auto_update columns`, () => {
			const sql = readFileSync(path, 'utf8');
			assert.ok(
				!/DROP COLUMN\s+"?auto_update/.test(sql),
				'migration must stay additive (no DROP COLUMN on auto_update)'
			);
		});

		it(`(${name}) does not promote data — the stack→repo promotion moved to the runtime backfill`, () => {
			// The original 0011 promoted stack schedules/webhooks to the repository and
			// backfilled force_redeploy. Those are now handled by git-backfill.ts inside
			// the mode-transition job, so the migration must be purely additive.
			const sql = readFileSync(path, 'utf8');
			assert.ok(
				!/UPDATE\s+["`]?git_repositories/.test(sql),
				'0012 must not mutate git_repositories data (moved to runtime backfill)'
			);
			assert.ok(
				!/force_redeploy\s*=\s*1/.test(sql),
				'0012 must not backfill force_redeploy (moved to runtime backfill)'
			);
		});

		it(`(${name}) does not backfill engine in SQL — that is a runtime step`, () => {
			// setSetting() stores JSON-stringified values ("centralized" with quotes),
			// so a SQL UPDATE from settings.value would write invalid model strings.
			// The backfill lives in drizzle.ts (backfillGitStackModel) via getSetting().
			const sql = readFileSync(path, 'utf8');
			assert.ok(
				!/UPDATE\s+["`]?git_stacks/.test(sql),
				'0012 must not mutate git_stacks.engine in SQL (backfill is runtime)'
			);
			assert.ok(
				!/SELECT.*settings/.test(sql),
				'0012 must not read the settings table in SQL'
			);
		});
	}
});

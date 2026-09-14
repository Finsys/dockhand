/**
 * Version-pointer access helpers for the `stack_sources` table.
 *
 * `stack_sources.last_saved_at` / `last_deployed_at` are nullable ISO-8601
 * timestamps (NULL = never saved / never deployed, added by the
 * 0016_add_stack_versioning migration). These helpers let the S02 version core
 * read and advance those pointers without duplicating the dual-DB access logic
 * that lives in `db.ts` / `stacks.ts`.
 *
 * A pointer is keyed by (stack_name, environment_id). Bare internal stacks
 * (local stacks, no environment) have environment_id = NULL, so the key match
 * must explicitly use `environment_id IS NULL` for them. We do NOT rely on the
 * `stackSourceEnvUnique` (stack_name, environment_id) constraint, because
 * `NULL != NULL` in unique constraints — an ON CONFLICT on that constraint can
 * never dedupe a (name, NULL) row. The key is therefore matched with an
 * explicit `environment_id IS NULL` predicate.
 *
 * ## Portability contract
 * The emitted SQL uses portable `?` placeholders and standard SQL only, so the
 * EXACT same statement text runs verbatim on SQLite (better-sqlite3 at runtime,
 * and bun:sqlite in the unit test) and, after `?` -> `$1, $2, ...` mapping, on
 * Postgres (postgres-js). The `buildRead` / `buildUpdate` / `buildInsert`
 * helpers return `{ sql, params }` so a bun test can mirror the app's SQL and
 * parameter order one-for-one against an in-memory bun:sqlite database.
 *
 * ## Side-effect-free top level (test importability)
 * The SQL constants and param builders above are pure — no imports at the top
 * level of this module. Only the high-level `readStackSourcePointer` /
 * `upsertStackSourcePointer` functions import `./db/drizzle.js`, and they do so
 * lazily INSIDE the function body. `db/drizzle.ts` performs `await seedDatabase()`
 * at module load (which opens better-sqlite3 — unsupported in Bun), so keeping
 * that import out of the top level means a bun test can import the SQL +
 * builders from this module WITHOUT triggering the better-sqlite3 load, and run
 * them against bun:sqlite directly.
 */

/** Pointer values a write may set. `undefined`/`null` for a field = leave it
 *  unchanged (COALESCE preserves the stored value). */
export interface StackSourcePointerValues {
	lastSavedAt?: string | null;
	lastDeployedAt?: string | null;
}

/** A read pointer row (or `null` when no keyed row exists). */
export interface StackSourcePointers {
	lastSavedAt: string | null;
	lastDeployedAt: string | null;
}

/**
 * Portable key predicate for (stack_name, environment_id).
 *
 * - environment_id is a specific value -> `environment_id = ?`
 * - environment_id is NULL (bare internal stack) -> `environment_id IS NULL`
 *
 * The same `?` parameter is bound three times: once for the `IS NOT NULL`
 * test, once as the `=` value, once for the `IS NULL` test.
 */
const ENV_KEY = `((? IS NOT NULL AND environment_id = ?) OR (? IS NULL AND environment_id IS NULL))`;

/** Read the (stack_name, environment_id) pointer row. */
export const READ_SQL = `
	SELECT last_saved_at, last_deployed_at
	FROM stack_sources
	WHERE stack_name = ? AND ${ENV_KEY}
`;

/**
 * Advance the pointers on an existing keyed row. COALESCE keeps any pointer this
 * call did not provide. No-op (0 rows) when the keyed row does not exist yet.
 */
export const UPDATE_SQL = `
	UPDATE stack_sources
	SET last_saved_at = COALESCE(?, last_saved_at),
		last_deployed_at = COALESCE(?, last_deployed_at),
		updated_at = ?
	WHERE stack_name = ? AND ${ENV_KEY}
`;

/**
 * Create the keyed row when it does not exist (bare internal stack). The
 * NOT EXISTS guard keeps this idempotent and prevents a duplicate
 * (name, NULL) row even under a race. source_type defaults to 'internal';
 * created_at / updated_at are set to `now` (ISO-8601, matching the app-wide
 * timestamp convention rather than the schema's CURRENT_TIMESTAMP default).
 */
export const INSERT_SQL = `
	INSERT INTO stack_sources (
		stack_name, environment_id, source_type,
		last_saved_at, last_deployed_at, created_at, updated_at
	)
	SELECT ?, ?, ?, ?, ?, ?, ?
	WHERE NOT EXISTS (
		SELECT 1 FROM stack_sources
		WHERE stack_name = ? AND ${ENV_KEY}
	)
`;

/** Read params: [stackName, envId, envId, envId]. */
export function buildRead(
	stackName: string,
	environmentId: number | null
): { sql: string; params: unknown[] } {
	return {
		sql: READ_SQL,
		params: [stackName, environmentId, environmentId, environmentId]
	};
}

/** Update params: [lastSavedAt, lastDeployedAt, now, stackName, envId, envId, envId]. */
export function buildUpdate(
	stackName: string,
	environmentId: number | null,
	updates: StackSourcePointerValues,
	now: string
): { sql: string; params: unknown[] } {
	return {
		sql: UPDATE_SQL,
		params: [
			updates.lastSavedAt ?? null,
			updates.lastDeployedAt ?? null,
			now,
			stackName,
			environmentId,
			environmentId,
			environmentId
		]
	};
}

/**
 * Insert params:
 * [stackName, envId, 'internal', lastSavedAt, lastDeployedAt, now, now,
 *  stackName, envId, envId, envId]
 */
export function buildInsert(
	stackName: string,
	environmentId: number | null,
	updates: StackSourcePointerValues,
	now: string
): { sql: string; params: unknown[] } {
	return {
		sql: INSERT_SQL,
		params: [
			stackName,
			environmentId,
			'internal',
			updates.lastSavedAt ?? null,
			updates.lastDeployedAt ?? null,
			now,
			now,
			stackName,
			environmentId,
			environmentId,
			environmentId
		]
	};
}

/** Map portable `?` placeholders to Postgres `$1, $2, ...` in left-to-right order. */
function toPostgresPlaceholders(sqlText: string): string {
	let n = 0;
	return sqlText.replace(/\?/g, () => `$${++n}`);
}

/**
 * Execute a write statement (UPDATE/INSERT) on the given raw client. The
 * portable `?` SQL runs verbatim on better-sqlite3; for postgres-js the `?`
 * placeholders are mapped to `$1, $2, ...`.
 */
async function executeRaw(client: unknown, isPostgres: boolean, sqlText: string, params: unknown[]): Promise<void> {
	if (isPostgres) {
		await (client as any).unsafe(toPostgresPlaceholders(sqlText), params);
		return;
	}
	(client as any).prepare(sqlText).run(...params);
}

/** Run a SELECT on the given raw client and return the rows. */
async function selectRaw(client: unknown, isPostgres: boolean, sqlText: string, params: unknown[]): Promise<Record<string, unknown>[]> {
	if (isPostgres) {
		const rows = await (client as any).unsafe(toPostgresPlaceholders(sqlText), params);
		return rows as Record<string, unknown>[];
	}
	return (client as any).prepare(sqlText).all(...params) as Record<string, unknown>[];
}

/**
 * Read the (stackName, environmentId) version-pointer row.
 * Returns `null` when no keyed row exists yet.
 */
export async function readStackSourcePointer(
	stackName: string,
	environmentId: number | null
): Promise<StackSourcePointers | null> {
	const { rawClient, isPostgres } = await import('./db/drizzle.js');
	const { sql, params } = buildRead(stackName, environmentId);
	const rows = await selectRaw(rawClient, isPostgres, sql, params);
	const row = rows[0];
	if (!row) return null;
	return {
		lastSavedAt: row.last_saved_at == null ? null : String(row.last_saved_at),
		lastDeployedAt: row.last_deployed_at == null ? null : String(row.last_deployed_at)
	};
}

/**
 * Upsert the (stackName, environmentId) version pointers.
 *
 * Advances `last_saved_at` and/or `last_deployed_at` (a null/undefined value
 * leaves that pointer untouched) and stamps `updated_at`. Creates a bare
 * `source_type = 'internal'` row when none exists yet, so a bare internal stack
 * with environment_id = NULL is handled without relying on the unique
 * constraint.
 */
export async function upsertStackSourcePointer(
	stackName: string,
	environmentId: number | null,
	updates: StackSourcePointerValues
): Promise<void> {
	const { rawClient, isPostgres } = await import('./db/drizzle.js');
	const now = new Date().toISOString();
	// Advance the pointers if the keyed row already exists; no-op if missing.
	const update = buildUpdate(stackName, environmentId, updates, now);
	await executeRaw(rawClient, isPostgres, update.sql, update.params);
	// Create the keyed row if it was still missing (idempotent).
	const insert = buildInsert(stackName, environmentId, updates, now);
	await executeRaw(rawClient, isPostgres, insert.sql, insert.params);
}

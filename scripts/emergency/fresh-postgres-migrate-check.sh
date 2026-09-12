#!/bin/sh
#
# Operational fresh-Postgres migration check (S01 exit criterion, part c).
#
# Spins up a DISPOSITIONABLE (fresh, empty) Postgres, applies the drizzle-pg
# migrations through the APP'S PG MIGRATE PATH (drizzle-orm/postgres-js/migrator —
# the exact same call the app makes in db/drizzle.ts), and asserts that
# stack_sources gained last_saved_at / last_deployed_at on a FRESH database.
#
# This is the definitive fresh-Postgres proof that the dual-DB migration applies
# without drift. It is operational (needs docker + a fresh Postgres) and is NOT
# runnable under bun test — tests/stack-versioning.test.ts covers the CI-runnable
# halves (fresh-SQLite apply + PG lockstep parity) instead.
#
# Usage:
#   ./scripts/emergency/fresh-postgres-migrate-check.sh
#
# Requirements: docker, a Node runtime (NODE_BIN, default: node) run from the
# repo root, and drizzle-orm + postgres installed (project deps).
#
# Env overrides:
#   PG_IMAGE     postgres image to pull (default: postgres:16)
#   PG_PORT      host port to publish  (default: 54331)
#   PG_USER      (default: postgres)
#   PG_PASSWORD  (default: dockhand)
#   PG_DB        (default: dockhand)
#   NODE_BIN     node binary          (default: node)
#   KEEP_PG=1    leave the container running for inspection (no auto-teardown)

set -eu

SCRIPT_DIR="$(dirname "$0")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PG_IMAGE="${PG_IMAGE:-postgres:16}"
PG_PORT="${PG_PORT:-54331}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-dockhand}"
PG_DB="${PG_DB:-dockhand}"
NODE_BIN="${NODE_BIN:-node}"

CTN="dockhand-fresh-pg-$$"
DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"

cleanup() {
	if [ "${KEEP_PG:-0}" != "1" ]; then
		docker rm -f "$CTN" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

echo "========================================"
echo "  Dockhand - fresh-Postgres migration check"
echo "========================================"
echo "image:    $PG_IMAGE"
echo "port:     $PG_PORT"
echo "container: $CTN"
echo "database: ${PG_DB}@127.0.0.1:${PG_PORT}"
echo ""

# 1. Start a fresh, empty, disposable Postgres.
docker rm -f "$CTN" >/dev/null 2>&1 || true
docker run -d --name "$CTN" \
	-e POSTGRES_USER="$PG_USER" \
	-e POSTGRES_PASSWORD="$PG_PASSWORD" \
	-e POSTGRES_DB="$PG_DB" \
	-p "$PG_PORT:5432" \
	"$PG_IMAGE" >/dev/null

# 2. Wait until Postgres accepts connections.
echo "-- waiting for Postgres to become ready --"
READY=0
for _ in $(seq 1 90); do
	if docker exec "$CTN" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
		READY=1
		break
	fi
	sleep 1
done
if [ "$READY" != "1" ]; then
	echo "ERROR: fresh Postgres did not become ready within 90s"
	docker logs "$CTN" 2>&1 | tail -20
	exit 1
fi

# 3. Apply the drizzle-pg migrations via the app's PG migrate path, then assert the
#    pointer columns exist on the fresh database.
echo "-- applying drizzle-pg migrations via the app's PG migrate path --"
cd "$REPO_ROOT"
MIGRATIONS_FOLDER="$REPO_ROOT/drizzle-pg" DATABASE_URL="$DATABASE_URL" \
"$NODE_BIN" --input-type=module - <<'NODE'
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
const folder = process.env.MIGRATIONS_FOLDER;
if (!url || !folder) {
	console.error('ERROR: DATABASE_URL and MIGRATIONS_FOLDER must be set');
	process.exit(1);
}

const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
const db = drizzle(sql);
let ok = false;

try {
	// The app's PG migrate path (db/drizzle.ts): migrate the fresh DB from the
	// drizzle-pg journal. A fresh DB has no _drizzle_migrations rows, so every
	// migration applies — any drift in a migration file fails here.
	await migrate(db, { migrationsFolder: folder });

	// Confirm the app's migrate path created its tracking table (proves the
	// journal-driven migrate actually ran, not a no-op). drizzle's PG migrator
	// uses __drizzle_migrations by default.
	const tracking = await sql`
		SELECT table_schema || '.' || table_name AS t
		FROM information_schema.tables
		WHERE table_name = '__drizzle_migrations'
	`;
	if (tracking.length > 0) {
		console.log(`migrate OK: tracking table ${tracking[0].t} present (migrations recorded)`);
	}

	// Assert the pointer columns exist on the fresh stack_sources table.
	const cols = await sql`
		SELECT column_name FROM information_schema.columns
		WHERE table_name = 'stack_sources'
		  AND column_name IN ('last_saved_at', 'last_deployed_at')
		ORDER BY column_name
	`;
	const found = cols.map((r) => r.column_name);
	if (found.length !== 2 || !found.includes('last_saved_at') || !found.includes('last_deployed_at')) {
		console.error(`FAIL: expected last_saved_at + last_deployed_at, found: ${found.join(', ') || '(none)'}`);
		process.exitCode = 2;
	} else {
		console.log(`fresh stack_sources columns present: ${found.join(', ')}`);
		ok = true;
	}
} catch (e) {
	console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
	process.exitCode = 2;
} finally {
	await sql.end({ timeout: 5 }).catch(() => {});
}

process.exit(ok ? 0 : 1);
NODE

if [ "$?" -eq 0 ]; then
	echo ""
	echo "OK: fresh-Postgres migration check passed — drizzle-pg applies cleanly and"
	echo "    stack_sources has last_saved_at and last_deployed_at on a fresh database."
fi

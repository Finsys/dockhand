#!/bin/sh
#
# SQLite: relocate stored stack paths after a DATA_DIR change.
# See ../relocate-stack-paths.sh for usage. Does NOT move files - updates DB only.

set -e

DB_LABEL="SQLite"

# Locate the database (env override, Docker default, then local dev).
DB_PATH="${DOCKHAND_DB:-/app/data/db/dockhand.db}"
if [ ! -f "$DB_PATH" ] && [ -f "./data/db/dockhand.db" ]; then
    DB_PATH="./data/db/dockhand.db"
fi
if [ ! -f "$DB_PATH" ]; then
    echo "Error: SQLite database not found at $DB_PATH"
    echo "Set DOCKHAND_DB to the database path."
    exit 1
fi
DB_DISPLAY="$DB_PATH"

# SQL-escape a value for single-quoted string literals.
_sql_escape() { printf "%s" "$1" | sed "s/'/''/g"; }

db_list_stack_paths() {
    # One line per non-null compose/env path: <id>\t<field>\t<label>\t<path>
    sqlite3 -separator '	' "$DB_PATH" "
        SELECT s.id, 'compose',
               s.stack_name || CASE WHEN e.name IS NOT NULL THEN ' (' || e.name || ')' ELSE '' END,
               s.compose_path
        FROM stack_sources s LEFT JOIN environments e ON e.id = s.environment_id
        WHERE s.compose_path IS NOT NULL AND s.compose_path <> ''
        UNION ALL
        SELECT s.id, 'env',
               s.stack_name || CASE WHEN e.name IS NOT NULL THEN ' (' || e.name || ')' ELSE '' END,
               s.env_path
        FROM stack_sources s LEFT JOIN environments e ON e.id = s.environment_id
        WHERE s.env_path IS NOT NULL AND s.env_path <> ''
        ORDER BY 1;
    "
}

db_list_external_paths() {
    # settings.external_stack_paths is a JSON array; emit <index>\t<path> per entry.
    # Use json_each so commas/quotes/escapes inside a path are handled correctly.
    sqlite3 -separator '	' "$DB_PATH" "
        SELECT je.key, je.value
        FROM settings s, json_each(s.value) je
        WHERE s.key = 'external_stack_paths';
    " 2>/dev/null
}

db_update_stack_path() {
    id="$1"; field="$2"; new="$(_sql_escape "$3")"
    col="compose_path"; [ "$field" = "env" ] && col="env_path"
    sqlite3 "$DB_PATH" "UPDATE stack_sources SET $col = '$new', updated_at = datetime('now') WHERE id = $id;"
}

db_update_external_path() {
    idx="$1"; new="$(_sql_escape "$2")"
    # Replace ONLY entry <idx> via json_set; other entries (and any commas/escapes in
    # them) are left byte-for-byte intact.
    sqlite3 "$DB_PATH" "
        UPDATE settings
        SET value = json_set(value, '\$[$idx]', '$new'), updated_at = datetime('now')
        WHERE key = 'external_stack_paths';
    "
}

. "$(dirname "$0")/../_relocate-common.sh"
parse_relocate_args "$@"
run_relocation

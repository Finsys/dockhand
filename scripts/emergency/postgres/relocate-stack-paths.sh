#!/bin/sh
#
# PostgreSQL: relocate stored stack paths after a DATA_DIR change.
# See ../relocate-stack-paths.sh for usage. Does NOT move files - updates DB only.
# Requires DATABASE_URL.

DB_LABEL="PostgreSQL"

if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL environment variable not set"
    echo "Example: DATABASE_URL=postgres://user:pass@host:5432/dockhand"
    exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
    echo "Error: psql not found. Install the postgresql-client package."
    exit 1
fi
DB_DISPLAY="$(printf '%s' "$DATABASE_URL" | sed 's#://[^@]*@#://***@#')"  # hide credentials

# Fail loudly on a query error rather than silently returning an empty list (which
# would read as "nothing to do"). ON_ERROR_STOP + no 2>/dev/null on reads.
_psql() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"; }

# SQL-escape for single-quoted literals.
_sql_escape() { printf "%s" "$1" | sed "s/'/''/g"; }

db_list_stack_paths() {
    _psql -t -A -F '	' -c "
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
    # settings.value holds a JSON array as text; parse it with jsonb so commas/quotes/
    # escapes inside a path are handled correctly. WITH ORDINALITY gives a 0-based index.
    _psql -t -A -F '	' -c "
        SELECT ord - 1, elem
        FROM settings s,
             jsonb_array_elements_text(s.value::jsonb) WITH ORDINALITY AS t(elem, ord)
        WHERE s.key = 'external_stack_paths';
    "
}

db_update_stack_path() {
    id="$1"; field="$2"; new="$(_sql_escape "$3")"
    col="compose_path"; [ "$field" = "env" ] && col="env_path"
    _psql -q -c "UPDATE stack_sources SET $col = '$new', updated_at = NOW() WHERE id = $id;" >/dev/null
}

db_update_external_path() {
    idx="$1"; new="$(_sql_escape "$2")"
    # Replace ONLY entry <idx> via jsonb_set; other entries (and any commas/escapes in
    # them) stay intact. value is text, so cast to jsonb and back.
    _psql -q -c "
        UPDATE settings
        SET value = jsonb_set(value::jsonb, ARRAY['$idx'], to_jsonb('$new'::text))::text,
            updated_at = NOW()
        WHERE key = 'external_stack_paths';
    " >/dev/null
}

. "$(dirname "$0")/../_relocate-common.sh"
parse_relocate_args "$@"
run_relocation

#!/bin/sh
#
# Emergency script to factory reset the database
# Automatically detects database type (SQLite or PostgreSQL)
# WARNING: This will DELETE ALL DATA!
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/reset-db.sh
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/reset-db.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/reset-db.sh" "$@"
fi

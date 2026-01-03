#!/bin/sh
#
# Emergency script to restore the database from a backup
# Automatically detects database type (SQLite or PostgreSQL)
# WARNING: This will overwrite the current database!
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/restore-db.sh <backup_file>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/restore-db.sh /app/data/dockhand_backup_20240115_120000.db
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/restore-db.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/restore-db.sh" "$@"
fi

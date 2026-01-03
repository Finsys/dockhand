#!/bin/sh
#
# Emergency script to backup the database
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/backup-db.sh [output_dir]
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/backup-db.sh /app/data/backups
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/backup-db.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/backup-db.sh" "$@"
fi

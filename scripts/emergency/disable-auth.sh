#!/bin/sh
#
# Emergency script to disable authentication
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/disable-auth.sh
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/disable-auth.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/disable-auth.sh" "$@"
fi

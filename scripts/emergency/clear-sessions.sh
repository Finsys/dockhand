#!/bin/sh
#
# Emergency script to clear all user sessions
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/clear-sessions.sh
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/clear-sessions.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/clear-sessions.sh" "$@"
fi

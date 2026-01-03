#!/bin/sh
#
# Emergency script to list all users
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/list-users.sh
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/list-users.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/list-users.sh" "$@"
fi

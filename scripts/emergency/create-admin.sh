#!/bin/sh
#
# Emergency script to create an admin user
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/create-admin.sh
#
# Default credentials: admin / admin123
# CHANGE THE PASSWORD IMMEDIATELY after logging in!
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/create-admin.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/create-admin.sh" "$@"
fi

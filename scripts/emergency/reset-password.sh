#!/bin/sh
#
# Emergency script to reset a user's password
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/reset-password.sh <username> <new_password>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/reset-password.sh admin MyNewPassword123
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/reset-password.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/reset-password.sh" "$@"
fi

#!/bin/sh
#
# Emergency script to disable a user's MFA (TOTP)
# Automatically detects database type (SQLite or PostgreSQL)
#
# Usage:
#   docker exec -it dockhand /app/scripts/reset-mfa.sh <username>
#
# Example:
#   docker exec -it dockhand /app/scripts/reset-mfa.sh admin
#

SCRIPT_DIR="$(dirname "$0")"

# Detect database type
if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/reset-mfa.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/reset-mfa.sh" "$@"
fi

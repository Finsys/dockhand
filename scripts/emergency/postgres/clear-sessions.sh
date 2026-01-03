#!/bin/sh
#
# PostgreSQL: Emergency script to clear all user sessions
# Use this to force all users to re-login
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/clear-sessions.sh
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Clear All Sessions (PostgreSQL)"
echo "========================================"
echo ""
echo "This script will clear all user sessions,"
echo "forcing all users to log in again."
echo ""

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL environment variable not set"
    echo ""
    echo "Example: DATABASE_URL=postgres://user:pass@host:5432/dockhand"
    exit 1
fi

# Parse DATABASE_URL
DB_URL="$DATABASE_URL"
DB_URL="${DB_URL#postgres://}"
DB_URL="${DB_URL#postgresql://}"

DB_USER="${DB_URL%%:*}"
DB_URL="${DB_URL#*:}"
DB_PASS="${DB_URL%%@*}"
DB_URL="${DB_URL#*@}"
DB_HOST="${DB_URL%%:*}"
DB_URL="${DB_URL#*:}"
DB_PORT="${DB_URL%%/*}"
DB_NAME="${DB_URL#*/}"
DB_NAME="${DB_NAME%%\?*}"

export PGPASSWORD="$DB_PASS"

COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM sessions;" 2>/dev/null | tr -d ' ')

echo "Database: $DB_HOST:$DB_PORT/$DB_NAME"
echo "Active sessions: $COUNT"
echo ""
printf "Continue? [y/N]: "
read CONFIRM

case "$CONFIRM" in
    [yY]|[yY][eE][sS])
        ;;
    *)
        echo "Aborted."
        exit 0
        ;;
esac

echo ""
echo "Clearing all user sessions..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "DELETE FROM sessions;"

if [ $? -eq 0 ]; then
    echo ""
    echo "Cleared $COUNT session(s) successfully."
    echo "All users will need to log in again."
else
    echo "Error: Failed to clear sessions"
    exit 1
fi

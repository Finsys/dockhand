#!/bin/sh
#
# SQLite: Emergency script to clear all user sessions
# Use this to force all users to re-login
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/clear-sessions.sh
#

set -e

echo "========================================"
echo "  Dockhand - Clear All Sessions (SQLite)"
echo "========================================"
echo ""
echo "This script will clear all user sessions,"
echo "forcing all users to log in again."
echo ""

# Default database path
DB_PATH="${DOCKHAND_DB:-/app/data/db/dockhand.db}"

# Check if running locally (not in Docker)
if [ ! -f "$DB_PATH" ] && [ -f "./data/db/dockhand.db" ]; then
    DB_PATH="./data/db/dockhand.db"
fi

if [ ! -f "$DB_PATH" ]; then
    echo "Error: Database not found at $DB_PATH"
    echo "Set DOCKHAND_DB environment variable to specify the database path"
    exit 1
fi

COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM sessions;")

echo "Database: $DB_PATH"
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
sqlite3 "$DB_PATH" "DELETE FROM sessions;"

if [ $? -eq 0 ]; then
    echo ""
    echo "Cleared $COUNT session(s) successfully."
    echo "All users will need to log in again."
else
    echo "Error: Failed to clear sessions"
    exit 1
fi

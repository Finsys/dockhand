#!/bin/sh
#
# SQLite: Emergency script to disable authentication
# Use this if you're locked out of Dockhand
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/disable-auth.sh
#

set -e

echo "========================================"
echo "  Dockhand - Disable Authentication (SQLite)"
echo "========================================"
echo ""
echo "This script will disable authentication,"
echo "allowing access to Dockhand without login."
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

echo "Database: $DB_PATH"
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
echo "Disabling authentication..."
sqlite3 "$DB_PATH" "UPDATE auth_settings SET auth_enabled = 0 WHERE id = 1;"

if [ $? -eq 0 ]; then
    echo ""
    echo "Authentication disabled successfully."
    echo "You can now access Dockhand without logging in."
    echo ""
    echo "Remember to re-enable authentication in Settings after regaining access."
else
    echo "Error: Failed to disable authentication"
    exit 1
fi

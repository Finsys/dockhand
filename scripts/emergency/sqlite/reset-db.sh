#!/bin/sh
#
# SQLite: Emergency script to factory reset the database
# WARNING: This will DELETE ALL DATA including users, settings, and activity logs!
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/reset-db.sh
#

set -e

echo "========================================"
echo "  Dockhand - Factory Reset Database (SQLite)"
echo "========================================"
echo ""
echo "WARNING: This will DELETE ALL DATA!"
echo ""
echo "This includes:"
echo "  - All users and their settings"
echo "  - All sessions"
echo "  - Authentication settings"
echo "  - Activity logs"
echo "  - Environment configurations"
echo "  - OIDC/SSO settings"
echo ""
echo "The database will be recreated on next startup."
echo ""

# Default database path
DB_PATH="${DOCKHAND_DB:-/app/data/db/dockhand.db}"

# Check if running locally (not in Docker)
if [ ! -f "$DB_PATH" ] && [ -f "./data/db/dockhand.db" ]; then
    DB_PATH="./data/db/dockhand.db"
fi

if [ ! -f "$DB_PATH" ]; then
    echo "Error: Database not found at $DB_PATH"
    echo "Nothing to reset."
    exit 0
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
echo "Creating backup before reset..."
BACKUP_FILE="${DB_PATH}.backup.$(date +%Y%m%d_%H%M%S)"
cp "$DB_PATH" "$BACKUP_FILE"
echo "Backup saved to: $BACKUP_FILE"

echo ""
echo "Deleting database..."
rm -f "$DB_PATH"
rm -f "${DB_PATH}-wal"
rm -f "${DB_PATH}-shm"

echo ""
echo "Database deleted successfully."
echo ""
echo "Restart Dockhand to recreate a fresh database:"
echo "  docker restart dockhand"

#!/bin/sh
#
# SQLite: Emergency script to restore the database from a backup
# WARNING: This will overwrite the current database!
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/restore-db.sh <backup_file>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/restore-db.sh /app/data/dockhand_backup_20240115_120000.db
#
# To copy backup into container first:
#   docker cp ./dockhand_backup.db dockhand:/app/data/
#

set -e

echo "========================================"
echo "  Dockhand - Restore Database (SQLite)"
echo "========================================"
echo ""

# Check argument
if [ -z "$1" ]; then
    echo "Usage: $0 <backup_file>"
    echo ""
    echo "Example:"
    echo "  $0 /app/data/dockhand_backup_20240115_120000.db"
    echo ""
    echo "To copy backup into container first:"
    echo "  docker cp ./dockhand_backup.db dockhand:/app/data/"
    exit 1
fi

BACKUP_FILE="$1"

# Default database path
DB_PATH="${DOCKHAND_DB:-/app/data/db/dockhand.db}"

# Check if running locally (not in Docker)
if [ ! -f "$DB_PATH" ] && [ -f "./data/db/dockhand.db" ]; then
    DB_PATH="./data/db/dockhand.db"
fi

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Verify it's a valid SQLite database
if ! sqlite3 "$BACKUP_FILE" "SELECT 1;" >/dev/null 2>&1; then
    echo "Error: File is not a valid SQLite database: $BACKUP_FILE"
    exit 1
fi

# Get backup file size
BACKUP_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')

echo "WARNING: This will overwrite the current database!"
echo ""
echo "Current database: $DB_PATH"
echo "Backup to restore: $BACKUP_FILE ($BACKUP_SIZE)"
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

# Create backup of current database before restoring
if [ -f "$DB_PATH" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    PRE_RESTORE_BACKUP="${DB_PATH}.pre-restore.$TIMESTAMP"
    echo ""
    echo "Creating backup of current database..."
    cp "$DB_PATH" "$PRE_RESTORE_BACKUP"
    echo "Current database backed up to: $PRE_RESTORE_BACKUP"
fi

echo ""
echo "Restoring database..."

# Remove WAL files if they exist
rm -f "${DB_PATH}-wal"
rm -f "${DB_PATH}-shm"

# Copy backup to database location
cp "$BACKUP_FILE" "$DB_PATH"

if [ $? -eq 0 ]; then
    echo ""
    echo "Database restored successfully!"
    echo ""
    echo "Restart Dockhand to apply changes:"
    echo "  docker restart dockhand"
else
    echo "Error: Failed to restore database"
    exit 1
fi

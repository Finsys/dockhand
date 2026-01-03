#!/bin/sh
#
# PostgreSQL: Emergency script to restore the database from a backup
# WARNING: This will overwrite the current database!
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/restore-db.sh <backup_file>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/postgres/restore-db.sh /app/data/dockhand_backup_20240115_120000.sql
#
# To copy backup into container first:
#   docker cp ./dockhand_backup.sql dockhand:/app/data/
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Restore Database (PostgreSQL)"
echo "========================================"
echo ""

# Check argument
if [ -z "$1" ]; then
    echo "Usage: $0 <backup_file>"
    echo ""
    echo "Example:"
    echo "  $0 /app/data/dockhand_backup_20240115_120000.sql"
    echo ""
    echo "To copy backup into container first:"
    echo "  docker cp ./dockhand_backup.sql dockhand:/app/data/"
    exit 1
fi

BACKUP_FILE="$1"

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

# Check if backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Get backup file size
BACKUP_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')

echo "WARNING: This will overwrite the current database!"
echo ""
echo "Database: $DB_HOST:$DB_PORT/$DB_NAME"
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
echo ""
echo "Creating backup of current database..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
PRE_RESTORE_BACKUP="/app/data/dockhand_pre_restore_$TIMESTAMP.sql"
if command -v pg_dump >/dev/null 2>&1; then
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -F p -f "$PRE_RESTORE_BACKUP" 2>/dev/null || true
    if [ -f "$PRE_RESTORE_BACKUP" ]; then
        echo "Current database backed up to: $PRE_RESTORE_BACKUP"
    fi
fi

echo ""
echo "Restoring database..."

# Drop and recreate all tables by running the backup
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$BACKUP_FILE"

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

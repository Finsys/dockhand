#!/bin/sh
#
# SQLite: Emergency script to backup the database
# Creates a timestamped copy of the database file
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/backup-db.sh [output_dir]
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/backup-db.sh /app/data/backups
#
# Default output: /app/data (same directory as database)
#

set -e

echo "========================================"
echo "  Dockhand - Backup Database (SQLite)"
echo "========================================"
echo ""

# Default database path
DB_PATH="${DOCKHAND_DB:-/app/data/db/dockhand.db}"
OUTPUT_DIR="${1:-$(dirname "$DB_PATH")}"

# Check if running locally (not in Docker)
if [ ! -f "$DB_PATH" ] && [ -f "./data/db/dockhand.db" ]; then
    DB_PATH="./data/db/dockhand.db"
    OUTPUT_DIR="${1:-./data/db}"
fi

if [ ! -f "$DB_PATH" ]; then
    echo "Error: Database not found at $DB_PATH"
    echo "Set DOCKHAND_DB environment variable to specify the database path"
    exit 1
fi

# Generate backup filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$OUTPUT_DIR/dockhand_backup_$TIMESTAMP.db"

# Get database size
DB_SIZE=$(ls -lh "$DB_PATH" | awk '{print $5}')

echo "This script will create a backup of the database."
echo ""
echo "Source: $DB_PATH ($DB_SIZE)"
echo "Backup: $BACKUP_FILE"
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

# Create output directory if needed
mkdir -p "$OUTPUT_DIR"

echo "Creating database backup..."

# Use sqlite3 backup command for safe backup (handles WAL mode)
if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
else
    # Fallback to file copy if sqlite3 not available
    cp "$DB_PATH" "$BACKUP_FILE"
fi

if [ $? -eq 0 ] && [ -f "$BACKUP_FILE" ]; then
    SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
    echo ""
    echo "Backup created successfully!"
    echo "Size: $SIZE"
    echo ""
    echo "To copy from Docker container to host:"
    echo "  docker cp dockhand:$BACKUP_FILE ./dockhand_backup_$TIMESTAMP.db"
else
    echo "Error: Failed to create backup"
    exit 1
fi

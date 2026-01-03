#!/bin/sh
#
# PostgreSQL: Emergency script to backup the database
# Creates a timestamped dump of the database
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/backup-db.sh [output_dir]
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/postgres/backup-db.sh /app/data/backups
#
# Default output: /app/data
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Backup Database (PostgreSQL)"
echo "========================================"
echo ""

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL environment variable not set"
    echo ""
    echo "Example: DATABASE_URL=postgres://user:pass@host:5432/dockhand"
    exit 1
fi

OUTPUT_DIR="${1:-/app/data}"

# Parse DATABASE_URL
# Format: postgres://user:password@host:port/database
DB_URL="$DATABASE_URL"
DB_URL="${DB_URL#postgres://}"
DB_URL="${DB_URL#postgresql://}"

# Extract credentials
DB_USER="${DB_URL%%:*}"
DB_URL="${DB_URL#*:}"
DB_PASS="${DB_URL%%@*}"
DB_URL="${DB_URL#*@}"
DB_HOST="${DB_URL%%:*}"
DB_URL="${DB_URL#*:}"
DB_PORT="${DB_URL%%/*}"
DB_NAME="${DB_URL#*/}"
DB_NAME="${DB_NAME%%\?*}"

# Generate backup filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$OUTPUT_DIR/dockhand_backup_$TIMESTAMP.sql"

echo "This script will create a backup of the database."
echo ""
echo "Host: $DB_HOST:$DB_PORT"
echo "Database: $DB_NAME"
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

# Use pg_dump to create backup
export PGPASSWORD="$DB_PASS"
if command -v pg_dump >/dev/null 2>&1; then
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -F p -f "$BACKUP_FILE"
else
    echo "Error: pg_dump not found"
    echo "Install PostgreSQL client tools to use this script"
    exit 1
fi

if [ $? -eq 0 ] && [ -f "$BACKUP_FILE" ]; then
    SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
    echo ""
    echo "Backup created successfully!"
    echo "Size: $SIZE"
    echo ""
    echo "To copy from Docker container to host:"
    echo "  docker cp dockhand:$BACKUP_FILE ./dockhand_backup_$TIMESTAMP.sql"
else
    echo "Error: Failed to create backup"
    exit 1
fi

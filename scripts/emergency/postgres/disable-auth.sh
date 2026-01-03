#!/bin/sh
#
# PostgreSQL: Emergency script to disable authentication
# Use this if you're locked out of Dockhand
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/disable-auth.sh
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Disable Authentication (PostgreSQL)"
echo "========================================"
echo ""
echo "This script will disable authentication,"
echo "allowing access to Dockhand without login."
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

echo "Database: $DB_HOST:$DB_PORT/$DB_NAME"
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
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE auth_settings SET auth_enabled = false WHERE id = 1;"

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

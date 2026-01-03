#!/bin/sh
#
# PostgreSQL: Emergency script to factory reset the database
# WARNING: This will DELETE ALL DATA including users, settings, and activity logs!
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/reset-db.sh
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Factory Reset Database (PostgreSQL)"
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
echo "The database tables will be truncated."
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
echo "Creating backup before reset..."
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/app/data/dockhand_backup_pre_reset_$TIMESTAMP.sql"
if command -v pg_dump >/dev/null 2>&1; then
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -F p -f "$BACKUP_FILE" 2>/dev/null || true
    if [ -f "$BACKUP_FILE" ]; then
        echo "Backup saved to: $BACKUP_FILE"
    fi
fi

echo ""
echo "Truncating all tables..."

# Truncate all tables in the correct order (respecting foreign keys)
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" <<EOF
TRUNCATE TABLE
    sessions,
    user_roles,
    dashboard_preferences,
    audit_logs,
    container_events,
    vulnerability_scans,
    stack_sources,
    git_stacks,
    git_repositories,
    git_credentials,
    host_metrics,
    stack_events,
    environment_notifications,
    auto_update_settings,
    users,
    roles,
    oidc_config,
    ldap_config,
    auth_settings,
    notification_settings,
    config_sets,
    registries,
    environments,
    settings
CASCADE;
EOF

echo ""
echo "Database reset successfully."
echo ""
echo "Restart Dockhand to recreate default data:"
echo "  docker restart dockhand"

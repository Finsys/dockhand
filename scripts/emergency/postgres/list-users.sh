#!/bin/sh
#
# PostgreSQL: Emergency script to list all users
# Shows username, admin status, active status, and last login
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/list-users.sh
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - List Users (PostgreSQL)"
echo "========================================"
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

# Get user count
USER_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM users;" 2>/dev/null | tr -d ' ')

if [ "$USER_COUNT" -eq "0" ]; then
    echo "No users found."
    exit 0
fi

# Get Admin role ID for checking admin status
ADMIN_ROLE_ID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT id FROM roles WHERE name='Admin';" 2>/dev/null | tr -d ' ')

# Print header
printf "%-4s %-20s %-8s %-8s %-6s %s\n" "ID" "Username" "Admin" "Active" "MFA" "Last Login"
printf "%-4s %-20s %-8s %-8s %-6s %s\n" "----" "--------------------" "--------" "--------" "------" "-------------------"

# List users (check admin status via user_roles table)
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -A -F '|' -c "SELECT id, username, is_active, mfa_enabled, COALESCE(last_login::text, 'Never') FROM users ORDER BY id;" 2>/dev/null | while IFS='|' read id username is_active mfa_enabled last_login; do
    # Check if user has Admin role
    if [ -n "$ADMIN_ROLE_ID" ]; then
        HAS_ADMIN=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM user_roles WHERE user_id=$id AND role_id=$ADMIN_ROLE_ID;" 2>/dev/null | tr -d ' ')
        if [ "$HAS_ADMIN" -gt "0" ]; then
            admin_str="Yes"
        else
            admin_str="No"
        fi
    else
        admin_str="N/A"
    fi

    # Convert boolean values (PostgreSQL returns t/f)
    if [ "$is_active" = "t" ]; then
        active_str="Yes"
    else
        active_str="No"
    fi

    if [ "$mfa_enabled" = "t" ]; then
        mfa_str="Yes"
    else
        mfa_str="No"
    fi

    printf "%-4s %-20s %-8s %-8s %-6s %s\n" "$id" "$username" "$admin_str" "$active_str" "$mfa_str" "$last_login"
done

echo ""
echo "Total: $USER_COUNT user(s)"

# Show session count
SESSION_COUNT=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM sessions;" 2>/dev/null | tr -d ' ')
echo "Active sessions: $SESSION_COUNT"

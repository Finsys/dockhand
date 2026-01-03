#!/bin/sh
#
# PostgreSQL: Emergency script to create an admin user
# Use this if you're locked out of Dockhand and need to create a new admin
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/create-admin.sh
#
# Default credentials: admin / admin123
# CHANGE THE PASSWORD IMMEDIATELY after logging in!
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Create Admin User (PostgreSQL)"
echo "========================================"
echo ""
echo "This script will create an admin user with:"
echo "  Username: admin"
echo "  Password: admin123"
echo ""
echo "If user 'admin' already exists, password will"
echo "be reset and admin privileges restored."
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

# Username and password
USERNAME="admin"
# Password: admin123
# This is an argon2id hash of "admin123" - generated with default argon2 settings
PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$Jq4am2SfyYKmc0PAHe+yzg$cq/27vK/Qg2eZb/jMDy0ExLDhOG+58cKAximxpG5Dss'

echo ""
echo "Creating admin user..."

# Check if admin user already exists
EXISTING=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM users WHERE username='$USERNAME';" 2>/dev/null | tr -d ' ')

if [ "$EXISTING" -gt "0" ]; then
    echo "User '$USERNAME' already exists."
    echo "Resetting password and ensuring active status..."
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE users SET password_hash='$PASSWORD_HASH', is_active=true WHERE username='$USERNAME';"
    USER_ID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT id FROM users WHERE username='$USERNAME';" 2>/dev/null | tr -d ' ')
else
    echo "Creating new admin user..."
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO users (username, password_hash, is_active, auth_provider, created_at, updated_at) VALUES ('$USERNAME', '$PASSWORD_HASH', true, 'local', NOW(), NOW());"
    USER_ID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT id FROM users WHERE username='$USERNAME';" 2>/dev/null | tr -d ' ')
    echo "Admin user created successfully."
fi

# Get the Admin role ID (it's a system role)
ADMIN_ROLE_ID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT id FROM roles WHERE name='Admin';" 2>/dev/null | tr -d ' ')

if [ -z "$ADMIN_ROLE_ID" ]; then
    echo "Warning: Admin role not found in database."
    echo "The user was created but may not have admin privileges."
    echo "Please check Settings > Auth > Roles after logging in."
else
    # Check if user already has Admin role
    HAS_ROLE=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM user_roles WHERE user_id=$USER_ID AND role_id=$ADMIN_ROLE_ID;" 2>/dev/null | tr -d ' ')

    if [ "$HAS_ROLE" -eq "0" ]; then
        echo "Assigning Admin role..."
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO user_roles (user_id, role_id, created_at) VALUES ($USER_ID, $ADMIN_ROLE_ID, NOW());"
        echo "Admin role assigned."
    else
        echo "User already has Admin role."
    fi
fi

echo ""
echo "Credentials:"
echo "  Username: admin"
echo "  Password: admin123"
echo ""
echo "WARNING: Change the password immediately after logging in!"

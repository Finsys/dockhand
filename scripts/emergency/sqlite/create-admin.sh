#!/bin/sh
#
# SQLite: Emergency script to create an admin user
# Use this if you're locked out of Dockhand and need to create a new admin
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/create-admin.sh
#
# Default credentials: admin / admin123
# CHANGE THE PASSWORD IMMEDIATELY after logging in!
#

set -e

echo "========================================"
echo "  Dockhand - Create Admin User (SQLite)"
echo "========================================"
echo ""
echo "This script will create an admin user with:"
echo "  Username: admin"
echo "  Password: admin123"
echo ""
echo "If user 'admin' already exists, password will"
echo "be reset and admin privileges restored."
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

# Username and password
USERNAME="admin"
# Password: admin123
# This is an argon2id hash of "admin123" - generated with default argon2 settings
PASSWORD_HASH='$argon2id$v=19$m=65536,t=3,p=4$Jq4am2SfyYKmc0PAHe+yzg$cq/27vK/Qg2eZb/jMDy0ExLDhOG+58cKAximxpG5Dss'

echo ""
echo "Creating admin user..."

# Check if admin user already exists
EXISTING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users WHERE username='$USERNAME';")

if [ "$EXISTING" -gt "0" ]; then
    echo "User '$USERNAME' already exists."
    echo "Resetting password and ensuring active status..."
    sqlite3 "$DB_PATH" "UPDATE users SET password_hash='$PASSWORD_HASH', is_active=1 WHERE username='$USERNAME';"
    USER_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM users WHERE username='$USERNAME';")
else
    echo "Creating new admin user..."
    sqlite3 "$DB_PATH" "INSERT INTO users (username, password_hash, is_active, auth_provider, created_at, updated_at) VALUES ('$USERNAME', '$PASSWORD_HASH', 1, 'local', datetime('now'), datetime('now'));"
    USER_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM users WHERE username='$USERNAME';")
    echo "Admin user created successfully."
fi

# Get the Admin role ID (it's a system role)
ADMIN_ROLE_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM roles WHERE name='Admin';")

if [ -z "$ADMIN_ROLE_ID" ]; then
    echo "Warning: Admin role not found in database."
    echo "The user was created but may not have admin privileges."
    echo "Please check Settings > Auth > Roles after logging in."
else
    # Check if user already has Admin role
    HAS_ROLE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM user_roles WHERE user_id=$USER_ID AND role_id=$ADMIN_ROLE_ID;")

    if [ "$HAS_ROLE" -eq "0" ]; then
        echo "Assigning Admin role..."
        sqlite3 "$DB_PATH" "INSERT INTO user_roles (user_id, role_id, created_at) VALUES ($USER_ID, $ADMIN_ROLE_ID, datetime('now'));"
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

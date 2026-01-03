#!/bin/sh
#
# PostgreSQL: Emergency script to reset a user's password
# Use this if a user is locked out and needs a password reset
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/reset-password.sh <username> <new_password>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/postgres/reset-password.sh admin MyNewPassword123
#
# Requires: DATABASE_URL environment variable
#

set -e

echo "========================================"
echo "  Dockhand - Reset User Password (PostgreSQL)"
echo "========================================"
echo ""

# Check arguments
if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: $0 <username> <new_password>"
    echo ""
    echo "Example:"
    echo "  $0 admin MyNewPassword123"
    exit 1
fi

USERNAME="$1"
NEW_PASSWORD="$2"

# Validate password length
if [ ${#NEW_PASSWORD} -lt 8 ]; then
    echo "Error: Password must be at least 8 characters"
    exit 1
fi

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

# Check if user exists
EXISTING=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT COUNT(*) FROM users WHERE username='$USERNAME';" 2>/dev/null | tr -d ' ')

if [ "$EXISTING" -eq "0" ]; then
    echo "Error: User '$USERNAME' not found"
    echo ""
    echo "Available users:"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT username FROM users;" 2>/dev/null | while read user; do
        user=$(echo "$user" | tr -d ' ')
        if [ -n "$user" ]; then
            echo "  - $user"
        fi
    done
    exit 1
fi

echo "This script will reset the password for user '$USERNAME'."
echo ""
echo "Database: $DB_HOST:$DB_PORT/$DB_NAME"
echo "Username: $USERNAME"
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

# Generate password hash using node (argon2 is available in the app)
echo ""
echo "Generating password hash..."

# Check if node and argon2 are available
if command -v node >/dev/null 2>&1; then
    # Try to use argon2 from node_modules
    PASSWORD_HASH=$(node -e "
        try {
            const argon2 = require('argon2');
            argon2.hash('$NEW_PASSWORD').then(h => console.log(h)).catch(e => process.exit(1));
        } catch(e) {
            process.exit(1);
        }
    " 2>/dev/null)

    if [ -z "$PASSWORD_HASH" ]; then
        echo "Error: Could not generate password hash (argon2 not available)"
        echo "This script requires Node.js with argon2 module"
        exit 1
    fi
else
    echo "Error: Node.js is required to generate password hash"
    exit 1
fi

echo "Resetting password for user '$USERNAME'..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "UPDATE users SET password_hash='$PASSWORD_HASH', updated_at=NOW() WHERE username='$USERNAME';"

if [ $? -eq 0 ]; then
    echo ""
    echo "Password reset successfully for user '$USERNAME'"
    echo ""
    # Invalidate sessions
    USER_ID=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT id FROM users WHERE username='$USERNAME';" 2>/dev/null | tr -d ' ')
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "DELETE FROM sessions WHERE user_id=$USER_ID;" 2>/dev/null || true
    echo "All existing sessions have been invalidated."
    echo "The user can now log in with the new password."
else
    echo "Error: Failed to reset password"
    exit 1
fi

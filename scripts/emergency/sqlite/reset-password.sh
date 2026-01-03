#!/bin/sh
#
# SQLite: Emergency script to reset a user's password
# Use this if a user is locked out and needs a password reset
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/reset-password.sh <username> <new_password>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/reset-password.sh admin MyNewPassword123
#

set -e

echo "========================================"
echo "  Dockhand - Reset User Password (SQLite)"
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

# Check if user exists
EXISTING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users WHERE username='$USERNAME';")

if [ "$EXISTING" -eq "0" ]; then
    echo "Error: User '$USERNAME' not found"
    echo ""
    echo "Available users:"
    sqlite3 "$DB_PATH" "SELECT username FROM users;" | while read user; do
        echo "  - $user"
    done
    exit 1
fi

echo "This script will reset the password for user '$USERNAME'."
echo ""
echo "Database: $DB_PATH"
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
sqlite3 "$DB_PATH" "UPDATE users SET password_hash='$PASSWORD_HASH', updated_at=datetime('now') WHERE username='$USERNAME';"

if [ $? -eq 0 ]; then
    echo ""
    echo "Password reset successfully for user '$USERNAME'"
    echo ""
    # Invalidate sessions
    USER_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM users WHERE username='$USERNAME';")
    sqlite3 "$DB_PATH" "DELETE FROM sessions WHERE user_id=$USER_ID;" 2>/dev/null || true
    echo "All existing sessions have been invalidated."
    echo "The user can now log in with the new password."
else
    echo "Error: Failed to reset password"
    exit 1
fi

#!/bin/sh
#
# SQLite: Emergency script to disable a user's MFA (TOTP)
# Use this if a user is locked out of MFA (lost their authenticator app)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/reset-mfa.sh <username>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/sqlite/reset-mfa.sh admin
#

set -e

echo "========================================"
echo "  Dockhand - Reset User MFA (SQLite)"
echo "========================================"
echo ""

# Check arguments
if [ -z "$1" ]; then
    echo "Usage: $0 <username>"
    echo ""
    echo "Example:"
    echo "  $0 admin"
    exit 1
fi

USERNAME="$1"

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

# Show current MFA state
MFA_ENABLED=$(sqlite3 "$DB_PATH" "SELECT mfa_enabled FROM users WHERE username='$USERNAME';")
if [ "$MFA_ENABLED" = "1" ] || [ "$MFA_ENABLED" = "true" ]; then
    STATUS="enabled"
else
    STATUS="already disabled"
fi

echo "This script will disable MFA (TOTP) for user '$USERNAME'."
echo "Backup codes will also be wiped — they cannot be reused."
echo ""
echo "Database: $DB_PATH"
echo "Username: $USERNAME"
echo "Current MFA: $STATUS"
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
echo "Disabling MFA for user '$USERNAME'..."
sqlite3 "$DB_PATH" "UPDATE users SET mfa_enabled=0, mfa_secret=NULL, updated_at=datetime('now') WHERE username='$USERNAME';"

if [ $? -eq 0 ]; then
    echo ""
    echo "MFA disabled successfully for user '$USERNAME'."
    echo "The user can now log in with just their password and can re-enable MFA from their profile."
else
    echo "Error: Failed to disable MFA"
    exit 1
fi

#!/bin/sh
#
# PostgreSQL: Emergency script to disable a user's MFA (TOTP)
# Use this if a user is locked out of MFA (lost their authenticator app)
#
# Usage:
#   docker exec -it dockhand /app/scripts/emergency/postgres/reset-mfa.sh <username>
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/postgres/reset-mfa.sh admin
#

set -e

echo "============================================"
echo "  Dockhand - Reset User MFA (PostgreSQL)"
echo "============================================"
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

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL environment variable not set"
    echo ""
    echo "Example: DATABASE_URL=postgres://user:pass@host:5432/dockhand"
    exit 1
fi

cd /app 2>/dev/null || true

# Check if user exists using psql
USER_EXISTS=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM users WHERE username = '$USERNAME';" 2>/dev/null)

if [ "$USER_EXISTS" = "0" ]; then
    echo "Error: User '$USERNAME' not found"
    echo ""
    echo "Available users:"
    psql "$DATABASE_URL" -t -A -c "SELECT username FROM users;" 2>/dev/null | while read user; do
        echo "  - $user"
    done
    exit 1
fi

# Show current MFA state
MFA_ENABLED=$(psql "$DATABASE_URL" -t -A -c "SELECT mfa_enabled FROM users WHERE username = '$USERNAME';" 2>/dev/null)
if [ "$MFA_ENABLED" = "t" ] || [ "$MFA_ENABLED" = "true" ]; then
    STATUS="enabled"
else
    STATUS="already disabled"
fi

echo "This script will disable MFA (TOTP) for user '$USERNAME'."
echo "Backup codes will also be wiped — they cannot be reused."
echo ""
echo "Database: $DATABASE_URL"
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
psql "$DATABASE_URL" -c "UPDATE users SET mfa_enabled = false, mfa_secret = NULL, updated_at = NOW() WHERE username = '$USERNAME';"

if [ $? -eq 0 ]; then
    echo ""
    echo "MFA disabled successfully for user '$USERNAME'."
    echo "The user can now log in with just their password and can re-enable MFA from their profile."
else
    echo "Error: Failed to disable MFA"
    exit 1
fi

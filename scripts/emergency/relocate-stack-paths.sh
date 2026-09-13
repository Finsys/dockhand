#!/bin/sh
#
# Emergency script: relocate stored stack paths after a DATA_DIR change.
# Automatically detects database type (SQLite or PostgreSQL).
#
# When you change DATA_DIR (e.g. move the bind mount from /app/data to a host
# path), the stack files move on disk but Dockhand's database still points at the
# OLD absolute paths, so stacks show an empty compose. This script rewrites those
# stored pointers from the old DATA_DIR to the new one.
#
# It does NOT move, copy, or delete any files - it only updates where Dockhand
# looks in the database. A pointer is rewritten only when the old file is missing
# AND the new file already exists on disk.
#
# Usage:
#   relocate-stack-paths.sh <old-data-dir> <new-data-dir>            # dry run (default)
#   relocate-stack-paths.sh <old-data-dir> <new-data-dir> --apply    # interactive apply
#   relocate-stack-paths.sh <old-data-dir> <new-data-dir> --apply --all   # apply all
#
# Example:
#   docker exec -it dockhand /app/scripts/emergency/relocate-stack-paths.sh \
#     /app/data /mnt/pool/dockhand --apply

SCRIPT_DIR="$(dirname "$0")"

if [ -n "$DATABASE_URL" ] && (echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'); then
    exec "$SCRIPT_DIR/postgres/relocate-stack-paths.sh" "$@"
else
    exec "$SCRIPT_DIR/sqlite/relocate-stack-paths.sh" "$@"
fi

#!/bin/sh
#
# Emergency script to export all compose stacks
# Exports docker-compose.yml files from the stacks directory
#
# Usage:
#   docker exec -it dockhand /app/scripts/export-stacks.sh [output_dir]
#
# Example:
#   docker exec -it dockhand /app/scripts/export-stacks.sh /tmp/stacks-backup
#
# Default output: /app/data/stacks-export
#

set -e

echo "========================================"
echo "  Dockhand - Export Compose Stacks"
echo "========================================"
echo ""

# Default paths
STACKS_DIR="${DOCKHAND_STACKS:-/home/dockhand/.dockhand/stacks}"
OUTPUT_DIR="${1:-/app/data/stacks-export}"

# Check if running locally (not in Docker)
if [ ! -d "$STACKS_DIR" ] && [ -d "$HOME/.dockhand/stacks" ]; then
    STACKS_DIR="$HOME/.dockhand/stacks"
fi

if [ ! -d "$STACKS_DIR" ]; then
    echo "Error: Stacks directory not found at $STACKS_DIR"
    exit 1
fi

# Count stacks
STACK_COUNT=$(find "$STACKS_DIR" -maxdepth 1 -type d ! -path "$STACKS_DIR" 2>/dev/null | wc -l | tr -d ' ')

echo "This script will export all compose stacks."
echo ""
echo "Stacks directory: $STACKS_DIR"
echo "Output directory: $OUTPUT_DIR"
echo "Stacks found: $STACK_COUNT"
echo ""

if [ "$STACK_COUNT" -eq "0" ]; then
    echo "No stacks found to export."
    exit 0
fi

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

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Exporting stacks..."
echo ""

# Export each stack
find "$STACKS_DIR" -maxdepth 1 -type d ! -path "$STACKS_DIR" | while read stack_dir; do
    STACK_NAME=$(basename "$stack_dir")
    COMPOSE_FILE="$stack_dir/docker-compose.yml"

    if [ -f "$COMPOSE_FILE" ]; then
        mkdir -p "$OUTPUT_DIR/$STACK_NAME"
        cp "$COMPOSE_FILE" "$OUTPUT_DIR/$STACK_NAME/"

        # Also copy .env file if exists
        if [ -f "$stack_dir/.env" ]; then
            cp "$stack_dir/.env" "$OUTPUT_DIR/$STACK_NAME/"
        fi

        echo "  Exported: $STACK_NAME"
    fi
done

echo ""
echo "Export complete!"
echo "Stacks exported to: $OUTPUT_DIR"
echo ""
echo "To copy from Docker container to host:"
echo "  docker cp dockhand:$OUTPUT_DIR ./stacks-backup"

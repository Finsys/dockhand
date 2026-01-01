#!/bin/sh
set -e

# Dockhand Docker Entrypoint
# === Configuration ===
PUID=${PUID:-1001}
PGID=${PGID:-1001}

# === Detect if running as root ===
RUNNING_AS_ROOT=false
if [ "$(id -u)" = "0" ]; then
    RUNNING_AS_ROOT=true
fi

# === Non-root mode (user: directive in compose) ===
# If container started as non-root, skip all user management and run directly
if [ "$RUNNING_AS_ROOT" = "false" ]; then
    echo "Running as user $(id -u):$(id -g) (set via container user directive)"

    # Ensure data directories exist (user must have write access to DATA_DIR via volume mount)
    DATA_DIR="${DATA_DIR:-/app/data}"
    if [ ! -d "$DATA_DIR/db" ]; then
        echo "Creating database directory at $DATA_DIR/db"
        mkdir -p "$DATA_DIR/db" 2>/dev/null || {
            echo "ERROR: Cannot create $DATA_DIR/db directory"
            echo "Ensure the data volume is mounted with correct permissions for user $(id -u):$(id -g)"
            echo ""
            echo "Example docker-compose.yml:"
            echo "  volumes:"
            echo "    - ./data:/app/data  # This directory must be writable by user $(id -u)"
            exit 1
        }
    fi
    if [ ! -d "$DATA_DIR/stacks" ]; then
        mkdir -p "$DATA_DIR/stacks" 2>/dev/null || true
    fi

    # Check Docker socket access if mounted
    SOCKET_PATH="/var/run/docker.sock"
    if [ -S "$SOCKET_PATH" ]; then
        if test -r "$SOCKET_PATH" 2>/dev/null; then
            echo "Docker socket accessible at $SOCKET_PATH"
            # Detect hostname from Docker if not set
            if [ -z "$DOCKHAND_HOSTNAME" ]; then
                DETECTED_HOSTNAME=$(curl -s --unix-socket "$SOCKET_PATH" http://localhost/info 2>/dev/null | sed -n 's/.*"Name":"\([^"]*\)".*/\1/p')
                if [ -n "$DETECTED_HOSTNAME" ]; then
                    export DOCKHAND_HOSTNAME="$DETECTED_HOSTNAME"
                    echo "Detected Docker host hostname: $DOCKHAND_HOSTNAME"
                fi
            fi
        else
            SOCKET_GID=$(stat -c '%g' "$SOCKET_PATH" 2>/dev/null || echo "unknown")
            echo "WARNING: Docker socket not readable by user $(id -u)"
            echo "Add --group-add $SOCKET_GID to your docker run command"
        fi
    else
        echo "No Docker socket found at $SOCKET_PATH"
        echo "Configure Docker environments via the web UI (Settings > Environments)"
    fi

    # Run directly as current user (no su-exec needed)
    if [ "$1" = "" ]; then
        exec bun run ./build/index.js
    else
        exec "$@"
    fi
fi

# === User Setup ===
# Root mode: PUID=0 requested OR already running as root with default PUID/PGID
if [ "$PUID" = "0" ]; then
    echo "Running as root user (PUID=0)"
    RUN_USER="root"
elif [ "$RUNNING_AS_ROOT" = "true" ] && [ "$PUID" = "1001" ] && [ "$PGID" = "1001" ]; then
    echo "Running as root user"
    RUN_USER="root"
else
    RUN_USER="dockhand"
    # Only modify if PUID/PGID differ from image defaults (1001:1001)
    if [ "$PUID" != "1001" ] || [ "$PGID" != "1001" ]; then
        echo "Configuring user with PUID=$PUID PGID=$PGID"

        # Remove existing dockhand user/group (only dockhand, not others)
        deluser dockhand 2>/dev/null || true
        delgroup dockhand 2>/dev/null || true

        # Check for UID conflicts - warn but don't delete other users
        if getent passwd "$PUID" >/dev/null 2>&1; then
            EXISTING=$(getent passwd "$PUID" | cut -d: -f1)
            echo "WARNING: UID $PUID already in use by '$EXISTING'. Using default UID 1001."
            PUID=1001
        fi

        # Handle GID - reuse existing group or create new
        if getent group "$PGID" >/dev/null 2>&1; then
            TARGET_GROUP=$(getent group "$PGID" | cut -d: -f1)
        else
            addgroup -g "$PGID" dockhand
            TARGET_GROUP="dockhand"
        fi

        adduser -u "$PUID" -G "$TARGET_GROUP" -h /home/dockhand -D dockhand
    fi

    # === Directory Ownership ===
    chown -R dockhand:dockhand /app/data /home/dockhand 2>/dev/null || true

    if [ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "/app/data" ] && [ "$DATA_DIR" != "./data" ]; then
        mkdir -p "$DATA_DIR"
        chown -R dockhand:dockhand "$DATA_DIR" 2>/dev/null || true
    fi
fi

# === Docker Socket Access (Optional) ===
# Check if Docker socket is mounted and accessible
# Socket path can be configured via environment-specific settings in the app
SOCKET_PATH="/var/run/docker.sock"

if [ -S "$SOCKET_PATH" ]; then
    # Socket exists - check if readable
    if [ "$RUN_USER" != "root" ]; then
        if ! su-exec "$RUN_USER" test -r "$SOCKET_PATH" 2>/dev/null; then
            SOCKET_GID=$(stat -c '%g' "$SOCKET_PATH" 2>/dev/null || echo "unknown")
            echo "WARNING: Docker socket at $SOCKET_PATH is not readable by dockhand user"
            echo ""
            echo "To use local Docker, fix with one of these options:"
            echo ""
            echo "  1. Add container to docker group (GID: $SOCKET_GID):"
            echo "     docker run --group-add $SOCKET_GID ..."
            echo ""
            echo "  2. Use a socket proxy:"
            echo "     Configure a 'direct' environment pointing to tcp://socket-proxy:2375"
            echo ""
            echo "  3. Make socket world-readable (less secure):"
            echo "     chmod 666 /var/run/docker.sock"
            echo ""
            echo "Continuing startup - configure environments via the web UI..."
        else
            echo "Docker socket accessible at $SOCKET_PATH"
        fi
    else
        echo "Docker socket accessible at $SOCKET_PATH"
    fi

    # === Detect Docker Host Hostname (for license validation) ===
    # Query Docker API to get the real host hostname (not container ID)
    if [ -z "$DOCKHAND_HOSTNAME" ]; then
        DETECTED_HOSTNAME=$(curl -s --unix-socket "$SOCKET_PATH" http://localhost/info 2>/dev/null | sed -n 's/.*"Name":"\([^"]*\)".*/\1/p')
        if [ -n "$DETECTED_HOSTNAME" ]; then
            export DOCKHAND_HOSTNAME="$DETECTED_HOSTNAME"
            echo "Detected Docker host hostname: $DOCKHAND_HOSTNAME"
        fi
    else
        echo "Using configured hostname: $DOCKHAND_HOSTNAME"
    fi
else
    echo "No Docker socket found at $SOCKET_PATH"
    echo "Configure Docker environments via the web UI (Settings > Environments)"
fi

# === Run Application ===
if [ "$RUN_USER" = "root" ]; then
    # Running as root - execute directly
    if [ "$1" = "" ]; then
        exec bun run ./build/index.js
    else
        exec "$@"
    fi
else
    # Running as dockhand user
    if [ "$1" = "" ]; then
        exec su-exec dockhand bun run ./build/index.js
    else
        exec su-exec dockhand "$@"
    fi
fi

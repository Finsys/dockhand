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

        # Remove existing dockhand user/group (using busybox commands)
        deluser dockhand 2>/dev/null || true
        delgroup dockhand 2>/dev/null || true

        # Check for UID conflicts - warn but don't delete other users
        SKIP_USER_CREATE=false
        EXISTING=$(awk -F: -v uid="$PUID" '$3 == uid { print $1 }' /etc/passwd)
        if [ -n "$EXISTING" ]; then
            if [ "$EXISTING" = "bun" ]; then
                echo "Note: UID $PUID is used by the 'bun' runtime user - reusing it for dockhand"
                echo "If upgrading from a previous version, you may need to fix data permissions:"
                echo "  chown -R $PUID:$PGID /path/to/your/data"
                RUN_USER="bun"
                SKIP_USER_CREATE=true
            else
                echo "WARNING: UID $PUID already in use by '$EXISTING'. Using default UID 1001."
                PUID=1001
            fi
        fi

        # Handle GID - reuse existing group or create new
        TARGET_GROUP=$(awk -F: -v gid="$PGID" '$3 == gid { print $1 }' /etc/group)
        if [ -z "$TARGET_GROUP" ]; then
            addgroup -g "$PGID" dockhand
            TARGET_GROUP="dockhand"
        fi

        if [ "$SKIP_USER_CREATE" = "false" ]; then
            adduser -u "$PUID" -G "$TARGET_GROUP" -h /home/dockhand -D dockhand
        fi
    fi

    # === Directory Ownership ===
    chown -R "$RUN_USER":"$RUN_USER" /app/data 2>/dev/null || true
    if [ "$RUN_USER" = "dockhand" ]; then
        chown -R dockhand:dockhand /home/dockhand 2>/dev/null || true
    fi

    if [ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "/app/data" ] && [ "$DATA_DIR" != "./data" ]; then
        mkdir -p "$DATA_DIR"
        chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true
    fi
fi

# === Docker Socket Access (Optional) ===
# Check if Docker socket is mounted and accessible
# Note: DOCKER_HOST with tcp:// requires configuring an environment via the web UI
SOCKET_PATH="/var/run/docker.sock"

if [ -S "$SOCKET_PATH" ]; then
    if [ "$RUN_USER" != "root" ]; then
        # Get socket GID
        SOCKET_GID=$(stat -c '%g' "$SOCKET_PATH" 2>/dev/null || echo "")

        if [ -n "$SOCKET_GID" ]; then
            # Check if user already has access
            if ! su-exec "$RUN_USER" test -r "$SOCKET_PATH" 2>/dev/null; then
                echo "Docker socket GID: $SOCKET_GID - adding $RUN_USER to docker group..."

                # Check if group with this GID exists (without getent, use /etc/group)
                DOCKER_GROUP=$(awk -F: -v gid="$SOCKET_GID" '$3 == gid { print $1 }' /etc/group)
                if [ -z "$DOCKER_GROUP" ]; then
                    # Create docker group with socket's GID
                    DOCKER_GROUP="docker"
                    addgroup -g "$SOCKET_GID" "$DOCKER_GROUP" 2>/dev/null || true
                fi

                # Add user to docker group (try both busybox variants)
                addgroup "$RUN_USER" "$DOCKER_GROUP" 2>/dev/null || \
                adduser "$RUN_USER" "$DOCKER_GROUP" 2>/dev/null || true

                # Verify access after adding to group
                if su-exec "$RUN_USER" test -r "$SOCKET_PATH" 2>/dev/null; then
                    echo "Docker socket accessible at $SOCKET_PATH"
                else
                    echo "WARNING: Could not grant Docker socket access to $RUN_USER"
                    echo "Try running container with: --group-add $SOCKET_GID"
                fi
            else
                echo "Docker socket accessible at $SOCKET_PATH"
            fi
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
    echo "No local Docker socket mounted (this is normal when using socket-proxy or remote Docker)"
    echo "Configure your Docker environment via the web UI: Settings > Environments"
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
    # Running as non-root user
    echo "Running as user: $RUN_USER"
    if [ "$1" = "" ]; then
        exec su-exec "$RUN_USER" bun run ./build/index.js
    else
        exec su-exec "$RUN_USER" "$@"
    fi
fi

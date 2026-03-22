#!/bin/sh
set -e

# Dockhand Docker Entrypoint (Node.js)
# === Configuration ===
PUID=${PUID:-1001}
PGID=${PGID:-1001}

# Increase body size limit for container file uploads (default 512KB is too small)
export BODY_SIZE_LIMIT=${BODY_SIZE_LIMIT:-2G}

# Default command (--expose-gc allows forced GC from /api/debug/memory?gc=true)
# Custom CA: set NODE_EXTRA_CA_CERTS=/path/to/ca.crt (appends to built-in CAs)
# Enterprise (system CA store): set NODE_OPTIONS="--use-openssl-ca"
if [ "$MEMORY_MONITOR" = "true" ]; then
    DEFAULT_CMD="node --dns-result-order=ipv4first --no-network-family-autoselection --expose-gc /app/server.js"
else
    DEFAULT_CMD="node --dns-result-order=ipv4first --no-network-family-autoselection /app/server.js"
fi

# === Detect if running as root ===
RUNNING_AS_ROOT=false
if [ "$(id -u)" = "0" ]; then
    RUNNING_AS_ROOT=true
fi

# === Non-root mode (user: directive in compose) ===
if [ "$RUNNING_AS_ROOT" = "false" ]; then
    echo "Running as user $(id -u):$(id -g) (set via container user directive)"

    DATA_DIR="${DATA_DIR:-/app/data}"
    if [ ! -d "$DATA_DIR/db" ]; then
        echo "Creating database directory at $DATA_DIR/db"
        mkdir -p "$DATA_DIR/db" 2>/dev/null || {
            echo "ERROR: Cannot create $DATA_DIR/db directory"
            echo "Ensure the data volume is mounted with correct permissions for user $(id -u):$(id -g)"
            exit 1
        }
    fi
    if [ ! -d "$DATA_DIR/stacks" ]; then
        mkdir -p "$DATA_DIR/stacks" 2>/dev/null || true
    fi

    SOCKET_PATH="/var/run/docker.sock"
    if [ -S "$SOCKET_PATH" ]; then
        if test -r "$SOCKET_PATH" 2>/dev/null; then
            echo "Docker socket accessible at $SOCKET_PATH"
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

    if [ "$1" = "" ]; then
        exec $DEFAULT_CMD
    else
        exec "$@"
    fi
fi

# === User Setup ===
if [ "$PUID" = "0" ]; then
    echo "Running as root user (PUID=0)"
    RUN_USER="root"
elif [ "$RUNNING_AS_ROOT" = "true" ] && [ "$PUID" = "1001" ] && [ "$PGID" = "1001" ]; then
    echo "Running as root user"
    RUN_USER="root"
else
    RUN_USER="dockhand"
    if [ "$PUID" != "1001" ] || [ "$PGID" != "1001" ]; then
        echo "Configuring user with PUID=$PUID PGID=$PGID"

        deluser dockhand 2>/dev/null || true
        delgroup dockhand 2>/dev/null || true

        SKIP_USER_CREATE=false
        EXISTING=$(awk -F: -v uid="$PUID" '$3 == uid { print $1 }' /etc/passwd)
        if [ -n "$EXISTING" ]; then
            echo "WARNING: UID $PUID already in use by '$EXISTING'. Using default UID 1001."
            PUID=1001
        fi

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
    # Only chown Dockhand's own subdirectories, not the entire /app/data tree.
    # Recursive chown on /app/data breaks stack volumes mounted with relative paths
    # (e.g. ./postgresql:/var/lib/postgresql) that need different ownership (#719).
    DATA_DIR="${DATA_DIR:-/app/data}"
    chown "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true
    for subdir in db stacks git-repos tmp icons snapshots scanner-cache; do
        if [ -d "$DATA_DIR/$subdir" ]; then
            chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR/$subdir" 2>/dev/null || true
        fi
    done
    if [ "$RUN_USER" = "dockhand" ]; then
        chown -R dockhand:dockhand /home/dockhand 2>/dev/null || true
    fi

    if [ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "/app/data" ] && [ "$DATA_DIR" != "./data" ]; then
        mkdir -p "$DATA_DIR"
        chown "$RUN_USER":"$RUN_USER" "$DATA_DIR" 2>/dev/null || true
        for subdir in db stacks git-repos tmp icons snapshots scanner-cache; do
            if [ -d "$DATA_DIR/$subdir" ]; then
                chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR/$subdir" 2>/dev/null || true
            fi
        done
    fi
fi

# === Docker Socket Access ===
SOCKET_PATH="/var/run/docker.sock"

if [ -S "$SOCKET_PATH" ]; then
    if [ "$RUN_USER" != "root" ]; then
        SOCKET_GID=$(stat -c '%g' "$SOCKET_PATH" 2>/dev/null || echo "")

        if [ -n "$SOCKET_GID" ]; then
            if ! su-exec "$RUN_USER" test -r "$SOCKET_PATH" 2>/dev/null; then
                echo "Docker socket GID: $SOCKET_GID - adding $RUN_USER to docker group..."

                DOCKER_GROUP=$(awk -F: -v gid="$SOCKET_GID" '$3 == gid { print $1 }' /etc/group)
                if [ -z "$DOCKER_GROUP" ]; then
                    DOCKER_GROUP="docker"
                    addgroup -g "$SOCKET_GID" "$DOCKER_GROUP" 2>/dev/null || true
                fi

                addgroup "$RUN_USER" "$DOCKER_GROUP" 2>/dev/null || \
                adduser "$RUN_USER" "$DOCKER_GROUP" 2>/dev/null || true

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
    if [ "$1" = "" ]; then
        exec $DEFAULT_CMD
    else
        exec "$@"
    fi
else
    echo "Running as user: $RUN_USER"
    if [ "$1" = "" ]; then
        exec su-exec "$RUN_USER" $DEFAULT_CMD
    else
        exec su-exec "$RUN_USER" "$@"
    fi
fi

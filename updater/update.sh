#!/bin/sh
# Dockhand Self-Update Sidecar
# Dockhand pre-creates the new container. This script just does:
#   stop old → rm old → rename new → connect networks → start → verify
#
# Required env vars:
#   OLD_CONTAINER_ID   - Container ID of the running Dockhand to replace
#   NEW_CONTAINER_ID   - Container ID of the pre-created replacement
#   CONTAINER_NAME     - Original container name to restore after rename
#   NETWORKS           - Space-separated network names (optional)
#   NETWORK_OPTS_<net> - Per-network flags for docker network connect (optional)
#
# Optional:
#   STOP_TIMEOUT       - Timeout for stopping container (default: 30)

set -e

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }
error() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" >&2; }

[ -z "$OLD_CONTAINER_ID" ] && { error "OLD_CONTAINER_ID not set"; exit 1; }
[ -z "$NEW_CONTAINER_ID" ] && { error "NEW_CONTAINER_ID not set"; exit 1; }
[ -z "$CONTAINER_NAME" ]   && { error "CONTAINER_NAME not set"; exit 1; }

STOP_TIMEOUT="${STOP_TIMEOUT:-30}"
log "Starting Dockhand update"
log "  Old: ${OLD_CONTAINER_ID:0:12}, New: ${NEW_CONTAINER_ID:0:12}, Name: $CONTAINER_NAME"

log "Stopping container (timeout: ${STOP_TIMEOUT}s)..."
docker stop -t "$STOP_TIMEOUT" "$OLD_CONTAINER_ID" || { error "Failed to stop container"; exit 1; }
log "Container stopped"

log "Removing old container..."
docker rm "$OLD_CONTAINER_ID" || { error "Failed to remove old container"; exit 1; }
log "Old container removed"

log "Renaming container..."
docker rename "$NEW_CONTAINER_ID" "$CONTAINER_NAME" || { error "Failed to rename container"; exit 1; }
log "Container renamed to $CONTAINER_NAME"

if [ -n "$NETWORKS" ]; then
    for NET in $NETWORKS; do
        OPTS_VAR="NETWORK_OPTS_$(echo "$NET" | tr '.-' '__')"
        OPTS=$(eval echo "\$$OPTS_VAR" 2>/dev/null || true)
        log "Connecting to network $NET ${OPTS:+($OPTS)}"
        # shellcheck disable=SC2086
        docker network connect $OPTS "$NET" "$NEW_CONTAINER_ID" || log "  Warning: failed to connect to $NET"
    done
    log "Networks connected"
fi

log "Starting container..."
docker start "$NEW_CONTAINER_ID" || { error "Failed to start container"; exit 1; }

sleep 2
STATE=$(docker inspect -f '{{.State.Status}}' "$NEW_CONTAINER_ID" 2>/dev/null)
if [ "$STATE" = "running" ]; then
    log "Container is running"
    log "Update completed successfully!"
else
    error "Container state: $STATE (expected running)"
    exit 1
fi

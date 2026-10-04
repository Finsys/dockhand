#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
	echo "usage: $0 <dockhand-app-image> <dockhand-backup-helper-image>" >&2
	exit 2
fi

APP_IMAGE=$1
HELPER_IMAGE=$2
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dockhand-sftp-smoke.XXXXXX")
RUN_ID="$(date +%s)-$$"
SERVER="dockhand-sftp-server-${RUN_ID}"

cleanup() {
	docker rm -f "$SERVER" >/dev/null 2>&1 || true
	rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK_DIR/remote" "$WORK_DIR/source" "$WORK_DIR/restore"
printf 'dockhand-sftp-smoke\n' > "$WORK_DIR/source/payload.txt"

ssh-keygen -q -t ed25519 -N '' -f "$WORK_DIR/client"
ssh-keygen -q -t ed25519 -N '' -f "$WORK_DIR/wrong-client"
ssh-keygen -q -t ed25519 -N '' -f "$WORK_DIR/host"
ssh-keygen -q -t ed25519 -N '' -f "$WORK_DIR/wrong-host"

HOST_KEY=$(awk '{ print $1 " " $2 }' "$WORK_DIR/host.pub")
WRONG_HOST_KEY=$(awk '{ print $1 " " $2 }' "$WORK_DIR/wrong-host.pub")
chmod 600 "$WORK_DIR/client" "$WORK_DIR/wrong-client"

cat > "$WORK_DIR/sshd_config" <<'EOF'
Port 2222
ListenAddress 0.0.0.0
HostKey /run/smoke/host
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers backup
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp internal-sftp
EOF

cat > "$WORK_DIR/restic.sh" <<'EOF'
#!/bin/sh
set -eu
exec restic -o "sftp.args='-F' '/dev/null' '-i' '/run/sftp/id' '-o' 'UserKnownHostsFile=/run/sftp/known_hosts' '-o' 'GlobalKnownHostsFile=/dev/null' '-o' 'StrictHostKeyChecking=yes' '-o' 'UpdateHostKeys=no' '-o' 'BatchMode=yes' '-o' 'NumberOfPasswordPrompts=0' '-o' 'PasswordAuthentication=no' '-o' 'KbdInteractiveAuthentication=no' '-o' 'PreferredAuthentications=publickey' '-o' 'IdentitiesOnly=yes' '-o' 'IdentityAgent=none' '-o' 'ForwardAgent=no'" "$@"
EOF
chmod 700 "$WORK_DIR/restic.sh"

docker run -d --name "$SERVER" --publish 2222 \
	-v "$WORK_DIR/client.pub:/run/smoke/client.pub:ro" \
	-v "$WORK_DIR/host:/run/smoke/host:ro" \
	-v "$WORK_DIR/sshd_config:/run/smoke/sshd_config:ro" \
	-v "$WORK_DIR/remote:/data" \
	alpine:3.21 sh -ceu '
		attempt=1
		until apk add --no-cache openssh-server >/dev/null; do
			[ "$attempt" -lt 5 ] || exit 1
			attempt=$((attempt + 1))
			sleep 3
		done
		adduser -D -u 1000 backup
		passwd -d backup >/dev/null
		mkdir -p /home/backup/.ssh /data
		cp /run/smoke/client.pub /home/backup/.ssh/authorized_keys
		chown -R backup:backup /home/backup /data
		chmod 700 /home/backup/.ssh
		chmod 600 /home/backup/.ssh/authorized_keys
		exec /usr/sbin/sshd -D -e -f /run/smoke/sshd_config
	' >/dev/null

sleep 2
if [ "$(docker inspect -f '{{.State.Running}}' "$SERVER")" != "true" ]; then
	echo "SFTP smoke server failed to start" >&2
	docker logs "$SERVER" >&2 || true
	exit 1
fi
SERVER_PORT=$(docker port "$SERVER" 2222/tcp | head -n 1 | sed 's/.*://')
case "$SERVER_PORT" in
	''|*[!0-9]*)
	echo "SFTP smoke server has no published port" >&2
	exit 1
	;;
esac

printf '[127.0.0.1]:%s %s\n' "$SERVER_PORT" "$HOST_KEY" > "$WORK_DIR/known_hosts"
printf '[127.0.0.1]:%s %s\n' "$SERVER_PORT" "$WRONG_HOST_KEY" > "$WORK_DIR/wrong_known_hosts"
RESTIC_PASSWORD=$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n')
cat > "$WORK_DIR/restic.env" <<EOF
RESTIC_REPOSITORY=sftp://backup@127.0.0.1:${SERVER_PORT}//data/repo
RESTIC_PASSWORD=$RESTIC_PASSWORD
EOF
unset RESTIC_PASSWORD
chmod 600 "$WORK_DIR/known_hosts" "$WORK_DIR/wrong_known_hosts" "$WORK_DIR/restic.env"

run_app() {
	key=$1
	known_hosts=$2
	shift 2
	docker run --rm --network host --entrypoint /run/smoke/restic.sh \
		--env-file "$WORK_DIR/restic.env" \
		-v "$WORK_DIR/restic.sh:/run/smoke/restic.sh:ro" \
		-v "$key:/run/sftp/id:ro" \
		-v "$known_hosts:/run/sftp/known_hosts:ro" \
		"$APP_IMAGE" "$@"
}

echo "SFTP smoke: init (application image)"
run_app "$WORK_DIR/client" "$WORK_DIR/known_hosts" init >/dev/null

echo "SFTP smoke: backup (helper image)"
docker run --rm --network host --entrypoint /run/smoke/restic.sh \
	--env-file "$WORK_DIR/restic.env" \
	-v "$WORK_DIR/restic.sh:/run/smoke/restic.sh:ro" \
	-v "$WORK_DIR/client:/run/sftp/id:ro" \
	-v "$WORK_DIR/known_hosts:/run/sftp/known_hosts:ro" \
	-v "$WORK_DIR/source:/source:ro" \
	"$HELPER_IMAGE" backup /source --host dockhand-sftp-smoke >/dev/null

echo "SFTP smoke: snapshots (application image)"
run_app "$WORK_DIR/client" "$WORK_DIR/known_hosts" snapshots --json >/dev/null

echo "SFTP smoke: restore (helper image)"
docker run --rm --network host --entrypoint /run/smoke/restic.sh \
	--env-file "$WORK_DIR/restic.env" \
	-v "$WORK_DIR/restic.sh:/run/smoke/restic.sh:ro" \
	-v "$WORK_DIR/client:/run/sftp/id:ro" \
	-v "$WORK_DIR/known_hosts:/run/sftp/known_hosts:ro" \
	-v "$WORK_DIR/restore:/restore" \
	"$HELPER_IMAGE" restore latest --target /restore >/dev/null
cmp "$WORK_DIR/source/payload.txt" "$WORK_DIR/restore/source/payload.txt"

echo "SFTP smoke: check and prune (application image)"
run_app "$WORK_DIR/client" "$WORK_DIR/known_hosts" check >/dev/null
run_app "$WORK_DIR/client" "$WORK_DIR/known_hosts" prune >/dev/null

echo "SFTP smoke: wrong private key is rejected"
if run_app "$WORK_DIR/wrong-client" "$WORK_DIR/known_hosts" snapshots >"$WORK_DIR/wrong-key.log" 2>&1; then
	echo "SFTP accepted the wrong private key" >&2
	exit 1
fi
grep -Eqi 'permission denied|publickey|authentication' "$WORK_DIR/wrong-key.log"

echo "SFTP smoke: host-key mismatch is rejected"
if run_app "$WORK_DIR/client" "$WORK_DIR/wrong_known_hosts" snapshots >"$WORK_DIR/wrong-host.log" 2>&1; then
	echo "SFTP accepted a mismatched host key" >&2
	exit 1
fi
grep -Eqi 'host key verification failed|host key for .* has changed|no .* host key is known' "$WORK_DIR/wrong-host.log"

echo "SFTP smoke test passed"

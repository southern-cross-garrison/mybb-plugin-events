#!/usr/bin/env bash
# One-shot setup of the whole development / test environment.
#
#   scripts/bootstrap.sh            reuse an existing test-forum/ if present
#   scripts/bootstrap.sh --fresh    wipe test-forum/ and the database volume first
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1

if [ "$FRESH" = "1" ]; then
    log "Tearing down existing environment"
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$FORUM_DIR" "$SNAPSHOT_FILE"
fi

mkdir -p "$(dirname "$FAKETIME_FILE")"
printf '+0' > "$FAKETIME_FILE"

if [ ! -f "$FORUM_DIR/inc/class_core.php" ]; then
    "$REPO_ROOT/scripts/fetch-mybb.sh"
fi

log "Starting containers"
dc up -d --build web db

log "Waiting for the web server"
for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "${BASE_URL}/install/index.php" && break
    sleep 2
done
curl -fsS -o /dev/null "${BASE_URL}/install/index.php" || die "web server never came up at ${BASE_URL}"

# A pre-existing install (reused test-forum/ + database volume) is left alone.
if dc exec -T db sh -c "exec mariadb -uroot -p'$DB_ROOT_PASS' -N -B -e \"SELECT 1 FROM information_schema.tables WHERE table_schema='$DB_NAME' AND table_name='${TABLE_PREFIX}users'\"" 2>/dev/null | grep -q 1; then
    log "MyBB already installed - skipping installer"
else
    "$REPO_ROOT/scripts/install-mybb.sh"
fi

"$REPO_ROOT/scripts/deploy.sh"

# Dev-only probe so the e2e suite can assert the faked clock reached PHP.
printf '%s' '<?php echo date("Y-m-d H:i:s");' > "$FORUM_DIR/_clockprobe.php"

log "Provisioning fixtures and activating the plugin"
dc exec -T web php /dev/stdin < "$REPO_ROOT/scripts/provision.php"

"$REPO_ROOT/scripts/db-snapshot.sh"

log "Environment ready:"
echo "    Forum      ${BASE_URL}"
echo "    Admin CP   ${BASE_URL}/admin/  (${ADMIN_USER} / ${ADMIN_PASS})"
echo "    Database   localhost:${DB_PORT} (${DB_USER} / ${DB_PASS})"

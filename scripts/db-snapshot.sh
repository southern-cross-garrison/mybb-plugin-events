#!/usr/bin/env bash
# Dump the provisioned database so the e2e suite can reset to a known state cheaply.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

mkdir -p "$(dirname "$SNAPSHOT_FILE")"
dc exec -T db sh -c "exec mariadb-dump -uroot -p\"$DB_ROOT_PASS\" --single-transaction --add-drop-table '$DB_NAME'" > "$SNAPSHOT_FILE"
log "Snapshot written to ${SNAPSHOT_FILE} ($(wc -c < "$SNAPSHOT_FILE") bytes)"

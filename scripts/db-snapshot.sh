#!/usr/bin/env bash
# Dump the provisioned database so the e2e suite can reset to a known state cheaply.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

mkdir -p "$(dirname "$SNAPSHOT_FILE")"

# Dumped to a temporary file and moved into place only once mariadb-dump has exited
# cleanly. Redirecting straight onto $SNAPSHOT_FILE truncates it the moment the shell
# opens it, so a dump that fails part way - error 1412 when another process alters a
# table mid-dump is the one that actually happens - leaves a half-written snapshot behind
# and takes the suite's only baseline with it. There is nothing to restore from at that
# point, and the failure surfaces later as the restore dying on a truncated statement.
TMP_SNAPSHOT="${SNAPSHOT_FILE}.part"
trap 'rm -f "$TMP_SNAPSHOT"' EXIT

if ! dc exec -T db sh -c "exec mariadb-dump -uroot -p\"$DB_ROOT_PASS\" --single-transaction --add-drop-table '$DB_NAME'" > "$TMP_SNAPSHOT"
then
    die "mariadb-dump failed - the existing snapshot at ${SNAPSHOT_FILE} is untouched"
fi

# A dump that exited 0 but wrote nothing useful is not a snapshot either.
grep -q '^-- Dump completed' "$TMP_SNAPSHOT" || die "dump looks truncated - the existing snapshot at ${SNAPSHOT_FILE} is untouched"

mv "$TMP_SNAPSHOT" "$SNAPSHOT_FILE"
log "Snapshot written to ${SNAPSHOT_FILE} ($(wc -c < "$SNAPSHOT_FILE") bytes)"

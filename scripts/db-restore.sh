#!/usr/bin/env bash
# Restore the database to the provisioned snapshot, then clear the fake clock.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ -f "$SNAPSHOT_FILE" ] || die "no snapshot at ${SNAPSHOT_FILE} - run scripts/bootstrap.sh"

dc exec -T db sh -c "exec mariadb -uroot -p\"$DB_ROOT_PASS\" '$DB_NAME'" < "$SNAPSHOT_FILE"

# MyBB caches settings in inc/settings.php; the snapshot restore can leave that file
# ahead of the database, so rewrite it from the restored rows.
dc exec -T web php -r '
define("IN_MYBB", 1);
define("MYBB_ROOT", "/var/www/html/");
define("THIS_SCRIPT", "reset.php");
require MYBB_ROOT."inc/init.php";
rebuild_settings();
' > /dev/null

mkdir -p "$(dirname "$FAKETIME_FILE")"
printf '+0' > "$FAKETIME_FILE"

log "Database restored from snapshot; clock reset to real time"

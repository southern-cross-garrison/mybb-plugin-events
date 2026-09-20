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

# Theme stylesheets live in two places: the themestylesheets rows (in the snapshot) and
# flat files under cache/themes/themeN/ (not). MyBB resolves a stylesheet's URL by walking
# the theme's parent chain for the first cached file that exists, so a missing file does
# not 404 - it silently serves the parent's, which for a child of MyBB Master Style means
# the board renders in stock MyBB CSS. Re-importing a theme deletes the old theme's cache
# directory, so any snapshot taken before that is restored into exactly that state.
# Regenerate the files from the restored rows and rebuild the URL maps to match.
dc exec -T web php -r '
define("IN_MYBB", 1);
define("MYBB_ROOT", "/var/www/html/");
define("THIS_SCRIPT", "reset.php");
require MYBB_ROOT."inc/init.php";
require_once MYBB_ROOT."admin/inc/functions_themes.php";
$query = $db->simple_select("themestylesheets", "tid, name, stylesheet");
while($sheet = $db->fetch_array($query))
{
    cache_stylesheet((int)$sheet["tid"], $sheet["name"], $sheet["stylesheet"]);
}
$roots = $db->simple_select("themes", "tid", "pid = 0");
while($theme = $db->fetch_array($roots))
{
    update_theme_stylesheet_list((int)$theme["tid"], false, true);
}
' > /dev/null

mkdir -p "$(dirname "$FAKETIME_FILE")"
printf '+0' > "$FAKETIME_FILE"

# MyBB's shutdown handler adds `now - lastactive` to users.timeonline, which is UNSIGNED.
# The snapshot carries whatever timestamps the clock held when it was taken, so restoring
# it and rewinding to real time leaves lastactive in the future - the next page view then
# tries to add a negative number and MySQL rejects it with "BIGINT UNSIGNED value is out
# of range". Realign the timestamps to the clock we just reset to. This must run after the
# faketime file is written, so that time() reads the restored clock.
dc exec -T web php -r '
define("IN_MYBB", 1);
define("MYBB_ROOT", "/var/www/html/");
define("THIS_SCRIPT", "reset.php");
require MYBB_ROOT."inc/init.php";
$now = (int)time();
$db->write_query("UPDATE ".TABLE_PREFIX."users SET lastactive={$now}, lastvisit={$now}, timeonline=0");
$db->write_query("UPDATE ".TABLE_PREFIX."sessions SET time={$now}");
' > /dev/null

log "Database restored from snapshot; clock reset to real time"

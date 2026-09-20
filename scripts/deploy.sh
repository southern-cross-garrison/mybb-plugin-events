#!/usr/bin/env bash
# Deploy the plugin from plugin/ into the MyBB tree at test-forum/.
#
# Layout mapping:
#   plugin/inc/plugins/...    -> test-forum/inc/plugins/... (plugin code, includes, templates)
#   plugin/inc/tasks/...      -> test-forum/inc/tasks/...   (MyBB requires task files here)
#   plugin/root/*.php         -> test-forum/*.php          (front-end entry points; MyBB
#                                                           pages must sit at the web root
#                                                           because they require ./global.php)
#   plugin/root/jscripts/...  -> test-forum/jscripts/...  (the event form's shared assets -
#                                                           the calendar picker and the tag
#                                                           field's stylesheet; one copy,
#                                                           loaded by the board as
#                                                           jscripts/events/ and by the Admin
#                                                           CP as ../jscripts/events/)
#   plugin/admin_modules/...  -> test-forum/admin/modules/...
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ -d "$FORUM_DIR" ] || die "test-forum/ not found - run scripts/bootstrap.sh first"

rsync -a --delete "$REPO_ROOT/plugin/inc/plugins/events/" "$FORUM_DIR/inc/plugins/events/"
cp "$REPO_ROOT/plugin/inc/plugins/events.php" "$FORUM_DIR/inc/plugins/events.php"
cp "$REPO_ROOT/plugin/inc/tasks/events_reminders.php" "$FORUM_DIR/inc/tasks/events_reminders.php"

cp "$REPO_ROOT"/plugin/root/*.php "$FORUM_DIR/"

mkdir -p "$FORUM_DIR/jscripts/events"
rsync -a --delete "$REPO_ROOT/plugin/root/jscripts/events/" "$FORUM_DIR/jscripts/events/"

mkdir -p "$FORUM_DIR/admin/modules/events"
rsync -a --delete "$REPO_ROOT/plugin/admin_modules/events/" "$FORUM_DIR/admin/modules/events/"

log "Plugin deployed to ${FORUM_DIR}"

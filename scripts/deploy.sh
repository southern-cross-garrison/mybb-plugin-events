#!/usr/bin/env bash
# Deploy the plugin from plugin/ into the MyBB tree at test-forum/.
#
# plugin/ mirrors a MyBB forum root, the way MyBB expects a plugin package to be laid out,
# so deploying is copying it over the top of the forum - exactly what an administrator does
# when uploading it to a real board. The directories the plugin owns outright are synced
# with --delete so a file removed from plugin/ is removed from the forum too; everything
# else (the front-end pages, the task file) is copied in beside MyBB's own files.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ -d "$FORUM_DIR" ] || die "test-forum/ not found - run scripts/bootstrap.sh first"

for owned in inc/plugins/events jscripts/events admin/modules/events; do
    mkdir -p "$FORUM_DIR/$owned"
    rsync -a --delete "$REPO_ROOT/plugin/$owned/" "$FORUM_DIR/$owned/"
done
rsync -a "$REPO_ROOT/plugin/" "$FORUM_DIR/"

log "Plugin deployed to ${FORUM_DIR}"

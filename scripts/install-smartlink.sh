#!/usr/bin/env bash
# Install the Smart Thread Link plugin into test-forum/.
#
# The garrison theme's thread listings link with {$thread['smartlink']} rather than MyBB's
# own {$thread['threadlink']}; that variable comes from this plugin, not from MyBB. A board
# running the theme without it renders every thread subject as <a href=""> - forumdisplay,
# the portal, stats, UserCP and printthread all go unclickable - so it is part of the
# environment, not an optional extra.
#
# Activation happens in scripts/provision.php, alongside the events plugin.
#
# Run standalone to pick up a new commit (bump SMARTLINK_REF in scripts/env.sh first):
#
#   ./scripts/install-smartlink.sh \
#     && dc exec -T web php /dev/stdin < scripts/provision.php \
#     && ./scripts/db-snapshot.sh
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ -d "$FORUM_DIR" ] || die "test-forum/ not found - run scripts/bootstrap.sh first"

mkdir -p "$CACHE_DIR"

if [ ! -d "$SMARTLINK_DIR/.git" ]; then
    log "Cloning the Smart Thread Link plugin from ${SMARTLINK_REPO}"
    rm -rf "$SMARTLINK_DIR"
    git clone --quiet "$SMARTLINK_REPO" "$SMARTLINK_DIR"
fi

git -C "$SMARTLINK_DIR" remote set-url origin "$SMARTLINK_REPO"

# Only hit the network when the pinned ref isn't already in the local clone, so a warm
# cache bootstraps offline.
if ! git -C "$SMARTLINK_DIR" rev-parse --verify --quiet "${SMARTLINK_REF}^{commit}" >/dev/null; then
    log "Fetching Smart Thread Link ref ${SMARTLINK_REF}"
    git -C "$SMARTLINK_DIR" fetch --quiet --tags --force origin
fi

REF="$(git -C "$SMARTLINK_DIR" rev-parse --verify --quiet "origin/${SMARTLINK_REF}^{commit}" \
    || git -C "$SMARTLINK_DIR" rev-parse --verify "${SMARTLINK_REF}^{commit}")" \
    || die "Smart Thread Link ref ${SMARTLINK_REF} not found in ${SMARTLINK_REPO}"

git -C "$SMARTLINK_DIR" checkout --quiet --detach "$REF"

# The repo ships the plugin under the tree it is meant to be unzipped over.
SRC="$SMARTLINK_DIR/forum/inc/plugins/smartlink.php"
[ -f "$SRC" ] || die "smartlink.php not found in the checkout at ${SMARTLINK_DIR}"

cp "$SRC" "$FORUM_DIR/inc/plugins/smartlink.php"

log "Smart Thread Link installed at ${REF}"

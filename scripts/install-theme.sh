#!/usr/bin/env bash
# Import the forum's custom theme into test-forum/ and make it the board default.
#
# Run standalone to pick up a new theme commit (bump THEME_REF in scripts/env.sh first):
#
#   ./scripts/install-theme.sh && ./scripts/db-snapshot.sh
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

[ -d "$FORUM_DIR" ] || die "test-forum/ not found - run scripts/bootstrap.sh first"

"$REPO_ROOT/scripts/fetch-theme.sh"

# The theme's own images live alongside MyBB's in the theme image directory.
if [ -d "$THEME_DIR/images" ]; then
    cp -R "$THEME_DIR/images/." "$FORUM_DIR/images/"
fi

# Only test-forum/ is mounted into the web container, and the PHP importer is piped in on
# stdin, so the XML has to be handed over through the document root.
STAGED="$FORUM_DIR/_theme-import.xml"
cp "$THEME_DIR/$THEME_XML" "$STAGED"

log "Importing the ${THEME_XML%.xml} theme"
if ! dc exec -T web php /dev/stdin < "$REPO_ROOT/scripts/install-theme.php"; then
    rm -f "$STAGED"
    die "theme import failed"
fi
rm -f "$STAGED"

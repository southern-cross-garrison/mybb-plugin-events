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

# Bootstrap and Font Awesome are vendored in the theme rather than linked from a CDN, and
# its templates reference them under the board's own document root. The XML import does not
# carry them: a board with the templates but not these files loses Bootstrap's JavaScript
# entirely, and every data-bs-* control on it - the username dropdown, the mobile navbar
# toggle, the search collapse - goes quietly dead. The tree is wholly theme-owned, so it is
# replaced rather than merged, and a version bump leaves nothing behind.
if [ -d "$THEME_DIR/vendor" ]; then
    rm -rf "$FORUM_DIR/vendor"
    mkdir -p "$FORUM_DIR/vendor"
    cp -R "$THEME_DIR/vendor/." "$FORUM_DIR/vendor/"
    rm -f "$FORUM_DIR/vendor/README.md"
fi

# The theme names its own SCEditor style in the `editortheme` property (`modern-2.css`),
# which is not one of the seven MyBB ships. Both halves of that name are referenced by the
# `codebuttons` template - `jscripts/sceditor/themes/` styles the toolbar, and
# `jscripts/sceditor/styles/` styles the WYSIWYG iframe - so a board with the XML but not
# these files serves two 404s and renders the editor toolbar as a bare list of links.
# Unlike vendor/, this tree is MyBB's, not the theme's: it is merged over, never replaced.
if [ -d "$THEME_DIR/jscripts" ]; then
    cp -R "$THEME_DIR/jscripts/." "$FORUM_DIR/jscripts/"
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

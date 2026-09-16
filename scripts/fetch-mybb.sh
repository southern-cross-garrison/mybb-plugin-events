#!/usr/bin/env bash
# Download and unpack the pinned MyBB release into test-forum/.
# test-forum/ is a disposable build artifact (gitignored) so CI can rebuild it from scratch.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ZIP="$CACHE_DIR/mybb_${MYBB_VERSION}.zip"
mkdir -p "$CACHE_DIR"

if [ ! -f "$ZIP" ]; then
    log "Downloading MyBB ${MYBB_VERSION} from ${MYBB_URL}"
    curl -fsSL -o "$ZIP.tmp" "$MYBB_URL"
    mv "$ZIP.tmp" "$ZIP"
fi

ACTUAL="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
[ "$ACTUAL" = "$MYBB_SHA256" ] || die "MyBB checksum mismatch: expected $MYBB_SHA256, got $ACTUAL"

log "Unpacking MyBB into ${FORUM_DIR}"
rm -rf "$FORUM_DIR" "$CACHE_DIR/unpack"
mkdir -p "$CACHE_DIR/unpack"
unzip -q "$ZIP" 'Upload/*' -d "$CACHE_DIR/unpack"
mv "$CACHE_DIR/unpack/Upload" "$FORUM_DIR"
rm -rf "$CACHE_DIR/unpack"

# MyBB ships config.default.php; the installer writes config.php itself.
chmod -R a+rwX "$FORUM_DIR/cache" "$FORUM_DIR/uploads" "$FORUM_DIR/inc" 2>/dev/null || true
log "MyBB ${MYBB_VERSION} unpacked"

#!/usr/bin/env bash
# Download the pinned SCG custom theme into .devenv/cache/theme.
# Like test-forum/, the checkout is a disposable build artifact - CI caches it alongside
# the MyBB release (the cache key is a hash of this directory's env.sh).
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

mkdir -p "$CACHE_DIR"

if [ ! -d "$THEME_DIR/.git" ]; then
    log "Cloning the custom theme from ${THEME_REPO}"
    rm -rf "$THEME_DIR"
    git clone --quiet "$THEME_REPO" "$THEME_DIR"
fi

git -C "$THEME_DIR" remote set-url origin "$THEME_REPO"

# Only hit the network when the pinned ref isn't already in the local clone, so a warm
# cache bootstraps offline.
if ! git -C "$THEME_DIR" rev-parse --verify --quiet "${THEME_REF}^{commit}" >/dev/null; then
    log "Fetching theme ref ${THEME_REF}"
    git -C "$THEME_DIR" fetch --quiet --tags --force origin
fi

REF="$(git -C "$THEME_DIR" rev-parse --verify --quiet "origin/${THEME_REF}^{commit}" \
    || git -C "$THEME_DIR" rev-parse --verify "${THEME_REF}^{commit}")" \
    || die "theme ref ${THEME_REF} not found in ${THEME_REPO}"

git -C "$THEME_DIR" checkout --quiet --detach "$REF"
[ -f "$THEME_DIR/$THEME_XML" ] || die "${THEME_XML} not found in the theme checkout at ${THEME_DIR}"

log "Theme checked out at ${REF}"

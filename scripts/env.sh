#!/usr/bin/env bash
# Shared configuration for the dev-environment scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
[ -f "$REPO_ROOT/.env" ] && set -a && . "$REPO_ROOT/.env" && set +a

# Kept in step with the MyBB the custom theme is exported from, so the theme imports
# without MyBB's version check having to be waived.
MYBB_VERSION="${MYBB_VERSION:-1840}"
MYBB_SHA256="${MYBB_SHA256:-380fb63c50c63f52c747ba05d1002ad77f2f0b1d254db213092501dd5e9375dc}"
MYBB_URL="https://resources.mybb.com/downloads/mybb_${MYBB_VERSION}.zip"

WEB_PORT="${WEB_PORT:-8080}"
DB_PORT="${DB_PORT:-3307}"
BASE_URL="${BASE_URL:-http://localhost:${WEB_PORT}}"

# The forum's custom theme, imported by scripts/install-theme.sh. Pinned to a commit so
# the provisioned database snapshot is reproducible; override in .env to track a branch.
#
# Currently pinned to the branch behind mybb-custom-theme PR #2, which gives the theme the
# MyBB table classes the plugin's pages are built from, and vendors the SCEditor style its
# `editortheme` property names. Repoint at main once it merges.
THEME_REPO="${THEME_REPO:-https://github.com/southern-cross-garrison/mybb-custom-theme.git}"
THEME_REF="${THEME_REF:-dcfdb15817dc43caf63e184975f9e415f7a4b77d}"
THEME_XML="${THEME_XML:-SCG-Responsive.xml}"

# Smart Thread Link, the companion plugin the custom theme's thread listings need. The
# theme links threads with {$thread['smartlink']}, which is this plugin's variable and not
# one MyBB sets, so a board with the theme but not the plugin renders every thread subject
# on forumdisplay as href="" and nothing in a forum is clickable. Pinned like the theme so
# the provisioned snapshot stays reproducible.
SMARTLINK_REPO="${SMARTLINK_REPO:-https://github.com/southern-cross-garrison/mybb-plugin-smartlink.git}"
SMARTLINK_REF="${SMARTLINK_REF:-734b21eca0b617ea982feec0d994700f3ab48aad}"

FORUM_DIR="$REPO_ROOT/test-forum"
DEVENV_DIR="$REPO_ROOT/.devenv"
CACHE_DIR="$DEVENV_DIR/cache"
THEME_DIR="$CACHE_DIR/theme"
SMARTLINK_DIR="$CACHE_DIR/smartlink"
SNAPSHOT_FILE="$DEVENV_DIR/snapshot.sql"
FAKETIME_FILE="$DEVENV_DIR/faketime/faketime.rc"

DB_NAME="mybb"
DB_USER="mybb"
DB_PASS="mybbpassword"
DB_ROOT_PASS="rootpassword"
TABLE_PREFIX="mybb_"

# Fixture credentials used by both provisioning and the e2e suite.
ADMIN_USER="admin"
ADMIN_PASS="adminpass123"
ADMIN_EMAIL="admin@example.test"

dc() { docker compose "$@"; }

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

#!/usr/bin/env bash
# Shared configuration for the dev-environment scripts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
[ -f "$REPO_ROOT/.env" ] && set -a && . "$REPO_ROOT/.env" && set +a

MYBB_VERSION="${MYBB_VERSION:-1839}"
MYBB_SHA256="${MYBB_SHA256:-04537bc28d924454dbbe6206962a122b3c5c20ffa3b94bec4f5c654a9d01c2cf}"
MYBB_URL="https://resources.mybb.com/downloads/mybb_${MYBB_VERSION}.zip"

WEB_PORT="${WEB_PORT:-8080}"
DB_PORT="${DB_PORT:-3307}"
BASE_URL="${BASE_URL:-http://localhost:${WEB_PORT}}"

FORUM_DIR="$REPO_ROOT/test-forum"
DEVENV_DIR="$REPO_ROOT/.devenv"
CACHE_DIR="$DEVENV_DIR/cache"
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

#!/usr/bin/env bash
# Drive MyBB's web installer non-interactively.
#
# The installer is a plain multi-step form: every step is a POST to install/index.php
# with the previous step's fields, so it can be scripted with curl. Each step is
# checked for the installer's own error markup before moving on.
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

INSTALL_URL="${BASE_URL}/install/index.php"
STEP_OUT="$DEVENV_DIR/install-step.html"
mkdir -p "$DEVENV_DIR"

post_step() {
    local name="$1"; shift
    local code
    code=$(curl -s -o "$STEP_OUT" -w '%{http_code}' -X POST "$INSTALL_URL" "$@")
    [ "$code" = "200" ] || die "installer step '$name' returned HTTP $code"
    # MyBB uses <ul class="error_list"> for real validation errors; a plain
    # class="error" box is also used for informational notices, so match narrowly.
    if grep -qiE 'error_list|Fatal error|MyBB SQL Error|MyBB has experienced' "$STEP_OUT"; then
        sed -e 's/<[^>]*>//g' "$STEP_OUT" | grep -v '^\s*$' | head -30 >&2
        die "installer step '$name' reported an error (full page: $STEP_OUT)"
    fi
}

# A leftover lock from a previous run would refuse the installer outright.
rm -f "$FORUM_DIR/install/lock"

log "Installing MyBB (create_tables)"
post_step create_tables \
    -d 'action=create_tables' \
    -d 'dbengine=mysqli' \
    -d "config[mysqli][dbhost]=db" \
    -d "config[mysqli][dbuser]=${DB_USER}" \
    -d "config[mysqli][dbpass]=${DB_PASS}" \
    -d "config[mysqli][dbname]=${DB_NAME}" \
    -d "config[mysqli][tableprefix]=${TABLE_PREFIX}" \
    -d 'config[mysqli][encoding]=utf8mb4'

log "Installing MyBB (populate_tables)"
post_step populate_tables -d 'action=populate_tables'

log "Installing MyBB (templates)"
post_step templates -d 'action=templates'

log "Installing MyBB (board configuration)"
post_step adminuser \
    -d 'action=adminuser' \
    -d 'bbname=MyBB Events Test Forum' \
    -d "bburl=${BASE_URL}" \
    -d 'websitename=Events Test' \
    -d "websiteurl=${BASE_URL}" \
    -d 'cookiedomain=' \
    -d 'cookiepath=/' \
    -d "contactemail=${ADMIN_EMAIL}"

log "Installing MyBB (admin user)"
post_step final \
    -d 'action=final' \
    -d "adminuser=${ADMIN_USER}" \
    -d "adminemail=${ADMIN_EMAIL}" \
    -d "adminpass=${ADMIN_PASS}" \
    -d "adminpass2=${ADMIN_PASS}"

# The installer locks itself once finished; make sure it did so we do not leave an
# open installer behind in a long-lived dev environment.
[ -f "$FORUM_DIR/install/lock" ] || echo 1 > "$FORUM_DIR/install/lock"

log "MyBB installed"

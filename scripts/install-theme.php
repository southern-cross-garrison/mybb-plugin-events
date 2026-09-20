<?php
/**
 * Imports the forum's custom theme into the test forum and makes it the board default,
 * through MyBB's own theme import code path (admin/inc/functions_themes.php), so the
 * result matches what an admin gets from ACP > Templates & Style > Import a Theme.
 *
 * scripts/install-theme.sh stages the XML at MYBB_ROOT/_theme-import.xml (only test-forum/
 * is mounted into the web container) and runs this file:
 *
 *   docker compose exec -T web php /dev/stdin < scripts/install-theme.php
 *
 * Idempotent: an existing theme of the same name - and its template set - is removed
 * first, so re-running never leaves orphaned template sets behind.
 */

define('IN_MYBB', 1);
define('MYBB_ROOT', '/var/www/html/');
define('THIS_SCRIPT', 'install-theme.php');
define('NO_ONLINE', 1);

require_once MYBB_ROOT . 'inc/init.php';

// Surface the failing query when something goes wrong during the import.
$mybb->dev_mode = 1;

// import_theme_xml() and its helpers live in the ACP's function library. They are plain
// function definitions - including them does not pull in any admin session handling.
require_once MYBB_ROOT . 'inc/class_xml.php';
require_once MYBB_ROOT . 'admin/inc/functions.php';
require_once MYBB_ROOT . 'admin/inc/functions_themes.php';

/** @var DB_MySQLi $db */
/** @var MyBB $mybb */
/** @var datacache $cache */

function out($msg) { echo "    " . $msg . "\n"; }
function fail($msg) { fwrite(STDERR, "THEME ERROR: " . $msg . "\n"); exit(1); }

$xml_file = MYBB_ROOT . '_theme-import.xml';
if (!file_exists($xml_file)) {
    fail("no theme XML staged at {$xml_file} - run scripts/install-theme.sh");
}
$xml = file_get_contents($xml_file);

if (!preg_match('/<theme\s[^>]*name="([^"]+)"/', $xml, $match)) {
    fail('could not read the theme name from the XML');
}
$name = $match[1];

// ---------------------------------------------------------------------------
// Drop any previous copy of this theme so re-running is a clean replace
// ---------------------------------------------------------------------------
$existing = $db->fetch_array($db->simple_select('themes', 'tid, properties', "name = '" . $db->escape_string($name) . "'"));
if ($existing) {
    $tid = (int)$existing['tid'];
    $properties = my_unserialize($existing['properties']);

    // import_theme_xml() always creates a fresh template set, so the old one would be
    // left dangling in ACP > Templates otherwise.
    if (!empty($properties['templateset'])) {
        $sid = (int)$properties['templateset'];
        $db->delete_query('templates', "sid = {$sid}");
        $db->delete_query('templatesets', "sid = {$sid}");
    }

    $db->delete_query('themestylesheets', "tid = {$tid}");
    $db->delete_query('themes', "tid = {$tid}");
    $db->update_query('users', array('style' => 0), "style = {$tid}");

    foreach ((array)glob(MYBB_ROOT . "cache/themes/theme{$tid}/*") as $cached) {
        @unlink($cached);
    }
    @rmdir(MYBB_ROOT . "cache/themes/theme{$tid}");

    out("removed the previous '{$name}' theme (tid {$tid})");
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
// MyBB's version check is left on: MYBB_VERSION in scripts/env.sh is pinned to the release
// the theme is exported from, so a mismatch means the two have drifted apart and should be
// looked at rather than waved through.
$theme_id = import_theme_xml($xml, array(
    // Inherit from MyBB Master Style (tid 1), the same parent the ACP importer defaults to.
    'parent' => 1,
    // Passed explicitly: import_theme_xml() reads this key unguarded on the mismatch path.
    'version_compat' => 0,
));

if ($theme_id <= 0) {
    preg_match('/<theme\s[^>]*version="([^"]+)"/', $xml, $version_match);
    $theme_version = isset($version_match[1]) ? $version_match[1] : 'unknown';

    $reasons = array(
        -1 => 'the XML could not be parsed',
        -2 => "the theme targets MyBB {$theme_version} but this forum is {$mybb->version_code}"
              . ' - bump MYBB_VERSION in scripts/env.sh to match, or re-export the theme',
        -3 => 'a theme with that name already exists',
        -4 => 'MyBB\'s template security check rejected one of the templates',
    );
    fail("import failed: " . (isset($reasons[$theme_id]) ? $reasons[$theme_id] : "unknown error {$theme_id}"));
}
out("imported '{$name}' as tid {$theme_id}");

// ---------------------------------------------------------------------------
// Make it the board default
// ---------------------------------------------------------------------------
$db->update_query('themes', array('def' => 0));
$db->update_query('themes', array('def' => 1), "tid = " . (int)$theme_id);

// A user style of 0 means "follow the board default". Fixture users are created that way,
// but reset everyone so the suite never renders a stale theme.
$db->update_query('users', array('style' => 0));

$cache->update('default_theme', $db->fetch_array($db->simple_select('themes', '*', "tid = " . (int)$theme_id)));

out("'{$name}' set as the default theme");

@unlink($xml_file);

echo "THEME OK\n";

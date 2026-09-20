<?php
/**
 * MyBB Event Plugin - Stylesheet installation
 *
 * The plugin's CSS lives as a .css file under events/stylesheets/ so it can be edited in
 * the repo, but MyBB serves stylesheets out of the `themestylesheets` table. These helpers
 * sync the file into the master theme (tid 1), which every other theme inherits from.
 *
 * Installing it as a real theme stylesheet - rather than inlining a <style> block into the
 * templates - is what lets a theme skin the plugin: an inherited stylesheet shows up in
 * ACP > Templates & Style > Themes like any other, and a theme that edits its copy (or
 * ships one in its export) takes over from the plugin's default without touching it.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

define('EVENTS_STYLESHEET', 'events.css');

// The pages the stylesheet is loaded on, matched by MyBB against THIS_SCRIPT. The
// attendance sheet and the coordinator RSVP list are actions on event.php, so they are
// covered by it; ical.php renders no HTML.
define('EVENTS_STYLESHEET_ATTACHEDTO', 'events.php|event.php|manage_event.php|rsvp.php|troop_report.php');

/** The theme every other theme inherits from. */
define('EVENTS_MASTER_THEME', 1);

/**
 * Install (or refresh) the plugin's stylesheet on the master theme.
 *
 * Safe to call repeatedly - the existing row is updated in place, so editing the .css file
 * and re-activating the plugin picks the change up, exactly like the templates.
 */
function events_install_stylesheet()
{
    global $db;

    // update_theme_stylesheet_list() and cache_stylesheet() are ACP functions. The plugin is
    // normally installed from the Admin CP, where they are already loaded, but provisioning
    // scripts call events_activate() from the CLI, so pull them in either way.
    require_once MYBB_ROOT . "admin/inc/functions_themes.php";

    $css = file_get_contents(MYBB_ROOT . "inc/plugins/events/stylesheets/" . EVENTS_STYLESHEET);
    if($css === false)
    {
        return;
    }

    $row = array(
        "name"         => $db->escape_string(EVENTS_STYLESHEET),
        "tid"          => EVENTS_MASTER_THEME,
        "attachedto"   => $db->escape_string(EVENTS_STYLESHEET_ATTACHEDTO),
        "stylesheet"   => $db->escape_string($css),
        "cachefile"    => $db->escape_string(EVENTS_STYLESHEET),
        "lastmodified" => TIME_NOW
    );

    $existing = $db->fetch_array($db->simple_select("themestylesheets", "sid",
        "name = '" . $db->escape_string(EVENTS_STYLESHEET) . "' AND tid = " . EVENTS_MASTER_THEME));

    if($existing)
    {
        $db->update_query("themestylesheets", $row, "sid = " . (int)$existing['sid']);
    }
    else
    {
        $db->insert_query("themestylesheets", $row);
    }

    // Write the flat cache file MyBB serves in preference to css.php, then rebuild the
    // per-theme stylesheet lists. That is what adds the sheet to each theme's display
    // order - a stylesheet missing from disporder is silently never output.
    cache_stylesheet(EVENTS_MASTER_THEME, EVENTS_STYLESHEET, $css);
    update_theme_stylesheet_list(EVENTS_MASTER_THEME, false, true);
}

/**
 * Remove the plugin's stylesheet, including any theme's customised copy of it.
 */
function events_uninstall_stylesheet()
{
    global $db;

    require_once MYBB_ROOT . "admin/inc/functions_themes.php";

    $query = $db->simple_select("themestylesheets", "tid", "name = '" . $db->escape_string(EVENTS_STYLESHEET) . "'");
    while($sheet = $db->fetch_array($query))
    {
        @unlink(MYBB_ROOT . "cache/themes/theme" . (int)$sheet['tid'] . "/" . EVENTS_STYLESHEET);
        @unlink(MYBB_ROOT . "cache/themes/theme" . (int)$sheet['tid'] . "/" . str_replace('.css', '.min.css', EVENTS_STYLESHEET));
    }

    $db->delete_query("themestylesheets", "name = '" . $db->escape_string(EVENTS_STYLESHEET) . "'");

    update_theme_stylesheet_list(EVENTS_MASTER_THEME, false, true);
}

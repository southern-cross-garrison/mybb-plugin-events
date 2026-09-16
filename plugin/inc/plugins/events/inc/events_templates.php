<?php
/**
 * MyBB Event Plugin - Template installation
 *
 * The plugin's templates live as .html files under events/templates/ so they can be
 * edited in the repo, but MyBB renders templates out of the `templates` table. These
 * helpers sync the files into the master template set (sid = -2), which is what
 * $templates->get() falls back to when a theme has no override.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

define('EVENTS_TEMPLATE_PREFIX', 'events_');

/**
 * Read the plugin's template files from disk.
 *
 * @return array title => template body
 */
function events_get_template_files()
{
    $templates = array();
    $dir = MYBB_ROOT . "inc/plugins/events/templates/";

    foreach((array)glob($dir . "*.html") as $file)
    {
        $title = basename($file, ".html");
        $templates[$title] = file_get_contents($file);
    }

    return $templates;
}

/**
 * Install (or refresh) the plugin's templates and their ACP template group.
 *
 * Safe to call repeatedly - existing master templates are replaced so that editing a
 * .html file and re-activating the plugin picks up the change.
 */
function events_install_templates()
{
    global $db, $mybb;

    $group = $db->fetch_array($db->simple_select("templategroups", "gid", "prefix = '" . EVENTS_TEMPLATE_PREFIX . "'"));
    if(!$group)
    {
        $db->insert_query("templategroups", array(
            "prefix" => EVENTS_TEMPLATE_PREFIX,
            "title"  => "Event Management",
            "isdefault" => 0
        ));
    }

    foreach(events_get_template_files() as $title => $template)
    {
        $row = array(
            "title"    => $db->escape_string($title),
            "template" => $db->escape_string($template),
            "sid"      => -2,
            "version"  => $db->escape_string($mybb->version_code),
            "status"   => "",
            "dateline" => TIME_NOW
        );

        $existing = $db->fetch_array($db->simple_select("templates", "tid", "title = '" . $db->escape_string($title) . "' AND sid = -2"));
        if($existing)
        {
            $db->update_query("templates", $row, "tid = " . (int)$existing['tid']);
        }
        else
        {
            $db->insert_query("templates", $row);
        }
    }
}

/**
 * Remove the plugin's templates, including any theme-level customisations of them.
 */
function events_uninstall_templates()
{
    global $db;

    $titles = array_keys(events_get_template_files());
    if(!empty($titles))
    {
        $escaped = array();
        foreach($titles as $title)
        {
            $escaped[] = "'" . $db->escape_string($title) . "'";
        }
        $db->delete_query("templates", "title IN (" . implode(",", $escaped) . ")");
    }

    // Catch templates from older versions of the plugin that no longer ship a file.
    $db->delete_query("templates", "title LIKE '" . $db->escape_string(EVENTS_TEMPLATE_PREFIX) . "%'");
    $db->delete_query("templategroups", "prefix = '" . EVENTS_TEMPLATE_PREFIX . "'");
}

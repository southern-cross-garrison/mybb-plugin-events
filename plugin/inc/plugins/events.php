<?php
/**
 * MyBB Event Management Plugin
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_hooks.php";

// Registered in both contexts: members are deleted from the Admin CP, but also by the
// user-pruning task, which runs from whatever front-end page view happens to trigger it.
global $plugins;
$plugins->add_hook("datahandler_user_delete_end", "events_user_deleted");

if(defined('IN_ADMINCP'))
{
    global $plugins;

    // Keep the profile-field dropdowns on the settings page in step with the board's
    // custom profile fields. These have to be registered in admin context.
    $plugins->add_hook("admin_config_profile_fields_add_commit", "events_rebuild_profile_field_dropdowns");
    $plugins->add_hook("admin_config_profile_fields_edit_commit", "events_rebuild_profile_field_dropdowns");
    $plugins->add_hook("admin_config_profile_fields_delete_commit", "events_rebuild_profile_field_dropdowns");

    // Event changes are written to the administrator log; this words them there.
    $plugins->add_hook("admin_tools_get_admin_log_action", "events_admin_log_action");
}
else
{
    // MyBB includes active plugin files on every request, so this is where front-end
    // hooks belong - registering them in events_activate() would only run once.
    events_register_hooks();
}

/**
 * Plugin information.
 *
 * @return array
 */
function events_info()
{
    return array(
        "name"          => "Event Management",
        "description"   => "Comprehensive event management system with RSVP tracking, prerequisite validation, multi-day support, attendance sheets, and automated troop report generation.",
        "website"       => "https://github.com/southern-cross-garrison/mybb-plugin-events",
        "author"        => "Kevin Brown (TK-33151)",
        "authorsite"    => "https://www.501scg.org/",
        "version"       => "1.2",
        "guid"          => "aa8e5870-f198-467f-a67a-0726e9690efc",
        "codename"      => "events",
        "compatibility" => "18*"
    );
}

/**
 * The settings that are rendered as a custom-profile-field picker.
 *
 * @return array
 */
function events_profile_field_settings()
{
    return array(
        'events_costume_field',
        'events_tk_id_field',
        'events_wwcc_field',
        'events_mobile_field',
        'events_emergency_contact_field',
        'events_preferred_name_field',
    );
}

/**
 * @return bool
 */
function events_is_installed()
{
    global $db;

    return $db->table_exists('event_plugin_events');
}

/**
 * Create the plugin's tables, settings and templates.
 */
function events_install()
{
    global $db;

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_install.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_templates.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_stylesheets.php";

    // The baseline schema, then every upgrade since - the same steps an installed board
    // takes on activation.
    events_install_database();
    events_upgrade_database();
    events_install_templates();
    events_install_stylesheet();

    events_install_settings();
}

/**
 * Create any of the plugin's settings the board does not have yet.
 *
 * Called from both install and activate. MyBB gives plugins no upgrade hook, so a
 * setting added in a later version would otherwise never reach a board that already has
 * the plugin installed - the same reason events_upgrade_database() runs on activation.
 * Existing settings are left alone, values and all.
 */
function events_install_settings()
{
    global $db;

    // For EVENTS_DEFAULT_REGIONS, EVENTS_DEFAULT_TIMEZONE and EVENTS_DEFAULT_WWCC_NAME.
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

    $query = $db->simple_select("settinggroups", "gid", "name = 'events'");
    if($db->num_rows($query) == 0)
    {
        $db->insert_query("settinggroups", array(
            "name"        => "events",
            "title"       => $db->escape_string("Event Management Settings"),
            "description" => $db->escape_string("Configure the event management plugin"),
            "disporder"   => 5,
            "isdefault"   => 0
        ));
        $gid = $db->insert_id();
    }
    else
    {
        $group = $db->fetch_array($query);
        $gid = $group['gid'];
    }

    // The garrison group setting used to be named after one particular garrison. Rename
    // it in place rather than inserting the new name alongside it, so a board that has
    // already pointed it at a group keeps that group instead of silently reverting to
    // "no garrison" on the next activation.
    if($db->num_rows($db->simple_select("settings", "sid", "name = 'events_scg_members_group'")) > 0
        && $db->num_rows($db->simple_select("settings", "sid", "name = 'events_garrison_members_group'")) == 0)
    {
        $db->update_query("settings",
            array("name" => "events_garrison_members_group"),
            "name = 'events_scg_members_group'");
    }

    $settings = array(
        array("name" => "events_costume_field", "title" => "Costume Profile Field", "description" => "The custom profile field that holds a member's costumes", "optionscode" => "text", "disporder" => 1),
        array("name" => "events_tk_id_field", "title" => "TK ID Profile Field", "description" => "The custom profile field that holds a member's TK ID", "optionscode" => "text", "disporder" => 2),
        array("name" => "events_wwcc_field", "title" => "WWCC Profile Field", "description" => "The custom profile field that holds a member's WWCC number", "optionscode" => "text", "disporder" => 3),
        array("name" => "events_mobile_field", "title" => "Mobile Number Profile Field", "description" => "The custom profile field that holds a member's mobile number", "optionscode" => "text", "disporder" => 4),
        array("name" => "events_emergency_contact_field", "title" => "Emergency Contact Profile Field", "description" => "The custom profile field that holds a member's emergency contact", "optionscode" => "text", "disporder" => 5),
        array("name" => "events_event_coordinator_groups", "title" => "Event Coordinator User Groups", "description" => "User groups that may coordinate events. Their members are what the Coordinator dropdown on an event is drawn from.", "optionscode" => "groupselect", "disporder" => 6),
        array("name" => "events_garrison_members_group", "title" => "Garrison Members Group", "description" => "Used to segment attendees on the troop report", "optionscode" => "groupselectsingle", "disporder" => 7),
        array("name" => "events_501st_members_group", "title" => "501st Members Group", "description" => "Used to segment attendees on the troop report", "optionscode" => "groupselectsingle", "disporder" => 8),
        array("name" => "events_troop_report_forum", "title" => "Troop Report Forum", "description" => "The forum troop reports are posted to", "optionscode" => "forumselectsingle", "disporder" => 9),
        array("name" => "events_event_forum", "title" => "Default Event Forum", "description" => "The forum an event's announcement thread is posted to when its region has no forum of its own", "optionscode" => "forumselectsingle", "disporder" => 10),
        array("name" => "events_event_forums", "title" => "Event Forums by Region", "description" => "Which forum each region's events are announced in, as a comma separated list of Region=forum id pairs. Set it in Admin CP -> Event Management -> Settings rather than here.", "optionscode" => "text", "disporder" => 11),
        array("name" => "events_regions", "title" => "Regions", "description" => "The regions an event can belong to, as a comma separated list. Set it in Admin CP -> Event Management -> Settings rather than here - removing a region there also rehomes the events that were in it, and removing it here would leave them pointing at a region that no longer exists.", "optionscode" => "text", "disporder" => 13, "value" => EVENTS_DEFAULT_REGIONS),
        array("name" => "events_print_logo", "title" => "Print Logo", "description" => "Shown in the ribbon at the top of printed pages. A URL, or a path relative to the board root (e.g. images/logo.png). Leave blank to fall back to the theme's own logo.", "optionscode" => "text", "disporder" => 12),
        // Numbered after the settings that shipped before it rather than beside the other
        // profile-field pickers: the install loop leaves an existing setting alone, so
        // renumbering the rest here would only ever reorder a fresh board's list and leave
        // every board that already has these settings in the old order.
        array("name" => "events_preferred_name_field", "title" => "Preferred Name Profile Field", "description" => "The custom profile field that holds the name a member goes by on the day", "optionscode" => "text", "disporder" => 15),
        array("name" => "events_wwcc_enabled", "title" => "Working With Children Checks", "description" => "Whether an event can require its attendees to have a working with children check on file", "optionscode" => "yesno", "disporder" => 16, "value" => "1"),
        array("name" => "events_wwcc_name", "title" => "Working With Children Check Name", "description" => "What the check is called where the garrison is, e.g. Blue Card in Queensland", "optionscode" => "text", "disporder" => 17, "value" => EVENTS_DEFAULT_WWCC_NAME),
        array("name" => "events_timezone", "title" => "Event Timezone", "description" => "Where the garrison is, not where the forum is hosted: every event date is entered, stored and shown in this zone, and the server's own timezone is ignored. A PHP timezone identifier such as Australia/Sydney. Pick it from the list in Admin CP -> Event Management -> Settings rather than typing it here - a name PHP does not recognise falls back to UTC.", "optionscode" => "text", "disporder" => 14, "value" => EVENTS_DEFAULT_TIMEZONE),
    );

    foreach($settings as $setting)
    {
        if($db->num_rows($db->simple_select("settings", "sid", "name = '" . $db->escape_string($setting['name']) . "'")) > 0)
        {
            continue;
        }

        // insert_query() quotes values but does not escape them.
        $row = array(
            'name'        => $db->escape_string($setting['name']),
            'title'       => $db->escape_string($setting['title']),
            'description' => $db->escape_string($setting['description']),
            'optionscode' => $db->escape_string($setting['optionscode']),
            'disporder'   => (int)$setting['disporder'],
            'gid'         => (int)$gid,
            // Most settings start empty and are pointed at board data on provisioning.
            // A setting whose value is a list the plugin ships with needs that list on
            // the first install, or the board comes up with none of them.
            'value'       => isset($setting['value']) ? $db->escape_string($setting['value']) : '',
        );

        $db->insert_query("settings", $row);
    }

    rebuild_settings();
}

/**
 * Build the optionscode for a profile-field picker setting.
 *
 * @return string
 */
function events_build_profile_field_optionscode()
{
    global $db;

    $optionscode = "select\n=None\n";

    $query = $db->simple_select("profilefields", "fid, name", "", array("order_by" => "name", "order_dir" => "ASC"));
    while($field = $db->fetch_array($query))
    {
        $name = str_replace(array('=', "\n", "\r"), '', $field['name']);
        $optionscode .= $field['fid'] . "=" . $name . "\n";
    }

    return rtrim($optionscode);
}

/**
 * Activate: refresh templates and settings that depend on board data, and register
 * the scheduled task.
 */
function events_activate()
{
    global $db;

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_install.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_templates.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_stylesheets.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_tasks.php";

    // MyBB has no upgrade hook, so schema changes land here - _install() only ever runs
    // once, on a board that has no tables yet.
    events_upgrade_database();

    // Re-sync templates so editing a .html file and re-activating picks up the change.
    events_install_templates();
    events_install_stylesheet();
    events_install_settings();
    events_register_task();

    $optionscode = events_build_profile_field_optionscode();
    foreach(events_profile_field_settings() as $setting_name)
    {
        $db->update_query("settings",
            array("optionscode" => $db->escape_string($optionscode)),
            "name = '" . $db->escape_string($setting_name) . "'");
    }

    $group_settings = array(
        'events_event_coordinator_groups' => 'groupselect',
        'events_garrison_members_group'        => 'groupselectsingle',
        'events_501st_members_group'      => 'groupselectsingle',
        'events_troop_report_forum'       => 'forumselectsingle',
        'events_event_forum'              => 'forumselectsingle',
    );

    foreach($group_settings as $setting_name => $optionscode)
    {
        $db->update_query("settings",
            array("optionscode" => $db->escape_string($optionscode)),
            "name = '" . $db->escape_string($setting_name) . "'");
    }

    rebuild_settings();
}

/**
 * Deactivate: hooks are registered per-request so there is nothing to unregister,
 * but the scheduled task should stop running.
 */
function events_deactivate()
{
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_tasks.php";

    events_unregister_task();
}

/**
 * Remove every trace of the plugin.
 */
function events_uninstall()
{
    global $db;

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_uninstall.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_templates.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_stylesheets.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_tasks.php";

    events_uninstall_database();
    events_uninstall_templates();
    events_uninstall_stylesheet();
    events_unregister_task();

    rebuild_settings();
}

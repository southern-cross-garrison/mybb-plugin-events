<?php
/**
 * MyBB Event Management Plugin
 * 
 * Plugin Information
 */

// Disallow direct access to this file for security reasons
if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

// Plugin information
function events_info()
{
    return array(
        "name"          => "Event Management",
        "description"   => "Comprehensive event management system with RSVP tracking, prerequisite validation, multi-day support, attendance sheets, and automated troop report generation.",
        "website"       => "https://github.com/southern-cross-garrison/mybb-plugin-events",
        "author"        => "Kevin Brown (TK-33151)",
        "authorsite"    => "https://www.501scg.org/",
        "version"       => "1.0",
        "guid"          => "aa8e5870-f198-467f-a67a-0726e9690efc",
        "codename"      => "events",
        "compatibility" => "18*"
    );
}

/**
 * Check if plugin is installed
 */
function events_is_installed()
{
    global $db;
    
    // Check if main table exists (reliable indicator of installation)
    return $db->table_exists('event_plugin_events');
}

/**
 * Plugin installation
 */
function events_install()
{
    global $db;
    
    // Install database tables
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_install.php";
    events_install();
    
    // Create settings group (check first to avoid duplicates)
    $query = $db->simple_select("settinggroups", "gid", "name = 'events'");
    if($db->num_rows($query) == 0)
    {
        $setting_group = array(
            "name" => "events",
            "title" => "Event Management Settings",
            "description" => "Configure the event management plugin",
            "disporder" => 5,
            "isdefault" => 0
        );
        $db->insert_query("settinggroups", $setting_group);
        $gid = $db->insert_id();
    }
    else
    {
        $group = $db->fetch_array($query);
        $gid = $group['gid'];
    }
    
    // Add settings (check each one before inserting)
    $settings = array(
        array(
            "name" => "events_costume_field",
            "title" => "Costume Profile Field",
            "description" => "Select the custom profile field that contains user costumes",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 1,
            "gid" => $gid
        ),
        array(
            "name" => "events_tk_id_field",
            "title" => "TK ID Profile Field",
            "description" => "Select the custom profile field that contains TK IDs",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 2,
            "gid" => $gid
        ),
        array(
            "name" => "events_wwcc_field",
            "title" => "WWCC Profile Field",
            "description" => "Select the custom profile field that contains WWCC numbers",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 3,
            "gid" => $gid
        ),
        array(
            "name" => "events_mobile_field",
            "title" => "Mobile Number Profile Field",
            "description" => "Select the custom profile field that contains mobile numbers",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 4,
            "gid" => $gid
        ),
        array(
            "name" => "events_emergency_contact_field",
            "title" => "Emergency Contact Profile Field",
            "description" => "Select the custom profile field that contains emergency contact information",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 5,
            "gid" => $gid
        ),
        array(
            "name" => "events_gec_groups",
            "title" => "GEC User Groups",
            "description" => "Comma-separated list of user group IDs that have GEC permissions",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 6,
            "gid" => $gid
        ),
        array(
            "name" => "events_scg_members_group",
            "title" => "SCG Members Group ID",
            "description" => "User group ID for SCG Members (required for TK ID validation)",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 7,
            "gid" => $gid
        ),
        array(
            "name" => "events_501st_members_group",
            "title" => "501st Members Group ID",
            "description" => "User group ID for 501st Members (required for TK ID validation)",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 8,
            "gid" => $gid
        ),
        array(
            "name" => "events_troop_report_forum",
            "title" => "Troop Report Forum ID",
            "description" => "Forum ID where troop reports should be posted",
            "optionscode" => "text",
            "value" => "",
            "disporder" => 9,
            "gid" => $gid
        )
    );
    
    foreach($settings as $setting)
    {
        // Check if setting already exists
        $check_query = $db->simple_select("settings", "sid", "name = '" . $db->escape_string($setting['name']) . "'");
        if($db->num_rows($check_query) == 0)
        {
            $db->insert_query("settings", $setting);
        }
    }
    
    // Rebuild settings cache
    rebuild_settings();
    
    // Note: Admin menu items are added via admin module files (module_meta.php), not database inserts
    // The admin menu for this plugin should be added in plugin/inc/plugins/events/admin/module_meta.php
}

/**
 * Plugin activation
 */
function events_activate()
{
    // Register hooks
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_hooks.php";
    events_register_hooks();
    
    // Register scheduled task
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_tasks.php";
    events_register_task();
}

/**
 * Plugin deactivation
 */
function events_deactivate()
{
    global $plugins;
    
    // Remove hooks
    $plugins->remove_hook("global_start", "events_nav_menu");
    $plugins->remove_hook("member_profile_end", "events_profile_display");
    $plugins->remove_hook("showthread_start", "events_thread_display");
    $plugins->remove_hook("task_events_reminders", "events_send_reminders");
    
    // Note: Admin menu items are managed via module_meta.php files, not database
}

/**
 * Plugin uninstallation
 */
function events_uninstall()
{
    global $db;
    
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_uninstall.php";
    
    // Uninstall database
    events_uninstall();
    
    // Remove scheduled task
    $db->delete_query("tasks", "file = 'events_reminders'");
    
    // Note: Admin menu items are managed via module_meta.php files, not database
}

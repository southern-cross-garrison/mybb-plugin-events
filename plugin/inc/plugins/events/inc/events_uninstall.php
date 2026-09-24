<?php
/**
 * MyBB Event Plugin - Database Uninstallation
 * 
 * Removes all database tables created by the plugin
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

function events_uninstall_database()
{
    global $db;
    
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_install.php";

    // Drop all tables
    foreach(events_plugin_tables() as $table)
    {
        $db->write_query("DROP TABLE IF EXISTS `" . TABLE_PREFIX . $table . "`");
    }
    
    // Remove plugin settings
    $db->delete_query("settings", "name LIKE 'events_%'");
    $db->delete_query("settinggroups", "name = 'events'");
}

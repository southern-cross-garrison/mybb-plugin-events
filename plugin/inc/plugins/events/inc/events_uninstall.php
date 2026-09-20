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
    
    // Drop all tables
    $tables = array(
        'event_plugin_events',
        'event_plugin_event_days',
        'event_plugin_event_exclusions',
        'event_plugin_rsvps',
        'event_plugin_rsvp_days',
        'event_plugin_rsvp_costumes',
        'event_plugin_troop_reports',
        'event_plugin_user_prefs'
    );
    
    foreach($tables as $table)
    {
        $db->write_query("DROP TABLE IF EXISTS `" . TABLE_PREFIX . $table . "`");
    }
    
    // Remove plugin settings
    $db->delete_query("settings", "name LIKE 'events_%'");
    $db->delete_query("settinggroups", "name = 'events'");
}

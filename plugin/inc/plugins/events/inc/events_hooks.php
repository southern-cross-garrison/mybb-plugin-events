<?php
/**
 * MyBB Event Plugin - Hooks Registration
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Register all plugin hooks
 */
function events_register_hooks()
{
    global $plugins;
    
    // Navigation menu
    $plugins->add_hook("global_start", "events_nav_menu");
    
    // User profile display
    $plugins->add_hook("member_profile_end", "events_profile_display");
    
    // Thread integration
    $plugins->add_hook("showthread_start", "events_thread_display");
    
    // Scheduled task
    $plugins->add_hook("task_events_reminders", "events_send_reminders");
    
    // Rebuild profile field dropdowns when profile fields are added, edited, or deleted
    $plugins->add_hook("admin_config_profile_fields_add_commit", "events_rebuild_profile_field_dropdowns");
    $plugins->add_hook("admin_config_profile_fields_edit_commit", "events_rebuild_profile_field_dropdowns");
    $plugins->add_hook("admin_config_profile_fields_delete_commit", "events_rebuild_profile_field_dropdowns");
}

/**
 * Add Events link to navigation menu
 */
function events_nav_menu()
{
    global $templates, $mybb, $nav_events;
    
    if(!isset($nav_events))
    {
        $nav_events = '';
    }
    
    $nav_events .= '<li><a href="' . $mybb->settings['bburl'] . '/events.php">Events</a></li>';
}

/**
 * Display event info on user profile
 */
function events_profile_display()
{
    global $memprofile, $db;
    
    // Get user's RSVP history (could add this later)
}

/**
 * Display event info in thread if linked
 */
function events_thread_display()
{
    global $tid, $db, $event_info;
    
    $query = $db->simple_select("event_plugin_events", "*", "thread_id = " . (int)$tid);
    $event = $db->fetch_array($query);
    
    if($event)
    {
        $event_info = $event;
    }
}

/**
 * Send reminder PMs for incomplete troop reports
 */
function events_send_reminders()
{
    global $db, $mybb;
    
    require_once MYBB_ROOT . "inc/datahandlers/pm.php";
    
    // Find events that need reminders
    $cutoff_date = date('Y-m-d H:i:s', strtotime('-7 days'));
    
    $query = $db->query("
        SELECT e.*, tr.last_reminder_sent
        FROM " . TABLE_PREFIX . "event_plugin_events e
        LEFT JOIN " . TABLE_PREFIX . "event_plugin_troop_reports tr ON e.id = tr.event_id
        WHERE e.status = 'live'
        AND e.end_date < NOW()
        AND (tr.id IS NULL OR tr.posted_at IS NULL)
        AND (tr.last_reminder_sent IS NULL OR tr.last_reminder_sent < '{$cutoff_date}')
    ");
    
    while($event = $db->fetch_array($query))
    {
        // Get all RSVPs for this event
        $rsvp_query = $db->simple_select("event_plugin_rsvps", "user_id", 
            "event_id = " . (int)$event['id'] . " AND status = 'attending'");
        
        $user_ids = array();
        while($rsvp = $db->fetch_array($rsvp_query))
        {
            $user_ids[] = $rsvp['user_id'];
        }
        
        if(empty($user_ids))
        {
            continue;
        }
        
        // Send PM to all attendees
        $pmhandler = new PMDataHandler();
        $pm = array(
            'subject' => "Troop Report Needed: " . $event['title'],
            'message' => "The event '" . $event['title'] . "' has finished, but no troop report has been created yet.\n\n" .
                        "Please create a troop report: " . $mybb->settings['bburl'] . "/troop_report.php?id=" . $event['id'],
            'fromid' => 0, // System message
            'toid' => $user_ids
        );
        
        $pmhandler->set_data($pm);
        
        if($pmhandler->validate_pm())
        {
            $pmhandler->insert_pm();
        }
        
        // Update last reminder sent
        if(isset($event['last_reminder_sent']) && $event['last_reminder_sent'])
        {
            $db->update_query("event_plugin_troop_reports", 
                array('last_reminder_sent' => date('Y-m-d H:i:s')),
                "event_id = " . (int)$event['id']);
        }
        else
        {
            $db->insert_query("event_plugin_troop_reports", array(
                'event_id' => $event['id'],
                'created_by' => 0,
                'created_at' => date('Y-m-d H:i:s'),
                'last_reminder_sent' => date('Y-m-d H:i:s')
            ));
        }
    }
}

/**
 * Rebuild profile field dropdowns when profile fields are added, edited, or deleted
 * This ensures the dropdown menus stay up-to-date with available profile fields
 * 
 * Hook names (verified from MyBB source):
 * - admin_config_profile_fields_add_commit (fires after profile field is added)
 * - admin_config_profile_fields_edit_commit (fires after profile field is edited)
 * - admin_config_profile_fields_delete_commit (fires after profile field is deleted)
 */
function events_rebuild_profile_field_dropdowns()
{
    global $db;
    
    // List of settings that should be profile field dropdowns
    $profile_field_settings = array(
        'events_costume_field',
        'events_tk_id_field',
        'events_wwcc_field',
        'events_mobile_field',
        'events_emergency_contact_field'
    );
    
    // Get all custom profile fields
    $profile_fields = array();
    $query = $db->simple_select("profilefields", "fid, name", "", array("order_by" => "name", "order_dir" => "ASC"));
    while($field = $db->fetch_array($query))
    {
        $profile_fields[$field['fid']] = $field['name'];
    }
    
    // Build optionscode string for select dropdown
    // Format: select\nkey1=Value1\nkey2=Value2
    $optionscode = "select\n";
    $optionscode .= "=None\n"; // Add "None" option (empty value)
    
    foreach($profile_fields as $fid => $name)
    {
        // Escape special characters in the name
        $name = str_replace(array('=', "\n", "\r"), array('', '', ''), $name);
        $optionscode .= $fid . "=" . $name . "\n";
    }
    
    // Remove trailing newline
    $optionscode = rtrim($optionscode);
    
    // Update each profile field setting
    foreach($profile_field_settings as $setting_name)
    {
        $db->update_query("settings", 
            array("optionscode" => $db->escape_string($optionscode)),
            "name = '" . $db->escape_string($setting_name) . "'");
    }
    
    // Rebuild settings cache so changes take effect immediately
    rebuild_settings();
}


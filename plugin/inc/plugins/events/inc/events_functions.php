<?php
/**
 * MyBB Event Plugin - Core Helper Functions
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Check if user is a GEC (Garrison Event Coordinator)
 */
function events_is_gec($user_id = null)
{
    global $mybb, $db;
    
    if($user_id === null)
    {
        $user_id = $mybb->user['uid'];
    }
    
    // Admins can always act as GEC
    if($mybb->usergroup['cancp'] == 1)
    {
        return true;
    }
    
    // Check if user is in Event Coordinator group
    $event_coordinator_groups = events_get_setting('event_coordinator_groups');
    if(empty($event_coordinator_groups))
    {
        return false;
    }
    
    $event_coordinator_groups = explode(',', $event_coordinator_groups);
    $user_groups = explode(',', $mybb->user['additionalgroups']);
    $user_groups[] = $mybb->user['usergroup'];
    
    foreach($event_coordinator_groups as $event_coordinator_group)
    {
        if(in_array($event_coordinator_group, $user_groups))
        {
            return true;
        }
    }
    
    return false;
}

/**
 * Check if user is GEC for a specific event
 */
function events_is_event_gec($event_id, $user_id = null)
{
    global $mybb, $db;
    
    if($user_id === null)
    {
        $user_id = $mybb->user['uid'];
    }
    
    // Admins can always act as GEC
    if($mybb->usergroup['cancp'] == 1)
    {
        return true;
    }
    
    // Check if user is general GEC
    if(events_is_gec($user_id))
    {
        return true;
    }
    
    // Check if user is assigned as GEC for this specific event
    $query = $db->simple_select("event_plugin_events", "gec_user_id", "id = " . (int)$event_id);
    $event = $db->fetch_array($query);
    
    if($event && $event['gec_user_id'] == $user_id)
    {
        return true;
    }
    
    return false;
}

/**
 * Get plugin setting
 */
function events_get_setting($name)
{
    global $mybb;
    
    $full_name = "events_" . $name;
    return $mybb->settings[$full_name];
}

/**
 * Check if user can RSVP to an event
 */
function events_can_rsvp($event_id, $user_id = null)
{
    global $mybb, $db;
    
    if($user_id === null)
    {
        $user_id = $mybb->user['uid'];
    }
    
    if($user_id == 0)
    {
        return false; // Guest
    }
    
    // Get event
    $query = $db->simple_select("event_plugin_events", "*", "id = " . (int)$event_id);
    $event = $db->fetch_array($query);
    
    if(!$event)
    {
        return false;
    }
    
    // Event must be live
    if($event['status'] != 'live')
    {
        return false;
    }
    
    // Check if user is excluded
    $exclusion = $db->simple_select("event_plugin_event_exclusions", "user_id", 
        "event_id = " . (int)$event_id . " AND user_id = " . (int)$user_id);
    if($db->num_rows($exclusion) > 0)
    {
        return false;
    }
    
    // Check signup cutoff
    if($event['signup_cutoff'] && strtotime($event['signup_cutoff']) < time())
    {
        return false;
    }
    
    return true;
}

/**
 * Check if user has RSVPed to an event
 */
function events_has_rsvped($event_id, $user_id = null)
{
    global $mybb, $db;
    
    if($user_id === null)
    {
        $user_id = $mybb->user['uid'];
    }
    
    $query = $db->simple_select("event_plugin_rsvps", "id", 
        "event_id = " . (int)$event_id . " AND user_id = " . (int)$user_id . " AND status = 'attending'");
    
    return $db->num_rows($query) > 0;
}

/**
 * Get user's custom profile field value
 */
function events_get_user_field($user_id, $field_name)
{
    global $db;
    
    $field_id = events_get_setting($field_name . '_field');
    if(!$field_id)
    {
        return null;
    }
    
    $query = $db->simple_select("userfields", "fid" . (int)$field_id, "ufid = " . (int)$user_id);
    $field = $db->fetch_array($query);
    
    if($field)
    {
        return $field['fid' . (int)$field_id];
    }
    
    return null;
}

/**
 * Check if user has required prerequisites for RSVP
 */
function events_check_prerequisites($event_id, $user_id = null)
{
    global $mybb, $db;
    
    if($user_id === null)
    {
        $user_id = $mybb->user['uid'];
    }
    
    $missing = array();
    
    // Get event
    $query = $db->simple_select("event_plugin_events", "*", "id = " . (int)$event_id);
    $event = $db->fetch_array($query);
    
    if(!$event)
    {
        return array('error' => 'Event not found');
    }
    
    // Check TK ID requirement - check if field is populated
    $tk_id = events_get_user_field($user_id, 'tk_id');
    if(empty($tk_id))
    {
        $missing['tk_id'] = true;
    }
    
    // Check WWCC requirement
    if($event['requires_wwcc'])
    {
        $wwcc = events_get_user_field($user_id, 'wwcc');
        if(empty($wwcc))
        {
            $missing['wwcc'] = true;
        }
    }
    
    // Always require mobile number
    $mobile = events_get_user_field($user_id, 'mobile');
    if(empty($mobile))
    {
        $missing['mobile'] = true;
    }
    
    // Always require emergency contact
    $emergency = events_get_user_field($user_id, 'emergency_contact');
    if(empty($emergency))
    {
        $missing['emergency_contact'] = true;
    }
    
    return $missing;
}

/**
 * Format date for display
 */
function events_format_date($date, $format = null)
{
    global $mybb;
    
    if($format === null)
    {
        $format = $mybb->settings['dateformat'] . " " . $mybb->settings['timeformat'];
    }
    
    return my_date($format, strtotime($date));
}

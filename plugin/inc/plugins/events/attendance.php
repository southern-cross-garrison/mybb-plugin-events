<?php
/**
 * MyBB Event Plugin - Attendance Sheet Generation
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

function events_show_attendance()
{
    global $mybb, $db;
    
    define("IN_MYBB", 1);
    require_once "./global.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
    
    $event_id = (int)$mybb->input['id'];
    $day_id = (int)$mybb->input['day_id'];
    
    // Check permissions
    if(!events_is_event_gec($event_id) && $mybb->usergroup['cancp'] != 1)
    {
        error_no_permission();
    }
    
    // Get event
    $query = $db->simple_select("event_plugin_events", "*", "id = " . $event_id);
    $event = $db->fetch_array($query);
    
    if(!$event)
    {
        error("Event not found.");
    }
    
    // Get event days
    $event_days = array();
    $query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . $event_id, array("order_by" => "date", "order_dir" => "ASC"));
    while($day = $db->fetch_array($query))
    {
        $event_days[] = $day;
    }
    
    // If no days, use event start/end dates
    if(empty($event_days))
    {
        $event_days[] = array(
            'id' => 0,
            'date' => date('Y-m-d', strtotime($event['start_date'])),
            'start_time' => date('H:i:s', strtotime($event['start_date'])),
            'end_time' => date('H:i:s', strtotime($event['end_date']))
        );
    }
    
    // Get RSVPs
    $rsvp_query = "
        SELECT r.*, u.username, u.uid, uf.realname
        FROM " . TABLE_PREFIX . "event_plugin_rsvps r
        LEFT JOIN " . TABLE_PREFIX . "users u ON r.user_id = u.uid
        LEFT JOIN " . TABLE_PREFIX . "userfields uf ON u.uid = uf.ufid
        WHERE r.event_id = " . (int)$event_id . " AND r.status = 'attending'
    ";
    
    if($day_id > 0)
    {
        $rsvp_query .= " AND r.id IN (SELECT rsvp_id FROM " . TABLE_PREFIX . "event_plugin_rsvp_days WHERE event_day_id = " . (int)$day_id . ")";
    }
    
    $rsvp_query .= " ORDER BY u.username ASC";
    
    $query = $db->query($rsvp_query);
    
    $attendees = array();
    while($rsvp = $db->fetch_array($query))
    {
        // Get costumes
        $costumes = array();
        $costume_query = $db->simple_select("event_plugin_rsvp_costumes", "costume", "rsvp_id = " . (int)$rsvp['id']);
        while($costume = $db->fetch_array($costume_query))
        {
            $costumes[] = $costume['costume'];
        }
        
        // Get user data
        $tk_id = events_get_user_field($rsvp['uid'], 'tk_id');
        $mobile = events_get_user_field($rsvp['uid'], 'mobile');
        $emergency = events_get_user_field($rsvp['uid'], 'emergency_contact');
        
        $attendees[] = array(
            'username' => $rsvp['username'],
            'realname' => $rsvp['realname'] ?? '',
            'tk_id' => $tk_id ?? '',
            'costumes' => $costumes,
            'mobile' => $mobile ?? '',
            'emergency_contact' => $emergency ?? ''
        );
    }
    
    // Output print-friendly page
    eval("\$page = \"" . $templates->get("header") . "\";");
    output_page($page);
    
    eval("\$attendance = \"" . $templates->get("attendance_sheet") . "\";");
    output_page($attendance);
    
    eval("\$page = \"" . $templates->get("footer") . "\";");
    output_page($page);
}

<?php
/**
 * MyBB Event Plugin - Main Events Page (Calendar/List View)
 */

define("IN_MYBB", 1);
require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

// Check if user can view events
if($mybb->user['uid'] == 0)
{
    error_no_permission();
}

$action = $mybb->input['action'] ?? 'list';
$view = $mybb->input['view'] ?? 'list'; // 'list' or 'calendar'
$region_filter = $mybb->input['region'] ?? '';

// Add navigation
add_breadcrumb("Events", "events.php");

if($action == 'attendance')
{
    require_once MYBB_ROOT . "inc/plugins/events/attendance.php";
    events_show_attendance();
    exit;
}

// Get events
$where = "status = 'live'";
if($mybb->usergroup['cancp'] == 1 || events_is_gec())
{
    // Admins and GECs can see pending events too
    $where = "status IN ('pending', 'live')";
}

if($region_filter && in_array($region_filter, array('Sydney', 'Hunter', 'Canberra', 'Other')))
{
    $where .= " AND region = '" . $db->escape_string($region_filter) . "'";
}

$query = $db->query("
    SELECT e.*, 
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps WHERE event_id = e.id AND status = 'attending') as rsvp_count
    FROM " . TABLE_PREFIX . "event_plugin_events e
    WHERE {$where}
    ORDER BY e.start_date ASC
");

$events = array();
$user_rsvps = array();

// Get user's RSVPs
if($mybb->user['uid'] > 0)
{
    $rsvp_query = $db->simple_select("event_plugin_rsvps", "event_id", 
        "user_id = " . (int)$mybb->user['uid'] . " AND status = 'attending'");
    while($rsvp = $db->fetch_array($rsvp_query))
    {
        $user_rsvps[] = $rsvp['event_id'];
    }
}

while($event = $db->fetch_array($query))
{
    $event['has_rsvped'] = in_array($event['id'], $user_rsvps);
    $events[] = $event;
}

// Output page
eval("\$page = \"" . $templates->get("header") . "\";");
output_page($page);

if($view == 'calendar')
{
    // Calendar view
    eval("\$calendar = \"" . $templates->get("events_calendar") . "\";");
    output_page($calendar);
}
else
{
    // List view
    eval("\$list = \"" . $templates->get("events_list") . "\";");
    output_page($list);
}

eval("\$page = \"" . $templates->get("footer") . "\";");
output_page($page);

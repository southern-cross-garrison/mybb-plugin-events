<?php
/**
 * MyBB Event Plugin - iCal Export
 */

define("IN_MYBB", 1);
require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

// Check if user is logged in
if($mybb->user['uid'] == 0)
{
    error_no_permission();
}

$event_id = (int)$mybb->input['id'];
$rsvp_id = (int)$mybb->input['rsvp_id'];

if(!$event_id)
{
    error("Invalid event ID.");
}

// Get event
$query = $db->simple_select("event_plugin_events", "*", "id = " . $event_id);
$event = $db->fetch_array($query);

if(!$event)
{
    error("Event not found.");
}

// Check if user has RSVPed (optional - could allow exporting any event)
if($rsvp_id)
{
    $query = $db->simple_select("event_plugin_rsvps", "*", 
        "id = " . (int)$rsvp_id . " AND user_id = " . (int)$mybb->user['uid']);
    if($db->num_rows($query) == 0)
    {
        error("Invalid RSVP.");
    }
}

// Get event days
$event_days = array();
$query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . $event_id, array("order_by" => "date", "order_dir" => "ASC"));
while($day = $db->fetch_array($query))
{
    $event_days[] = $day;
}

// If no specific days, use event start/end
if(empty($event_days))
{
    $event_days[] = array(
        'date' => date('Y-m-d', strtotime($event['start_date'])),
        'start_time' => date('H:i:s', strtotime($event['start_date'])),
        'end_time' => date('H:i:s', strtotime($event['end_date']))
    );
}

// Generate iCal content
header("Content-Type: text/calendar; charset=utf-8");
header("Content-Disposition: attachment; filename=\"event-" . $event_id . ".ics\"");

echo "BEGIN:VCALENDAR\r\n";
echo "VERSION:2.0\r\n";
echo "PRODID:-//MyBB Event Plugin//EN\r\n";
echo "CALSCALE:GREGORIAN\r\n";

foreach($event_days as $day)
{
    $start_datetime = $day['date'] . ($day['start_time'] ? "T" . str_replace(':', '', $day['start_time']) : "T000000");
    $end_datetime = $day['date'] . ($day['end_time'] ? "T" . str_replace(':', '', $day['end_time']) : "T235959");
    
    // Convert to UTC (simplified - would need proper timezone handling)
    $start_utc = date('Ymd\THis\Z', strtotime($start_datetime));
    $end_utc = date('Ymd\THis\Z', strtotime($end_datetime));
    
    echo "BEGIN:VEVENT\r\n";
    echo "UID:event-" . $event_id . "-" . $day['id'] . "@" . parse_url($mybb->settings['bburl'], PHP_URL_HOST) . "\r\n";
    echo "DTSTART:" . $start_utc . "\r\n";
    echo "DTEND:" . $end_utc . "\r\n";
    echo "SUMMARY:" . str_replace(array("\r\n", "\n", "\r"), "\\n", $event['title']) . "\r\n";
    echo "DESCRIPTION:" . str_replace(array("\r\n", "\n", "\r"), "\\n", strip_tags($event['description'])) . "\r\n";
    echo "LOCATION:" . str_replace(array("\r\n", "\n", "\r"), "\\n", $event['region']) . "\r\n";
    echo "URL:" . $mybb->settings['bburl'] . "/event.php?id=" . $event_id . "\r\n";
    echo "END:VEVENT\r\n";
}

echo "END:VCALENDAR\r\n";

exit;

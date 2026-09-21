<?php
/**
 * MyBB Event Plugin - iCal export
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "ical.php");

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
// events_description_text(): the feed carries no markup, so the description's BBCode
// has to be flattened rather than rendered.
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

if(!$mybb->user['uid'])
{
    error_no_permission();
}

$event_id = $mybb->get_input('id', MyBB::INPUT_INT);
$event = events_get_event($event_id);

if(!$event)
{
    error("Event not found.");
}

if(!events_can_view_event($event))
{
    error_no_permission();
}

$days = events_get_event_days($event_id);

// Single-day events have no rows in event_days; fall back to the event's own window.
if(empty($days))
{
    $days = array(array(
        'id'         => 0,
        'date'       => events_date('Y-m-d', events_strtotime($event['start_date'])),
        'start_time' => events_date('H:i:s', events_strtotime($event['start_date'])),
        'end_time'   => events_date('H:i:s', events_strtotime($event['end_date'])),
    ));
}

$host = parse_url($mybb->settings['bburl'], PHP_URL_HOST);

// LOCATION is what a calendar app hands to its maps button, so the address is what belongs
// in it. The region stays as the fallback: it is all an event without an address has, and
// an entry with no location at all would be a step back from what the export used to say.
$location = isset($event['address']) ? trim((string)$event['address']) : '';
if($location === '')
{
    $location = $event['region'];
}

/**
 * Escape a value for an iCal text property.
 */
function events_ical_escape($value)
{
    return str_replace(
        array("\\", ";", ",", "\r\n", "\n", "\r"),
        array("\\\\", "\;", "\\,", "\\n", "\\n", "\\n"),
        $value
    );
}

$lines = array();
$lines[] = "BEGIN:VCALENDAR";
$lines[] = "VERSION:2.0";
$lines[] = "PRODID:-//MyBB Event Plugin//EN";
$lines[] = "CALSCALE:GREGORIAN";

foreach($days as $day)
{
    // The stored day is a wall clock in the event's timezone; DTSTART and DTEND are
    // written as UTC instants, so reading it in that zone is what makes the two agree.
    $start = events_strtotime($day['date'] . ' ' . ($day['start_time'] ? $day['start_time'] : '00:00:00'));
    $end = events_strtotime($day['date'] . ' ' . ($day['end_time'] ? $day['end_time'] : '23:59:59'));

    $lines[] = "BEGIN:VEVENT";
    $lines[] = "UID:event-" . $event_id . "-" . (int)$day['id'] . "@" . $host;
    $lines[] = "DTSTAMP:" . gmdate('Ymd\THis\Z', TIME_NOW);
    $lines[] = "DTSTART:" . gmdate('Ymd\THis\Z', $start);
    $lines[] = "DTEND:" . gmdate('Ymd\THis\Z', $end);
    $lines[] = "SUMMARY:" . events_ical_escape($event['title']);
    $lines[] = "DESCRIPTION:" . events_ical_escape(events_description_text($event['description']));
    $lines[] = "LOCATION:" . events_ical_escape($location);
    $lines[] = "URL:" . $mybb->settings['bburl'] . "/event.php?id=" . $event_id;
    $lines[] = "END:VEVENT";
}

$lines[] = "END:VCALENDAR";

header("Content-Type: text/calendar; charset=utf-8");
header("Content-Disposition: attachment; filename=\"event-" . $event_id . ".ics\"");

echo implode("\r\n", $lines) . "\r\n";
exit;

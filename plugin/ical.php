<?php
/**
 * MyBB Event Plugin - iCal export
 *
 * One event, downloaded by a signed-in member. A calendar app that should keep up with
 * later changes subscribes to ical_feed.php instead.
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "ical.php");

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_ical.php";

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

$calendar = events_ical_calendar(events_ical_vevents($event, (int)$mybb->user['uid']));

header("Content-Type: text/calendar; charset=utf-8");
header("Content-Disposition: attachment; filename=\"event-" . $event_id . ".ics\"");

echo $calendar;
exit;

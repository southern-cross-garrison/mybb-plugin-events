<?php
/**
 * MyBB Event Plugin - Calendar subscription
 *
 * Where a member makes, resets or turns off the private link their calendar app
 * subscribes to (ical_feed.php). The same page is in the User CP; both are
 * events_calendar_feed_body().
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "calendar_feed.php");

$templatelist = "events_calendar_feed";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_feed.php";

if(!events_can_view_events_page())
{
    error_no_permission();
}

add_breadcrumb("Events", "events.php");
add_breadcrumb("Calendar Subscription", "calendar_feed.php");

$feed_body = events_calendar_feed_body("calendar_feed.php");
$events_print_header = events_print_header('Calendar Subscription', array());

eval("\$page = \"" . $templates->get("events_calendar_feed") . "\";");
output_page($page);

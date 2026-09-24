<?php
/**
 * MyBB Event Plugin - iCal subscription feed
 *
 * Every event a member has signed up for, fetched on a schedule by their calendar app.
 * The app keeps its copy in step with this feed, so a day the member drops, or an event
 * they withdraw from, leaves their calendar on the next refresh - which no downloaded
 * file can do.
 *
 * The app fetches from its own servers and carries no session, so the token in the URL
 * is the only thing that says whose feed this is. See events_feed.php for how it is made
 * and checked.
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "ical_feed.php");

// A calendar server is a guest. The token is this page's access control, so the board's
// "guests may not view" setting must not turn it away before the token is read.
define("ALLOWABLE_PAGE", 1);
// Nor is a calendar server somebody to list on Who's Online.
define("NO_ONLINE", 1);

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_ical.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_feed.php";

/** How far back the feed reaches. Older events drop out of the subscribed calendar. */
define('EVENTS_FEED_HISTORY', '-1 year');

// Never cached by anything between here and the app, and never indexed if the URL ends
// up somewhere public.
header("Cache-Control: private, no-store");
header("X-Robots-Tag: noindex, nofollow");
header("Referrer-Policy: no-referrer");

$user = events_feed_token_user($mybb->get_input('token'));
if(!$user)
{
    // One answer for every refusal - malformed, unknown, revoked, banned - so a request
    // cannot tell a token that was once valid from one that never was.
    http_response_code(404);
    header("Content-Type: text/plain; charset=utf-8");
    echo "Not found.";
    exit;
}

$user_id = (int)$user['uid'];
$since = events_strtotime(EVENTS_FEED_HISTORY, TIME_NOW);

$query = $db->simple_select("event_plugin_rsvps", "DISTINCT event_id",
    "user_id = " . $user_id . " AND status = 'attending'");

$events = array();
while($row = $db->fetch_array($query))
{
    $event = events_get_event((int)$row['event_id']);

    // Asked as the member, on every fetch: an event they have since been excluded from,
    // or one taken back to pending, leaves their calendar rather than lingering in it.
    if(!$event || !events_can_view_event($event, $user_id))
    {
        continue;
    }

    if(events_strtotime($event['end_date']) < $since)
    {
        continue;
    }

    $events[] = $event;
}

usort($events, function($a, $b) {
    return strcmp($a['start_date'], $b['start_date']) ?: (int)$a['id'] - (int)$b['id'];
});

$vevents = array();
foreach($events as $event)
{
    $vevents = array_merge($vevents, events_ical_vevents($event, $user_id));
}

$name = $mybb->settings['bbname'] . ' events';
$calendar = events_ical_calendar($vevents, array(
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" . events_ical_escape($name),
    "NAME:" . events_ical_escape($name),
    // A hint to the app, which is free to ignore it. Google does, and refreshes on its
    // own schedule of up to a day.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
));

header("Content-Type: text/calendar; charset=utf-8");
header("Content-Disposition: inline; filename=\"events.ics\"");

echo $calendar;
exit;

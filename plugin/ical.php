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

// A member who has signed up gets the days they are coming to, and each entry says what
// they are doing on it. One who has not gets every day, so the export is still useful for
// deciding whether to go, and each entry says they have not signed up yet.
$signup = events_get_user_signup($event_id);
$multi_day = count($days) > 1;
$day_ids = array_map(function($day) { return (int)$day['id']; }, $days);

// role => the ids of the days it covers. A role with no days on the event as it now
// stands covers all of it: that is how a single-day event records a signup (it has no
// day rows to point at), and a role left holding none of the event's days - because the
// event was edited out from under it (events_save_event_days()) - is still a signup,
// which is better shown on every day than dropped.
$role_days = array();
foreach(events_rsvp_roles() as $role)
{
    if(!isset($signup[$role]))
    {
        continue;
    }

    $covered = array_values(array_intersect($day_ids, $signup[$role]['days']));
    $role_days[$role] = $covered ? $covered : $day_ids;
}

if($role_days)
{
    $days = array_values(array_filter($days, function($day) use ($role_days) {
        foreach($role_days as $covered)
        {
            if(in_array((int)$day['id'], $covered, true))
            {
                return true;
            }
        }
        return false;
    }));
}

$host = parse_url($mybb->settings['bburl'], PHP_URL_HOST);
$url = $mybb->settings['bburl'] . '/' . events_event_url($event);

// LOCATION is what a calendar app hands to its maps button, so the address is what belongs
// in it. The region stays as the fallback: it is all an event without an address has, and
// an entry with no location at all would be a step back from what the export used to say.
$address = isset($event['address']) ? trim((string)$event['address']) : '';
$location = $address !== '' ? $address : $event['region'];

/**
 * The sentence that opens a day's description: what the member is doing that day.
 *
 * @param array $roles role => day ids it covers, empty when the member has not signed up
 * @param array $signup As returned by events_get_user_signup()
 * @param int $day_id
 * @param bool $multi_day
 * @return string
 */
function events_ical_signup_line(array $roles, array $signup, $day_id, $multi_day)
{
    if(!$roles)
    {
        return "You haven't signed up for this event yet.";
    }

    $doing = array();
    foreach($roles as $role => $covered)
    {
        if(!in_array((int)$day_id, $covered, true))
        {
            continue;
        }

        if($role === 'wrangler')
        {
            $doing[] = 'wrangling';
        }
        else
        {
            $costumes = $signup[$role]['costumes'];
            $doing[] = 'trooping' . ($costumes ? ' (' . implode(', ', $costumes) . ')' : '');
        }
    }

    return "You're " . implode(' and ', $doing) . ' ' . ($multi_day ? 'this day' : 'at this event') . '.';
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

/**
 * Fold a content line to the 75 octets RFC 5545 allows, continuing it on lines that open
 * with a space. Breaks fall between characters, never inside a multi-byte one.
 */
function events_ical_fold($line)
{
    // A value that is not valid UTF-8 has no character boundaries to respect; it is
    // split on bytes rather than dropped.
    $chars = preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY);
    if($chars === false)
    {
        $chars = str_split($line);
    }

    $folded = array();
    $current = '';
    foreach($chars as $char)
    {
        if(strlen($current) + strlen($char) > 75)
        {
            $folded[] = $current;
            $current = ' ';
        }
        $current .= $char;
    }
    $folded[] = $current;

    return implode("\r\n", $folded);
}

$details = array();
if(!empty($event['requires_wwcc']))
{
    $details[] = 'A Working With Children Check is required.';
}
if($address !== '')
{
    $details[] = 'Address: ' . $address;
}

$event_description = trim(events_description_text($event['description']));

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

    $description = array_merge(
        array(events_ical_signup_line($role_days, $signup, $day['id'], $multi_day)),
        $details
    );
    $description = implode("\n", $description);
    if($event_description !== '')
    {
        $description .= "\n\n" . $event_description;
    }

    $lines[] = "BEGIN:VEVENT";
    $lines[] = "UID:event-" . $event_id . "-" . (int)$day['id'] . "@" . $host;
    $lines[] = "DTSTAMP:" . gmdate('Ymd\THis\Z', TIME_NOW);
    $lines[] = "DTSTART:" . gmdate('Ymd\THis\Z', $start);
    $lines[] = "DTEND:" . gmdate('Ymd\THis\Z', $end);
    $lines[] = "SUMMARY:" . events_ical_escape($event['title']);
    $lines[] = "DESCRIPTION:" . events_ical_escape($description);
    $lines[] = "LOCATION:" . events_ical_escape($location);
    $lines[] = "URL:" . $url;
    $lines[] = "END:VEVENT";
}

$lines[] = "END:VCALENDAR";

header("Content-Type: text/calendar; charset=utf-8");
header("Content-Disposition: attachment; filename=\"event-" . $event_id . ".ics\"");

echo implode("\r\n", array_map('events_ical_fold', $lines)) . "\r\n";
exit;

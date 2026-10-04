<?php
/**
 * MyBB Event Plugin - iCal rendering
 *
 * Shared by ical.php (one event, downloaded by a signed-in member) and ical_feed.php
 * (every event a member has signed up for, fetched by their calendar app). Both describe
 * the same days the same way and under the same UIDs, so an entry means one thing
 * whichever of the two it came from.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
// events_description_text(): the feed carries no markup, so the description's BBCode
// has to be flattened rather than rendered. events_map_url() for the address's map link.
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

/**
 * The roles the member holds on one day, in events_rsvp_roles() order.
 *
 * @param array $roles role => day ids it covers
 * @param int $day_id
 * @return array
 */
function events_ical_day_roles(array $roles, $day_id)
{
    return array_keys(array_filter($roles, function($covered) use ($day_id) {
        return in_array((int)$day_id, $covered, true);
    }));
}

/**
 * A day's SUMMARY: the event's title, led by what the member is doing that day, so the
 * calendar grid says "Trooping: ..." without the entry having to be opened. A member who
 * has not signed up gets the bare title.
 *
 * @param array $roles role => day ids it covers, empty when the member has not signed up
 * @param string $title
 * @param int $day_id
 * @return string
 */
function events_ical_summary(array $roles, $title, $day_id)
{
    $doing = array_map('events_role_verb', events_ical_day_roles($roles, $day_id));

    return $doing ? implode(' and ', $doing) . ': ' . $title : $title;
}

/**
 * The sentence that opens a day's description: what the member is doing that day.
 *
 * @param array $roles role => day ids it covers, empty when the member has not signed up
 * @param array $signup As returned by events_get_user_signup()
 * @param int $day_id
 * @param bool $multi_day
 * @param bool $waitlisted Whether the member is waiting for a place rather than not signed up
 * @return string
 */
function events_ical_signup_line(array $roles, array $signup, $day_id, $multi_day, $waitlisted = false)
{
    if(!$roles)
    {
        return $waitlisted
            ? "You're on the waitlist for this event, and don't have a place yet."
            : "You haven't signed up for this event yet.";
    }

    $doing = array();
    foreach(events_ical_day_roles($roles, $day_id) as $role)
    {
        if($role !== 'trooper')
        {
            $doing[] = strtolower(events_role_verb($role));
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
 * Whether an event day row is the whole day: both boxes left blank, which the form stores
 * as 00:00:00 to 23:59:59 (events_day_time()), or no times stored at all.
 *
 * @param array $day event_day row
 * @return bool
 */
function events_ical_whole_day(array $day)
{
    $start = !empty($day['start_time']) ? $day['start_time'] : '00:00:00';
    $end = !empty($day['end_time']) ? $day['end_time'] : '23:59:59';

    return $start === '00:00:00' && $end === '23:59:59';
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

/**
 * One event's VEVENTs, as the given member sees it.
 *
 * The caller has already checked events_can_view_event() for that member.
 *
 * A member who has signed up gets the days they are coming to, and each entry says what
 * they are doing on it. One who has not gets every day, so the export is still useful for
 * deciding whether to go, and each entry says they have not signed up yet.
 *
 * @param array $event Event row
 * @param int $user_id
 * @return array of unfolded content lines
 */
function events_ical_vevents(array $event, $user_id)
{
    global $mybb;

    $event_id = (int)$event['id'];
    $days = events_get_event_days($event_id);

    // Single-day events have no rows in event_days; fall back to the event's own window.
    // It carries the event's own instants rather than a date and two times: an event on
    // one date can still run 24 hours or more (see events_event_dates()), and rebuilt from
    // its times on its start date a 02:00 to 03:00-the-next-day troop came out an hour long.
    if(empty($days))
    {
        $days = array(array(
            'id'    => 0,
            'date'  => events_date('Y-m-d', events_strtotime($event['start_date'])),
            'start' => events_strtotime($event['start_date']),
            'end'   => events_strtotime($event['end_date']),
        ));
    }

    // The day a UID is anchored to, taken before the list is cut down to the member's own
    // days (see the UID line below).
    $first_date = $days[0]['date'];

    // Only confirmed places go on a calendar. A day the member is waiting for is not one
    // they are going to yet, and an entry saying "Trooping" for it would be a promise; it
    // arrives with the next sync once the place does. Somebody waiting for everything
    // reads as not signed up, with a line saying why.
    $signup = events_get_user_signup($event_id, $user_id);
    $waitlisted = !empty($signup);
    foreach($signup as $role => $held)
    {
        if(empty($held['days']))
        {
            if($held['status'] === 'waitlisted')
            {
                unset($signup[$role]);
            }
            continue;
        }

        $signup[$role]['days'] = array_values(array_filter($held['days'], function($day_id) use ($held) {
            return $held['day_status'][$day_id] === 'attending';
        }));
        if(empty($signup[$role]['days']))
        {
            unset($signup[$role]);
        }
    }
    $waitlisted = $waitlisted && empty($signup);
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
    $url = $mybb->settings['bburl'] . '/' . events_event_url($event, $user_id);

    // LOCATION is what a calendar app hands to its maps button, so the address is what
    // belongs in it. The region stays as the fallback: it is all an event without an
    // address has, and an entry with no location at all would be a step back - unless the
    // board has no regions either, and then there is nothing to say.
    $address = isset($event['address']) ? trim((string)$event['address']) : '';
    $location = $address !== '' ? $address : $event['region'];

    $details = array();
    if(events_event_requires_wwcc($event))
    {
        $details[] = events_wwcc_name() . ' required.';
    }
    if($address !== '')
    {
        $details[] = 'Address: ' . $address;
        // The same Maps search the rest of the board links the address to. It does the
        // lookup when opened, so the entry gets a map without the plugin geocoding
        // anything, and every calendar app makes a URL in a description clickable.
        $details[] = 'Map: ' . events_map_url($address);
    }

    $event_description = trim(events_description_text($event['description']));

    $lines = array();
    foreach($days as $day)
    {
        if(isset($day['start']))
        {
            $dtstart = "DTSTART:" . gmdate('Ymd\THis\Z', $day['start']);
            $dtend = "DTEND:" . gmdate('Ymd\THis\Z', $day['end']);
        }
        elseif(events_ical_whole_day($day))
        {
            // A day left with blank boxes is stored as 00:00:00 to 23:59:59, which as two
            // instants is a timed entry that stops a second short of midnight. A calendar
            // shows it as the day itself only when it is written as a date, and a DATE end
            // is exclusive, so it is the following one. Dates have no zone, so this is
            // arithmetic on the date string in UTC rather than on the wall clock.
            $next = new DateTime($day['date'], new DateTimeZone('UTC'));
            $next->modify('+1 day');
            $dtstart = "DTSTART;VALUE=DATE:" . str_replace('-', '', $day['date']);
            $dtend = "DTEND;VALUE=DATE:" . $next->format('Ymd');
        }
        else
        {
            // The stored day is a wall clock in the event's timezone; DTSTART and DTEND are
            // written as UTC instants, so reading it in that zone is what makes the two agree.
            $start = events_strtotime($day['date'] . ' ' . ($day['start_time'] ? $day['start_time'] : '00:00:00'));
            $end = events_strtotime($day['date'] . ' ' . ($day['end_time'] ? $day['end_time'] : '23:59:59'));

            // A day stores only its times, so one that finishes at or before the time it
            // starts - ending at midnight, or running overnight - finishes on the following
            // date. Stepped on the wall clock in the event's zone, so a DST change that night
            // is honoured.
            if($end <= $start)
            {
                $end = events_strtotime('+1 day', $end);
            }

            $dtstart = "DTSTART:" . gmdate('Ymd\THis\Z', $start);
            $dtend = "DTEND:" . gmdate('Ymd\THis\Z', $end);
        }

        $description = array_merge(
            array(events_ical_signup_line($role_days, $signup, $day['id'], $multi_day, $waitlisted)),
            $details
        );
        $description = implode("\n", $description);
        if($event_description !== '')
        {
            $description .= "\n\n" . $event_description;
        }

        // A calendar app matches a re-import to what it already has by UID, so a UID must
        // not change while the entry is still the same one. Day row ids do: a day removed
        // and added back gets a new row, and a single-day event has no row at all until it
        // gains a second day. The first day is therefore the event itself, which keeps a
        // single-day event's entry when it moves, gains days or loses them, and every
        // other day is named by its date, which is the only thing that identifies it.
        $uid = "event-" . $event_id;
        if($day['date'] !== $first_date)
        {
            $uid .= "-" . str_replace('-', '', $day['date']);
        }

        $lines[] = "BEGIN:VEVENT";
        $lines[] = "UID:" . $uid . "@" . $host;
        $lines[] = "DTSTAMP:" . gmdate('Ymd\THis\Z', TIME_NOW);
        $lines[] = $dtstart;
        $lines[] = $dtend;
        $lines[] = "SUMMARY:" . events_ical_escape(events_ical_summary($role_days, $event['title'], $day['id']));
        $lines[] = "DESCRIPTION:" . events_ical_escape($description);
        if($location !== '')
        {
            $lines[] = "LOCATION:" . events_ical_escape($location);
        }
        $lines[] = "URL:" . $url;
        $lines[] = "END:VEVENT";
    }

    return $lines;
}

/**
 * Wrap VEVENT lines in a VCALENDAR and fold them for the wire.
 *
 * @param array $vevents From events_ical_vevents()
 * @param array $properties Extra calendar-level content lines (a feed's name, refresh interval)
 * @return string
 */
function events_ical_calendar(array $vevents, array $properties = array())
{
    $lines = array_merge(
        array(
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//MyBB Event Plugin//EN",
            "CALSCALE:GREGORIAN",
        ),
        $properties,
        $vevents,
        array("END:VCALENDAR")
    );

    return implode("\r\n", array_map('events_ical_fold', $lines)) . "\r\n";
}

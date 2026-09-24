<?php
/**
 * MyBB Event Plugin - Core Helper Functions
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Read a plugin setting without tripping undefined-index notices.
 *
 * @param string $name Setting name without the events_ prefix
 * @return string
 */
function events_get_setting($name)
{
    global $mybb;

    $full_name = "events_" . $name;
    return isset($mybb->settings[$full_name]) ? $mybb->settings[$full_name] : '';
}

/**
 * The timezone every date the plugin stores is written and read in.
 *
 * Nothing the plugin stores carries an offset: an event's start, its signup cutoff, the
 * day rows under it and the stamps on a troop report are all wall clocks, and a wall
 * clock only means something once a zone is named for it. The board names one, so a
 * garrison whose events happen in Sydney types 18:00 and gets 18:00 in Sydney - whether
 * the forum is hosted there, in Frankfurt, or on a host that moved between the two. The
 * server's own timezone deliberately does not enter into it.
 *
 * A board starts on UTC and names its own zone in Admin CP -> Event Management ->
 * Settings. UTC is also where an unset or unrecognised setting lands: it is the one zone
 * every PHP build can resolve, so a board still renders its dates when the setting names
 * a zone this host has never heard of.
 */
define('EVENTS_DEFAULT_TIMEZONE', 'UTC');

/**
 * The configured timezone's identifier, or UTC when there is not a usable one.
 *
 * @return string
 */
function events_timezone_name()
{
    // Keyed by the raw setting rather than resolved once, so a request that changes the
    // setting (the Admin CP settings page) does not go on answering with the old zone.
    static $resolved = array();

    $setting = trim((string)events_get_setting('timezone'));

    if(!isset($resolved[$setting]))
    {
        $resolved[$setting] = EVENTS_DEFAULT_TIMEZONE;

        if($setting !== '')
        {
            try
            {
                new DateTimeZone($setting);
                $resolved[$setting] = $setting;
            }
            catch(Exception $e)
            {
                // A zone this build of PHP has never heard of. Falling back is better
                // than fataling on every page that shows a date.
            }
        }
    }

    return $resolved[$setting];
}

/**
 * @return DateTimeZone
 */
function events_timezone()
{
    static $zones = array();

    $name = events_timezone_name();

    if(!isset($zones[$name]))
    {
        $zones[$name] = new DateTimeZone($name);
    }

    return $zones[$name];
}

/**
 * Format an instant as a wall clock in the event timezone.
 *
 * The plugin's replacement for date()/my_date(): every date it renders, and every date
 * it writes to a DATETIME column, goes through here so the board reads back exactly the
 * wall clock that was entered.
 *
 * my_date() rather than gmdate() so the board's own date handling still runs, and the
 * offset is worked out for this particular instant so a date either side of a daylight
 * saving change is rendered under the offset that was actually in force then.
 *
 * @param string $format
 * @param int|false|null $timestamp Defaults to now; false (an unparseable date) yields ''
 * @return string
 */
function events_date($format, $timestamp = null)
{
    if($timestamp === null)
    {
        $timestamp = TIME_NOW;
    }

    if($timestamp === false || $timestamp === '')
    {
        return '';
    }

    $timestamp = (int)$timestamp;

    return my_date($format, $timestamp, events_timezone_offset($timestamp) / 3600, 0);
}

/**
 * The event timezone's offset from UTC, in seconds, at a given instant.
 *
 * @param int|null $timestamp
 * @return int
 */
function events_timezone_offset($timestamp = null)
{
    if($timestamp === null)
    {
        $timestamp = TIME_NOW;
    }

    return events_timezone()->getOffset(new DateTime('@' . (int)$timestamp));
}

/**
 * Read a stored or submitted date as a wall clock in the event timezone.
 *
 * The plugin's replacement for strtotime(). PHP would read the same string against the
 * server's zone, which is what made a cutoff of "17:00" close at 17:00 wherever the
 * forum happened to be hosted rather than at 17:00 where the event is.
 *
 * @param string $value A date, a time, or a relative expression ('+1 day')
 * @param int|null $base Instant a relative expression is measured from; now by default
 * @return int|false false when the value is not a date at all
 */
function events_strtotime($value, $base = null)
{
    $value = trim((string)$value);

    // MySQL's zero date is how a nullable DATETIME reads on a non-strict server. It is
    // not a moment, and PHP reading it as one (the year zero) put events a long way in
    // the past rather than reporting them as undated.
    if($value === '' || substr($value, 0, 10) === '0000-00-00')
    {
        return false;
    }

    try
    {
        if($base === null)
        {
            $date = new DateTime($value, events_timezone());
        }
        else
        {
            // A timestamp carries no zone of its own, so it is moved into the event's
            // before the expression is applied: "-1 month" from the 1st of a month has
            // to step by that month in the zone the calendar is drawn in.
            $date = new DateTime('@' . (int)$base);
            $date->setTimezone(events_timezone());

            if($date->modify($value) === false)
            {
                return false;
            }
        }
    }
    catch(Exception $e)
    {
        return false;
    }

    return $date->getTimestamp();
}

/**
 * Every timezone the admin can choose from, as identifier => label.
 *
 * The label carries the offset the zone is on *now*, which is what makes a list of 400
 * identifiers pickable; a zone that observes daylight saving will read an hour out for
 * half the year, and that is honest - the plugin follows the zone, not the label.
 *
 * @return array
 */
function events_timezone_choices()
{
    // Four hundred zones, built twice on a settings save (once to check what was posted,
    // once to draw the box) and never changing within a request.
    static $choices = null;

    if($choices !== null)
    {
        return $choices;
    }

    $now = new DateTime('now', new DateTimeZone('UTC'));
    $choices = array();

    foreach(DateTimeZone::listIdentifiers(DateTimeZone::ALL) as $identifier)
    {
        $zone = new DateTimeZone($identifier);
        $minutes = (int)round(abs($zone->getOffset($now)) / 60);

        $choices[$identifier] = $identifier . ' (UTC' . sprintf(
            '%s%02d:%02d',
            $zone->getOffset($now) < 0 ? '-' : '+',
            intdiv($minutes, 60),
            $minutes % 60
        ) . ')';
    }

    return $choices;
}

/**
 * Load a user row, defaulting to the logged in user.
 *
 * @param int|null $user_id
 * @return array|null
 */
function events_get_user($user_id = null)
{
    global $mybb, $db;
    static $cache = array();

    if($user_id === null || (int)$user_id === (int)$mybb->user['uid'])
    {
        return $mybb->user;
    }

    $user_id = (int)$user_id;
    if(!isset($cache[$user_id]))
    {
        $cache[$user_id] = $db->fetch_array($db->simple_select("users", "*", "uid = " . $user_id));
    }

    return $cache[$user_id];
}

/**
 * Every group id a user belongs to (primary + additional).
 *
 * @param array $user
 * @return array of int
 */
function events_user_group_ids($user)
{
    if(empty($user))
    {
        return array();
    }

    $groups = array((int)$user['usergroup']);
    if(!empty($user['additionalgroups']))
    {
        foreach(explode(',', $user['additionalgroups']) as $gid)
        {
            $gid = (int)$gid;
            if($gid)
            {
                $groups[] = $gid;
            }
        }
    }

    return array_unique($groups);
}

/**
 * Is the user allowed to act as an Event Coordinator anywhere?
 *
 * Administrators always qualify. Otherwise the user must be in one of the groups
 * configured in the Event Coordinator User Groups setting.
 *
 * @param int|null $user_id
 * @return bool
 */
function events_is_gec($user_id = null)
{
    global $db;

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return false;
    }

    if(events_user_can_admin($user))
    {
        return true;
    }

    $coordinator_groups = events_get_setting('event_coordinator_groups');
    if($coordinator_groups === '')
    {
        return false;
    }

    $coordinator_groups = array_map('intval', explode(',', $coordinator_groups));
    $user_groups = events_user_group_ids($user);

    return (bool)array_intersect($coordinator_groups, $user_groups);
}

/**
 * Does the user hold an admin-CP-capable group?
 *
 * @param array $user
 * @return bool
 */
function events_user_can_admin($user)
{
    global $mybb, $cache;

    if(empty($user['uid']))
    {
        return false;
    }

    // Fast path for the current request's user.
    if((int)$user['uid'] === (int)$mybb->user['uid'] && isset($mybb->usergroup['cancp']))
    {
        return $mybb->usergroup['cancp'] == 1;
    }

    $usergroups = $cache->read("usergroups");
    foreach(events_user_group_ids($user) as $gid)
    {
        if(isset($usergroups[$gid]) && $usergroups[$gid]['cancp'] == 1)
        {
            return true;
        }
    }

    return false;
}

/**
 * Is the user the coordinator for one specific event (or a general coordinator)?
 *
 * @param int $event_id
 * @param int|null $user_id
 * @return bool
 */
function events_is_event_gec($event_id, $user_id = null)
{
    global $db;

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return false;
    }

    if(events_is_gec($user['uid']))
    {
        return true;
    }

    $event = events_get_event($event_id);

    return $event && (int)$event['gec_user_id'] === (int)$user['uid'];
}

/**
 * The two ways to sign up to an event.
 *
 * A trooper turns out in costume. A wrangler is a non-costumed helper, who is not
 * required to be a full member and so has no Legion ID.
 *
 * @return array
 */
function events_rsvp_roles()
{
    return array('trooper', 'wrangler');
}

/**
 * Normalise untrusted input to exactly one of the role tokens.
 *
 * Everything that reaches a query or a hidden input goes through here, so a role is
 * always provably one of two literals.
 *
 * @param string $input
 * @return string
 */
function events_rsvp_role($input)
{
    return in_array($input, events_rsvp_roles(), true) ? $input : 'trooper';
}

/**
 * @param string $role
 * @return string
 */
function events_role_label($role)
{
    return $role === 'wrangler' ? 'Wrangler' : 'Trooper';
}

/**
 * @param int $event_id
 * @return array|null
 */
function events_get_event($event_id)
{
    global $db;

    $event_id = (int)$event_id;
    if(!$event_id)
    {
        return null;
    }

    $event = $db->fetch_array($db->simple_select("event_plugin_events", "*", "id = " . $event_id));

    return $event ? $event : null;
}

/**
 * Ordered list of an event's configured days.
 *
 * @param int $event_id
 * @return array
 */
function events_get_event_days($event_id)
{
    global $db;

    $days = array();
    $query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . (int)$event_id, array("order_by" => "date, start_time", "order_dir" => "ASC"));
    while($day = $db->fetch_array($query))
    {
        $days[] = $day;
    }

    return $days;
}

/**
 * The two ways the events index can be shown.
 *
 * @return array of string
 */
function events_views()
{
    return array('list', 'calendar');
}

/**
 * The view the toggle switches to from the one being shown.
 *
 * @param string $view
 * @return string
 */
function events_other_view($view)
{
    return $view === 'calendar' ? 'list' : 'calendar';
}

/**
 * The view this member last looked at the events index in.
 *
 * Members who have never touched the toggle have no row, and get the list - it is the
 * denser of the two and the one every link into the plugin has always landed on.
 *
 * @param int|null $user_id
 * @return string 'list' or 'calendar'
 */
function events_view_preference($user_id = null)
{
    global $mybb, $db;

    $user_id = $user_id === null ? (int)$mybb->user['uid'] : (int)$user_id;
    if($user_id <= 0)
    {
        return 'list';
    }

    $row = $db->fetch_array($db->simple_select("event_plugin_user_prefs", "events_view", "user_id = " . $user_id));

    return (!empty($row) && in_array($row['events_view'], events_views(), true)) ? $row['events_view'] : 'list';
}

/**
 * Remember the view this member is looking at, for their next visit.
 *
 * Written on every request that names a view rather than only on the toggle itself, so
 * that paging the calendar or filtering a list - both of which carry the view along -
 * keeps the preference current. The read guards the write because that makes the common
 * case, revisiting the view you already prefer, a select on a primary key instead of a
 * write to a MyISAM table that locks for every other reader of the page.
 *
 * @param string $view
 * @param int|null $user_id
 * @return void
 */
function events_save_view_preference($view, $user_id = null)
{
    global $mybb, $db;

    $user_id = $user_id === null ? (int)$mybb->user['uid'] : (int)$user_id;
    if($user_id <= 0 || !in_array($view, events_views(), true))
    {
        return;
    }

    if(events_view_preference($user_id) === $view)
    {
        return;
    }

    $db->replace_query("event_plugin_user_prefs", array(
        'user_id'     => $user_id,
        'events_view' => $db->escape_string($view)
    ), 'user_id');
}

/**
 * May this user open the events pages at all?
 *
 * The events index is members-only. The navigation link is gated on the same check, so
 * nobody is offered a link that would only ever answer "no permission".
 *
 * @param int|null $user_id
 * @return bool
 */
function events_can_view_events_page($user_id = null)
{
    $user = events_get_user($user_id);

    return !empty($user['uid']);
}

/**
 * Is the user on one event's exclusion list?
 *
 * The bare fact, with none of the coordinator carve-out events_hidden_event_ids()
 * applies: being excluded closes signups to you whoever you are, including the
 * coordinator of the event you have been excluded from.
 *
 * @param int $event_id
 * @param int|null $user_id
 * @return bool
 */
function events_is_excluded($event_id, $user_id = null)
{
    global $db;

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return false;
    }

    // Exclusions have no role column: being excluded from an event excludes you from
    // every way of signing up to it.
    $query = $db->simple_select("event_plugin_event_exclusions", "user_id",
        "event_id = " . (int)$event_id . " AND user_id = " . (int)$user['uid']);

    return $db->num_rows($query) > 0;
}

/**
 * The events this user is not allowed to know about.
 *
 * An exclusion used to leave the event in full view with the signup button locked, which
 * told the excluded member everything about an event except the one thing they wanted -
 * and "you have been excluded" beside a list of everyone who is going is a worse way to
 * find out than not being told at all. So an exclusion now hides the event: it is gone
 * from the listing and the calendar, its page, feed and troop report form answer no, and
 * its announcement thread is unreachable (see events_hidden_thread_ids()).
 *
 * Two people are never hidden from an event: whoever coordinates it, and any general
 * coordinator or administrator. Somebody who has to run an event has to be able to open
 * it, and the Admin CP is where an exclusion is put right.
 *
 * Cached for the request. Exclusions only change when an event is saved, and both forms
 * redirect straight afterwards rather than rendering anything that reads this.
 *
 * @param int|null $user_id
 * @return array of int event id
 */
function events_hidden_event_ids($user_id = null)
{
    global $db;

    static $cache = array();

    $user = events_get_user($user_id);
    $uid = empty($user['uid']) ? 0 : (int)$user['uid'];

    // Exclusions name members, so a guest has none. Whether a guest sees an event at all
    // is events_can_view_event()'s business.
    if(!$uid)
    {
        return array();
    }

    if(!isset($cache[$uid]))
    {
        $ids = array();

        if(!events_is_gec($uid))
        {
            $query = $db->query("
                SELECT x.event_id
                FROM " . TABLE_PREFIX . "event_plugin_event_exclusions x
                INNER JOIN " . TABLE_PREFIX . "event_plugin_events e ON e.id = x.event_id
                WHERE x.user_id = " . $uid . " AND e.gec_user_id != " . $uid . "
            ");

            while($row = $db->fetch_array($query))
            {
                $ids[] = (int)$row['event_id'];
            }
        }

        $cache[$uid] = $ids;
    }

    return $cache[$uid];
}

/**
 * The announcement threads this user is not allowed to know about.
 *
 * The board's members follow the forums rather than the events listing, so an event that
 * is hidden from the listing but still has a thread anybody can read and reply to is not
 * hidden at all. These are the thread ids the hooks in events_hooks.php keep out of the
 * forums for this member.
 *
 * Only the announcement thread. A troop report is posted to its own forum as its own
 * thread and is deliberately left alone: the report is the garrison's record of what
 * happened, it names who turned out rather than who may sign up, and somebody who was
 * excluded from one event has no reason to be cut out of the board's history of it.
 *
 * @param int|null $user_id
 * @return array of int thread id
 */
function events_hidden_thread_ids($user_id = null)
{
    global $db;

    static $cache = array();

    $user = events_get_user($user_id);
    $uid = empty($user['uid']) ? 0 : (int)$user['uid'];

    if(!$uid)
    {
        return array();
    }

    if(!isset($cache[$uid]))
    {
        $thread_ids = array();
        $event_ids = events_hidden_event_ids($uid);

        if(!empty($event_ids))
        {
            $query = $db->simple_select("event_plugin_events", "thread_id",
                "id IN (" . implode(',', $event_ids) . ") AND thread_id > 0");

            while($row = $db->fetch_array($query))
            {
                $thread_ids[] = (int)$row['thread_id'];
            }
        }

        $cache[$uid] = $thread_ids;
    }

    return $cache[$uid];
}

/**
 * Every thread that is some event's announcement thread.
 *
 * One query for the whole request, since the thread listings ask it once per row.
 *
 * @return array of int thread id
 */
function events_announcement_thread_ids()
{
    global $db;

    static $thread_ids = null;

    if($thread_ids === null)
    {
        $thread_ids = array();

        $query = $db->simple_select("event_plugin_events", "thread_id", "thread_id > 0");
        while($row = $db->fetch_array($query))
        {
            $thread_ids[] = (int)$row['thread_id'];
        }
    }

    return $thread_ids;
}

/**
 * Look the given threads up, remembering them for the rest of the request.
 *
 * The listing and the calendar ask after every event they show, so they hand the whole
 * page's thread ids over at once rather than paying a query per event.
 *
 * @param array $thread_ids
 * @return array tid => thread row, holding only the threads that exist
 */
function events_thread_rows(array $thread_ids)
{
    global $db;

    static $cache = array();

    $missing = array();
    foreach($thread_ids as $thread_id)
    {
        $thread_id = (int)$thread_id;
        if($thread_id > 0 && !array_key_exists($thread_id, $cache))
        {
            $missing[$thread_id] = $thread_id;
        }
    }

    if(!empty($missing))
    {
        $query = $db->simple_select("threads", "tid, fid, uid, firstpost, visible, closed",
            "tid IN (" . implode(',', $missing) . ")");
        while($row = $db->fetch_array($query))
        {
            $cache[(int)$row['tid']] = $row;
            unset($missing[(int)$row['tid']]);
        }

        // Remembered as absent too, so a thread that has been deleted is not looked for
        // again on every row that names it.
        foreach($missing as $thread_id)
        {
            $cache[$thread_id] = null;
        }
    }

    $rows = array();
    foreach($thread_ids as $thread_id)
    {
        $thread_id = (int)$thread_id;
        if(!empty($cache[$thread_id]))
        {
            $rows[$thread_id] = $cache[$thread_id];
        }
    }

    return $rows;
}

/**
 * The event's announcement thread, when there is one this member can open.
 *
 * This is what decides whether an event is read in its thread or on event.php, so it asks
 * everything showthread.php would before rendering the thread: that it still exists, has
 * a first post, is approved, is not a moved-thread stub, and sits in a forum this member
 * may read threads in. Anything short of that and the event stays on event.php, because a
 * link that ends on "you do not have permission" loses the event along with the thread.
 *
 * Whether the member may see the *event* is not asked here; everything that calls this has
 * already checked events_can_view_event().
 *
 * @param array $event Event row
 * @return array|null thread row
 */
function events_event_thread(array $event)
{
    global $mybb;

    $thread_id = empty($event['thread_id']) ? 0 : (int)$event['thread_id'];
    if(!$thread_id)
    {
        return null;
    }

    $rows = events_thread_rows(array($thread_id));
    if(empty($rows[$thread_id]))
    {
        return null;
    }

    $thread = $rows[$thread_id];
    if((int)$thread['visible'] !== 1 || !(int)$thread['firstpost'] || strpos((string)$thread['closed'], 'moved|') === 0)
    {
        return null;
    }

    $permissions = forum_permissions((int)$thread['fid']);
    if(empty($permissions['canview']) || empty($permissions['canviewthreads']))
    {
        return null;
    }

    if(!empty($permissions['canonlyviewownthreads']) && (int)$thread['uid'] !== (int)$mybb->user['uid'])
    {
        return null;
    }

    return $thread;
}

/**
 * Where a link to this event should go: its thread when there is one to read it in,
 * event.php otherwise.
 *
 * event.php would forward the member to the thread anyway; linking there directly saves
 * the hop, and puts the address the member actually lands on under their cursor.
 *
 * @param array $event Event row
 * @return string URL relative to the board root
 */
function events_event_url(array $event)
{
    $thread = events_event_thread($event);
    if($thread)
    {
        return 'showthread.php?tid=' . (int)$thread['tid'];
    }

    return 'event.php?id=' . (int)$event['id'];
}

/**
 * Can the user see this event at all?
 *
 * Pending events are only visible to coordinators and admins; live and archived
 * events are visible to every logged in member except one who has been excluded from
 * them - see events_hidden_event_ids() for why an exclusion hides rather than locks.
 *
 * @param array $event
 * @param int|null $user_id
 * @return bool
 */
function events_can_view_event($event, $user_id = null)
{
    if(empty($event))
    {
        return false;
    }

    if($event['status'] === 'pending')
    {
        return events_is_event_gec($event['id'], $user_id);
    }

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return false;
    }

    return !in_array((int)$event['id'], events_hidden_event_ids($user_id), true);
}

/**
 * Why can this user not sign up to this event?
 *
 * Returns null when the signup form may be opened, otherwise a machine-readable reason.
 * The reasons double as the assertions the e2e suite makes when travelling the clock.
 *
 * Signups close at the signup cutoff when one is set. With no cutoff they stay open
 * until the event ends, so somebody who turns up late can still be recorded.
 *
 * Holding a signup already is deliberately *not* a reason: the signup form doubles as
 * the edit form, so a member who wants to add a day or switch from trooping to
 * wrangling walks the same wizard again. The gate is only about whether the event is
 * still accepting changes at all.
 *
 * @param int|array $event Event id or row
 * @param int|null $user_id
 * @return string|null one of: guest, not_found, not_live, excluded, cutoff_passed, event_ended
 */
function events_signup_lock_reason($event, $user_id = null)
{
    if(!is_array($event))
    {
        $event = events_get_event($event);
    }

    if(!$event)
    {
        return 'not_found';
    }

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return 'guest';
    }

    if($event['status'] !== 'live')
    {
        return 'not_live';
    }

    // An excluded member normally cannot reach a page that asks this - the event is
    // hidden from them outright - so this is the check that still has to hold for the
    // coordinator of an event they have been excluded from, and for anything that posts
    // to rsvp.php without having been offered the form.
    if(events_is_excluded($event['id'], $user['uid']))
    {
        return 'excluded';
    }

    if(!empty($event['signup_cutoff']) && $event['signup_cutoff'] !== '0000-00-00 00:00:00')
    {
        if(events_strtotime($event['signup_cutoff']) <= TIME_NOW)
        {
            return 'cutoff_passed';
        }
    }
    elseif(events_strtotime($event['end_date']) <= TIME_NOW)
    {
        return 'event_ended';
    }

    return null;
}

/**
 * @param int|array $event
 * @param int|null $user_id
 * @return bool
 */
function events_can_sign_up($event, $user_id = null)
{
    return events_signup_lock_reason($event, $user_id) === null;
}

/**
 * Human readable form of a signup lock reason.
 *
 * @param string $reason
 * @return string
 */
function events_signup_lock_message($reason)
{
    $messages = array(
        'guest'         => 'You must be logged in to sign up.',
        'not_found'     => 'Event not found.',
        'not_live'      => 'This event is not open for signups.',
        'excluded'      => 'You have been excluded from signing up to this event.',
        'cutoff_passed' => 'Signups for this event have closed.',
        'event_ended'   => 'This event has finished, so signups have closed.',
    );

    return isset($messages[$reason]) ? $messages[$reason] : 'You cannot sign up to this event.';
}

/**
 * Short form of a signup lock reason, for the listing's "You" column.
 *
 * That column is one narrow cell holding either a button, a role pill or this, and the
 * sentences events_signup_lock_message() returns are nearly as long as the rest of the
 * row. They sized the column, which left every button in it looking a different size from
 * the message beside it. The event page and the signup page have room to explain; in the
 * column the state is the whole point, so it gets the state and keeps the sentence on the
 * pill's title attribute - "Closed" on its own cannot say whether the cutoff passed or the
 * event is over, and that difference is the reason a member is looking.
 *
 * A reason with no short form falls back to the sentence rather than to a word invented
 * here, so adding a lock reason cannot quietly mislabel itself.
 *
 * @param string $reason
 * @param array|null $event The event row, where one is at hand - see below
 * @return string
 */
function events_signup_lock_label($reason, $event = null)
{
    // One reason, two states. events_signup_lock_reason() answers 'not_live' for anything
    // whose status is not live, so a pending event and an archived one reach this point
    // indistinguishable - and they want opposite words: a pending event is waiting to
    // open, an archived one is shut for good. Only the row knows which, so the label needs
    // it. Without this an archived row read "Pending" next to a Status column that said
    // "Archived". The reason token itself stays 'not_live' - it is what the event page and
    // the suite read, and the distinction is a matter of wording, not of permission.
    if($reason === 'not_live' && isset($event['status']) && $event['status'] === 'archived')
    {
        return 'Closed';
    }

    $labels = array(
        'cutoff_passed' => 'Closed',
        'event_ended'   => 'Closed',
        'not_live'      => 'Pending',
    );

    return isset($labels[$reason]) ? $labels[$reason] : events_signup_lock_message($reason);
}

/**
 * Has the user signed up to this event in the given role?
 *
 * Defaults to 'trooper' so that any caller which does not care keeps the meaning it had
 * before wranglers existed.
 *
 * @param int $event_id
 * @param int|null $user_id
 * @param string $role
 * @return bool
 */
function events_has_rsvped($event_id, $user_id = null, $role = 'trooper')
{
    global $db;

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return false;
    }

    $query = $db->simple_select("event_plugin_rsvps", "id",
        "event_id = " . (int)$event_id . " AND user_id = " . (int)$user['uid']
        . " AND role = '" . $db->escape_string(events_rsvp_role($role)) . "' AND status = 'attending'");

    return $db->num_rows($query) > 0;
}

/**
 * How many people have signed up to an event in a given role?
 *
 * @param int $event_id
 * @param string|null $role null counts every role
 * @return int
 */
function events_rsvp_count($event_id, $role = 'trooper')
{
    global $db;

    $where = "event_id = " . (int)$event_id . " AND status = 'attending'";
    if($role !== null)
    {
        $where .= " AND role = '" . $db->escape_string(events_rsvp_role($role)) . "'";
    }

    return (int)$db->fetch_field(
        $db->simple_select("event_plugin_rsvps", "COUNT(*) AS rsvps", $where),
        "rsvps"
    );
}

/**
 * The whole of one member's signup to an event, keyed by role.
 *
 * A signup is up to two rows in event_plugin_rsvps - one per role - because a member can
 * troop some of an event's days and wrangle others. This returns them together so the
 * event page and the signup wizard can reason about the signup as one thing.
 *
 * @param int $event_id
 * @param int|null $user_id
 * @return array role => array(rsvp_id, rsvp_date, days (int[]), costumes (string[]))
 */
function events_get_user_signup($event_id, $user_id = null)
{
    global $db;

    $user = events_get_user($user_id);
    if(empty($user['uid']))
    {
        return array();
    }

    $signup = array();
    $query = $db->simple_select("event_plugin_rsvps", "id, role, rsvp_date",
        "event_id = " . (int)$event_id . " AND user_id = " . (int)$user['uid'] . " AND status = 'attending'");
    while($row = $db->fetch_array($query))
    {
        $rsvp_id = (int)$row['id'];

        $days = array();
        $day_query = $db->simple_select("event_plugin_rsvp_days", "event_day_id", "rsvp_id = " . $rsvp_id);
        while($day = $db->fetch_array($day_query))
        {
            $days[] = (int)$day['event_day_id'];
        }

        $costumes = array();
        $costume_query = $db->simple_select("event_plugin_rsvp_costumes", "costume", "rsvp_id = " . $rsvp_id);
        while($costume = $db->fetch_array($costume_query))
        {
            $costumes[] = $costume['costume'];
        }

        $signup[events_rsvp_role($row['role'])] = array(
            'rsvp_id'   => $rsvp_id,
            'rsvp_date' => $row['rsvp_date'],
            'days'      => $days,
            'costumes'  => $costumes,
        );
    }

    return $signup;
}

/**
 * Take a named database lock, waiting up to $timeout seconds for whoever holds it.
 *
 * The plugin's tables are MyISAM, so there are no transactions to make a read-then-write
 * atomic, and a double-clicked submit is two requests racing through the same check. A
 * write that has to see the state the previous one left must hold one of these around
 * the read *and* the write. Anything read before the lock was taken is stale.
 *
 * Named locks belong to the connection, so this goes over the write connection - where
 * the writes it guards go - and one left behind by a request that died in error() or
 * exit is released when that connection closes. Lock names are server-wide, so the
 * database name and table prefix go into the hash to keep two boards on one server apart.
 *
 * @param string $name
 * @param int $timeout
 * @return bool false if the lock could not be had in time
 */
function events_acquire_lock($name, $timeout = 15)
{
    global $db;

    $query = $db->write_query("SELECT GET_LOCK('" . events_lock_name($name) . "', " . (int)$timeout . ") AS acquired");

    return (int)$db->fetch_field($query, 'acquired') === 1;
}

/**
 * Release a lock taken with events_acquire_lock().
 *
 * @param string $name
 * @return void
 */
function events_release_lock($name)
{
    global $db;

    $db->write_query("SELECT RELEASE_LOCK('" . events_lock_name($name) . "')");
}

/**
 * @param string $name
 * @return string
 */
function events_lock_name($name)
{
    global $db;

    return 'events_' . md5($db->database . '|' . TABLE_PREFIX . '|' . $name);
}

/**
 * Write a member's signup, replacing whatever they had before.
 *
 * $role_days is the whole intent: a role that is absent from it is a role the member is
 * no longer holding, and its row (with its days and costumes) is deleted. A role that is
 * present keeps its existing row - and so its original rsvp_date, which is what a
 * coordinator sorts on - and has its days and costumes rewritten.
 *
 * Costumes only ever attach to the trooper row; a wrangler is not in costume.
 *
 * The whole write holds a lock on the member's signup for this event, and the signup it
 * replaces is read inside that lock. A double-clicked Confirm is two of these at once,
 * and without it both read "no signup yet": the second insert then trips the
 * event_user_role key, or both rewrite the same row's costumes and leave each one twice.
 * Held, the second request finds the row the first just wrote and updates it.
 *
 * @param int $event_id
 * @param int $user_id
 * @param array $role_days role => array of event_day_id (empty array for an event with no days)
 * @param array $costumes
 * @return bool false if the lock could not be had, in which case nothing was written
 */
function events_save_signup($event_id, $user_id, array $role_days, array $costumes)
{
    $event_id = (int)$event_id;
    $user_id = (int)$user_id;
    $lock = 'signup:' . $event_id . ':' . $user_id;

    if(!events_acquire_lock($lock))
    {
        return false;
    }

    events_write_signup($event_id, $user_id, $role_days, $costumes);
    events_release_lock($lock);

    return true;
}

/**
 * The body of events_save_signup(), which must only be called with its lock held.
 *
 * @param int $event_id
 * @param int $user_id
 * @param array $role_days
 * @param array $costumes
 * @return void
 */
function events_write_signup($event_id, $user_id, array $role_days, array $costumes)
{
    global $db;

    $existing = events_get_user_signup($event_id, $user_id);

    foreach(events_rsvp_roles() as $role)
    {
        $held = isset($existing[$role]) ? $existing[$role] : null;

        if(!array_key_exists($role, $role_days))
        {
            if($held)
            {
                $db->delete_query("event_plugin_rsvp_days", "rsvp_id = " . (int)$held['rsvp_id']);
                $db->delete_query("event_plugin_rsvp_costumes", "rsvp_id = " . (int)$held['rsvp_id']);
                $db->delete_query("event_plugin_rsvps", "id = " . (int)$held['rsvp_id']);
            }

            continue;
        }

        if($held)
        {
            $rsvp_id = (int)$held['rsvp_id'];
            $db->delete_query("event_plugin_rsvp_days", "rsvp_id = " . $rsvp_id);
            $db->delete_query("event_plugin_rsvp_costumes", "rsvp_id = " . $rsvp_id);
        }
        else
        {
            $rsvp_id = (int)$db->insert_query("event_plugin_rsvps", array(
                'event_id'  => $event_id,
                'user_id'   => $user_id,
                'role'      => $db->escape_string($role),
                'rsvp_date' => $db->escape_string(events_date('Y-m-d H:i:s')),
                'status'    => 'attending',
            ));
        }

        foreach(array_unique($role_days[$role]) as $day_id)
        {
            $db->insert_query("event_plugin_rsvp_days", array(
                'rsvp_id'      => $rsvp_id,
                'event_day_id' => (int)$day_id,
            ));
        }

        if($role === 'trooper')
        {
            foreach(array_unique($costumes) as $costume)
            {
                $db->insert_query("event_plugin_rsvp_costumes", array(
                    'rsvp_id' => $rsvp_id,
                    'costume' => $db->escape_string($costume),
                ));
            }
        }
    }
}

/**
 * Remove everything the plugin holds against members who no longer exist.
 *
 * A signup left behind by a deleted member is on no attendance list - those join the
 * users table - but it is still counted, so an event reads as having more attendees
 * than it lists and a capped one fills up with nobody. Worse, it keeps them on the
 * troop-report reminder, which is one PM to every attendee, and MyBB refuses the whole
 * PM over a recipient who does not exist - so one deleted member silenced the reminder
 * for everybody else on that event, every night, for good.
 *
 * Events and troop reports they created are kept: those belong to the garrison.
 *
 * @param int[] $user_ids
 * @return void
 */
function events_delete_member_data(array $user_ids)
{
    global $db;

    $user_ids = array_filter(array_map('intval', $user_ids));
    if(empty($user_ids))
    {
        return;
    }

    $uids = implode(',', $user_ids);

    $rsvp_ids = array();
    $query = $db->simple_select("event_plugin_rsvps", "id", "user_id IN (" . $uids . ")");
    while($row = $db->fetch_array($query))
    {
        $rsvp_ids[] = (int)$row['id'];
    }

    if(!empty($rsvp_ids))
    {
        $in = implode(',', $rsvp_ids);
        $db->delete_query("event_plugin_rsvp_days", "rsvp_id IN (" . $in . ")");
        $db->delete_query("event_plugin_rsvp_costumes", "rsvp_id IN (" . $in . ")");
        $db->delete_query("event_plugin_rsvps", "id IN (" . $in . ")");
    }

    $db->delete_query("event_plugin_event_exclusions", "user_id IN (" . $uids . ")");
    $db->delete_query("event_plugin_user_prefs", "user_id IN (" . $uids . ")");

    // The feed already refuses a token whose member is gone; dropping it as well means a
    // credential is never left in the table with nobody able to revoke it.
    if($db->table_exists("event_plugin_feed_tokens"))
    {
        $db->delete_query("event_plugin_feed_tokens", "user_id IN (" . $uids . ")");
    }
}

/**
 * Read one of the mapped custom profile fields for a user.
 *
 * @param int $user_id
 * @param string $field_name One of costume, tk_id, wwcc, mobile, emergency_contact
 * @return string
 */
function events_get_user_field($user_id, $field_name)
{
    global $db;

    $field_id = (int)events_get_setting($field_name . '_field');
    if(!$field_id)
    {
        return '';
    }

    $row = $db->fetch_array($db->simple_select("userfields", "fid" . $field_id, "ufid = " . (int)$user_id));

    return $row && isset($row['fid' . $field_id]) ? (string)$row['fid' . $field_id] : '';
}

/**
 * Split a costume profile field into individual costumes.
 *
 * MyBB stores multiselect/checkbox fields newline separated; free-text fields are
 * conventionally comma separated here, so both are accepted.
 *
 * @param string $raw
 * @return array
 */
function events_parse_costumes($raw)
{
    if($raw === null || trim($raw) === '')
    {
        return array();
    }

    $parts = preg_split('/[\r\n,]+/', $raw);
    $parts = array_map('trim', $parts);
    $parts = array_filter($parts, 'strlen');

    return array_values(array_unique($parts));
}

/**
 * The costumes a user has selected on their profile.
 *
 * @param int $user_id
 * @return array
 */
function events_get_user_costumes($user_id)
{
    return events_parse_costumes(events_get_user_field($user_id, 'costume'));
}

/**
 * Which prerequisite profile fields is the user missing for this event?
 *
 * Wranglers are not required to be full members, so they are never asked for a TK ID.
 * They are still asked for the details a coordinator needs on the day - a preferred name
 * and the two contact numbers - because a wrangler is on the attendance sheet and has to
 * be greeted and reached like anybody else on it.
 *
 * A signup can hold both roles at once (trooping one day, wrangling the next), so the
 * role argument is a set: the TK ID is asked for as soon as one day is being trooped.
 *
 * @param int|array $event
 * @param int|null $user_id
 * @param string|array $roles One role, or the set of roles the signup holds
 * @return array field key => true
 */
function events_check_prerequisites($event, $user_id = null, $roles = 'trooper')
{
    if(!is_array($event))
    {
        $event = events_get_event($event);
    }

    $user = events_get_user($user_id);
    if(!$event || empty($user['uid']))
    {
        return array();
    }

    // An empty set is a signup with no days on it yet, not a trooper: filter the blanks
    // out before normalising, or events_rsvp_role() would turn '' into 'trooper'.
    $roles = array_map('events_rsvp_role', array_filter((array)$roles, 'strlen'));

    // Asked of a wrangler as well as a trooper: the username on the sheet is a forum
    // handle, and a coordinator calling the roll at a staging area needs the name the
    // person actually answers to.
    $required = array('preferred_name', 'mobile', 'emergency_contact');
    if(in_array('trooper', $roles, true))
    {
        // Costumes belong here for the same reason the Legion ID does: they are asked of
        // a trooper and not of a wrangler, who turns out uncostumed. Asking in this step
        // is what keeps a member with an empty costume field inside the wizard - before,
        // the costumes step could only send them to the User CP to fill the field in and
        // start the signup again.
        array_unshift($required, 'tk_id', 'costume');
    }

    if(!empty($event['requires_wwcc']))
    {
        $required[] = 'wwcc';
    }

    $missing = array();
    foreach($required as $field)
    {
        // A field that has not been mapped to a profile field cannot be required.
        if(!events_get_setting($field . '_field'))
        {
            continue;
        }

        if(trim(events_get_user_field($user['uid'], $field)) === '')
        {
            $missing[$field] = true;
        }
    }

    return $missing;
}

/**
 * Write prerequisite values back to the user's custom profile fields.
 *
 * @param int $user_id
 * @param array $values field key => value
 * @return void
 */
function events_save_user_fields($user_id, array $values)
{
    global $db;

    $update = array();
    foreach($values as $field => $value)
    {
        $field_id = (int)events_get_setting($field . '_field');
        if(!$field_id)
        {
            continue;
        }
        $update['fid' . $field_id] = $db->escape_string($value);
    }

    if(empty($update))
    {
        return;
    }

    $user_id = (int)$user_id;
    if($db->num_rows($db->simple_select("userfields", "ufid", "ufid = " . $user_id)) > 0)
    {
        $db->update_query("userfields", $update, "ufid = " . $user_id);
    }
    else
    {
        $update['ufid'] = $user_id;

        // A member with no userfields row at all - the account the MyBB installer creates
        // has none, and neither does anything imported around the datahandler - needs an
        // INSERT rather than an UPDATE, and a partial one will not do. MyBB declares each
        // fid column TEXT NOT NULL with no default, so under STRICT_TRANS_TABLES MySQL
        // refuses to fill in the columns this insert does not name and the signup dies
        // with "Field 'fid1' doesn't have a default value" - after the prerequisites step,
        // which is the point the member has just filled that form in. So name every field
        // the table has, blank for the ones this call carries no value for.
        foreach($db->show_fields_from("userfields") as $column)
        {
            if(preg_match('/^fid\d+$/', $column['Field']) && !isset($update[$column['Field']]))
            {
                $update[$column['Field']] = '';
            }
        }

        $db->insert_query("userfields", $update);
    }
}

/**
 * Label shown for each prerequisite on the RSVP prerequisites form.
 *
 * @return array
 */
function events_prerequisite_labels()
{
    // 'multiline' picks the control: costumes are a list rather than a value, so the field
    // is a textarea, matching the profile field they are saved to.
    return array(
        'tk_id'             => array('label' => 'Legion ID', 'hint' => 'Your 501st legion ID, e.g. if you are TK-12345 then type "12345" here.'),
        'costume'           => array('label' => 'Approved Costumes', 'hint' => 'One per line. These are saved to your profile, and you pick from them on the next step.', 'multiline' => true),
        'preferred_name'    => array('label' => 'Preferred Name', 'hint' => 'What the coordinator should call you on the day. A first name is fine.'),
        'wwcc'              => array('label' => 'WWCC Number', 'hint' => 'This event requires a Working With Children Check.'),
        'mobile'            => array('label' => 'Mobile Number', 'hint' => 'So the coordinator can reach you on the day.'),
        'emergency_contact' => array('label' => 'Emergency Contact', 'hint' => 'Name and number of someone to call in an emergency.'),
    );
}

/**
 * Load the attendee list for an event, including the data the attendance sheet and
 * troop report need.
 *
 * @param int $event_id
 * @param array $filters costume (string), day (int event_day_id), role (string)
 * @return array
 */
function events_get_attendees($event_id, array $filters = array())
{
    global $db;

    $event_id = (int)$event_id;
    $where = "r.event_id = " . $event_id . " AND r.status = 'attending'";

    if(!empty($filters['role']))
    {
        $where .= " AND r.role = '" . $db->escape_string(events_rsvp_role($filters['role'])) . "'";
    }

    if(!empty($filters['costume']))
    {
        $where .= " AND r.id IN (SELECT rsvp_id FROM " . TABLE_PREFIX . "event_plugin_rsvp_costumes WHERE costume LIKE '%" . $db->escape_string($filters['costume']) . "%')";
    }

    if(!empty($filters['day']))
    {
        $where .= " AND r.id IN (SELECT rsvp_id FROM " . TABLE_PREFIX . "event_plugin_rsvp_days WHERE event_day_id = " . (int)$filters['day'] . ")";
    }

    $query = $db->query("
        SELECT r.id, r.user_id, r.role, r.rsvp_date, u.username, u.usergroup, u.additionalgroups, uf.*
        FROM " . TABLE_PREFIX . "event_plugin_rsvps r
        INNER JOIN " . TABLE_PREFIX . "users u ON r.user_id = u.uid
        LEFT JOIN " . TABLE_PREFIX . "userfields uf ON u.uid = uf.ufid
        WHERE {$where}
        ORDER BY u.username ASC
    ");

    $attendees = array();
    while($row = $db->fetch_array($query))
    {
        $costumes = array();
        $costume_query = $db->simple_select("event_plugin_rsvp_costumes", "costume", "rsvp_id = " . (int)$row['id']);
        while($costume = $db->fetch_array($costume_query))
        {
            $costumes[] = $costume['costume'];
        }

        $days = array();
        $day_query = $db->query("
            SELECT ed.id, ed.date, ed.start_time, ed.end_time
            FROM " . TABLE_PREFIX . "event_plugin_rsvp_days rd
            INNER JOIN " . TABLE_PREFIX . "event_plugin_event_days ed ON rd.event_day_id = ed.id
            WHERE rd.rsvp_id = " . (int)$row['id'] . "
            ORDER BY ed.date ASC
        ");
        while($day = $db->fetch_array($day_query))
        {
            $days[] = $day;
        }

        $attendees[] = array(
            'rsvp_id'           => (int)$row['id'],
            'uid'               => (int)$row['user_id'],
            'role'              => $row['role'],
            'username'          => $row['username'],
            'usergroup'         => (int)$row['usergroup'],
            'additionalgroups'  => $row['additionalgroups'],
            'rsvp_date'         => $row['rsvp_date'],
            'costumes'          => $costumes,
            'days'              => $days,
            'preferred_name'    => events_get_user_field($row['user_id'], 'preferred_name'),
            'tk_id'             => events_get_user_field($row['user_id'], 'tk_id'),
            'mobile'            => events_get_user_field($row['user_id'], 'mobile'),
            'emergency_contact' => events_get_user_field($row['user_id'], 'emergency_contact'),
            'wwcc'              => events_get_user_field($row['user_id'], 'wwcc'),
        );
    }

    return $attendees;
}

/**
 * usort() comparator putting attendees in the order a roll is called: by the name the
 * person answers to, with their username standing in when they have not given one and
 * breaking ties when two of them go by the same thing.
 *
 * Case-insensitive, because the field is free text and a member who typed their name in
 * lower case should not sort into a block of their own below everybody else.
 *
 * @param array $a
 * @param array $b
 * @return int
 */
function events_compare_by_preferred_name(array $a, array $b)
{
    $a_name = trim($a['preferred_name']) !== '' ? $a['preferred_name'] : $a['username'];
    $b_name = trim($b['preferred_name']) !== '' ? $b['preferred_name'] : $b['username'];

    $compared = strcasecmp($a_name, $b_name);

    return $compared !== 0 ? $compared : strcasecmp($a['username'], $b['username']);
}

/**
 * Format a stored datetime for display using the board's configured formats.
 *
 * @param string $date
 * @param string|null $format
 * @return string
 */
function events_format_date($date, $format = null)
{
    global $mybb;

    if(empty($date) || $date === '0000-00-00 00:00:00')
    {
        return '';
    }

    if($format === null)
    {
        $format = $mybb->settings['dateformat'] . " " . $mybb->settings['timeformat'];
    }

    return events_date($format, events_strtotime($date));
}

/**
 * Format an event's dates for the listing column.
 *
 * A one-day event is a date and the hours it runs - "Oct 26 - 9AM to 5PM". A multi-day one
 * is the span of dates instead - "Oct 26 - Oct 28" - because the hours differ from day to
 * day and one pair of them would misreport the rest; the per-day times are on the event's
 * own page, which is where somebody reading them is going anyway.
 *
 * The year is added to either form once the date falls outside the current one, so
 * "Oct 26 2027 - 9AM to 5PM" - see events_format_date_day().
 *
 * With no end date the start alone is written, which is what every caller got before the
 * span existed.
 *
 * @param string $date
 * @param string|null $end_date
 * @return string
 */
function events_format_list_date($date, $end_date = null)
{
    if(empty($date) || $date === '0000-00-00 00:00:00')
    {
        return '';
    }

    $timestamp = events_strtotime($date);

    if($timestamp === false)
    {
        return '';
    }

    $end = empty($end_date) || $end_date === '0000-00-00 00:00:00'
        ? false
        : events_strtotime($end_date);

    if($end !== false && events_date('Y-m-d', $end) !== events_date('Y-m-d', $timestamp))
    {
        return events_format_date_day($timestamp) . ' - ' . events_format_date_day($end);
    }

    $time = events_format_list_time($timestamp);

    // An end that lands on the same minute as the start says nothing, so it is left off
    // rather than written as "9AM to 9AM".
    if($end !== false && $end > $timestamp)
    {
        $time .= ' to ' . events_format_list_time($end);
    }

    return events_format_date_day($timestamp) . ' - ' . $time;
}

/**
 * The clock half of the listing's date: "9AM", or "9:30AM" when there are minutes to say.
 *
 * @param int $timestamp
 * @return string
 */
function events_format_list_time($timestamp)
{
    return events_date((int)events_date('i', $timestamp) === 0 ? 'gA' : 'g:iA', $timestamp);
}

/**
 * The date half the dense formats share: month and day, with the year added only when
 * the date does not fall in the current one.
 *
 * A schedule that is almost all this year reads better without the year repeated down
 * every row, and a date in another year has to say which.
 *
 * @param int $timestamp
 * @return string
 */
function events_format_date_day($timestamp)
{
    $day = events_date('M j', $timestamp);

    if(events_date('Y', $timestamp) !== events_date('Y', TIME_NOW))
    {
        $day .= ' ' . events_date('Y', $timestamp);
    }

    return $day;
}

/**
 * "Oct 20 at 10am" - a date written to sit inside a sentence.
 *
 * Joined with "at" and set in lower case, where events_format_list_date() writes the
 * same moment as "Oct 20 - 10AM". That one is a table cell: a dash reads as the column's
 * own punctuation and the capitals stay legible when the eye is running down a row of
 * them. This one is prose, and is read as prose.
 *
 * @param string $date
 * @return string empty when the date is missing or unparseable
 */
function events_format_when($date)
{
    if(empty($date) || $date === '0000-00-00 00:00:00')
    {
        return '';
    }

    $timestamp = events_strtotime($date);

    if($timestamp === false)
    {
        return '';
    }

    $time = events_date((int)events_date('i', $timestamp) === 0 ? 'ga' : 'g:ia', $timestamp);

    return events_format_date_day($timestamp) . ' at ' . $time;
}

/**
 * Has the event finished?
 *
 * @param array $event
 * @return bool
 */
function events_has_ended($event)
{
    return !empty($event) && events_strtotime($event['end_date']) < TIME_NOW;
}

/**
 * The troop report row for an event, if any.
 *
 * @param int $event_id
 * @return array|null
 */
function events_get_troop_report($event_id)
{
    global $db;

    $row = $db->fetch_array($db->simple_select("event_plugin_troop_reports", "*", "event_id = " . (int)$event_id));

    return $row ? $row : null;
}

/**
 * Is this event waiting on its troop report?
 *
 * A live event whose end date has gone by and which has no posted report yet. The three
 * clauses are the same ones events_send_reminders() selects on - the listing says what
 * the weekly PM is about to nag about, and the two must not be able to disagree.
 *
 * Archived and pending events are excluded by the status test on purpose: archiving is
 * how an event is closed out, so an archived event is not outstanding work whatever its
 * report says, and a pending one never happened.
 *
 * A row in event_plugin_troop_reports is *not* a report. events_send_reminders() inserts
 * one for an event that has none at all, purely to record when it last sent a reminder,
 * so the column that says a report exists is posted_at - the same test
 * events_can_create_troop_report() makes.
 *
 * Reads the report state off the event row when the caller has joined it on as
 * report_posted_at, which is what keeps the events listing at one query for the whole
 * page, and falls back to fetching it when they have not.
 *
 * @param array $event
 * @return bool
 */
function events_needs_troop_report($event)
{
    if(empty($event) || $event['status'] !== 'live' || !events_has_ended($event))
    {
        return false;
    }

    if(array_key_exists('report_posted_at', $event))
    {
        return empty($event['report_posted_at']);
    }

    $report = events_get_troop_report($event['id']);

    return !$report || empty($report['posted_at']);
}

/**
 * May this user draft/post the troop report for the event?
 *
 * The event must have ended, the user must have attended as a trooper, and no report
 * may have been posted yet. Wranglers do not write troop reports.
 *
 * @param array $event
 * @param int|null $user_id
 * @return bool
 */
function events_can_create_troop_report($event, $user_id = null)
{
    if(!events_has_ended($event))
    {
        return false;
    }

    if(!events_has_rsvped($event['id'], $user_id, 'trooper'))
    {
        return false;
    }

    $report = events_get_troop_report($event['id']);

    return !$report || empty($report['posted_at']);
}

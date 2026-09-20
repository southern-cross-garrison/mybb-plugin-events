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
 * Can the user see this event at all?
 *
 * Pending events are only visible to coordinators and admins; live and archived
 * events are visible to every logged in member.
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

    return !empty($user['uid']);
}

/**
 * Why can this user not RSVP?
 *
 * Returns null when the user may RSVP, otherwise a machine-readable reason. The
 * reasons double as the assertions the e2e suite makes when travelling the clock.
 *
 * Signups close at the signup cutoff when one is set. With no cutoff they stay open
 * until the event ends, so somebody who turns up late can still be recorded.
 *
 * @param int|array $event Event id or row
 * @param int|null $user_id
 * @param string $role Which signup is being attempted
 * @return string|null one of: guest, not_found, not_live, excluded, cutoff_passed, event_ended, already_rsvped, already_wrangling
 */
function events_rsvp_lock_reason($event, $user_id = null, $role = 'trooper')
{
    global $db;

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

    // Exclusions have no role column: being excluded from an event excludes you from
    // every way of signing up to it.
    $excluded = $db->simple_select("event_plugin_event_exclusions", "user_id",
        "event_id = " . (int)$event['id'] . " AND user_id = " . (int)$user['uid']);
    if($db->num_rows($excluded) > 0)
    {
        return 'excluded';
    }

    if(!empty($event['signup_cutoff']) && $event['signup_cutoff'] !== '0000-00-00 00:00:00')
    {
        if(strtotime($event['signup_cutoff']) <= TIME_NOW)
        {
            return 'cutoff_passed';
        }
    }
    elseif(strtotime($event['end_date']) <= TIME_NOW)
    {
        return 'event_ended';
    }

    $role = events_rsvp_role($role);
    if(events_has_rsvped($event['id'], $user['uid'], $role))
    {
        return $role === 'wrangler' ? 'already_wrangling' : 'already_rsvped';
    }

    return null;
}

/**
 * @param int|array $event
 * @param int|null $user_id
 * @return bool
 */
function events_can_rsvp($event, $user_id = null, $role = 'trooper')
{
    return events_rsvp_lock_reason($event, $user_id, $role) === null;
}

/**
 * Human readable form of an RSVP lock reason.
 *
 * @param string $reason
 * @return string
 */
function events_rsvp_lock_message($reason)
{
    $messages = array(
        'guest'          => 'You must be logged in to RSVP.',
        'not_found'      => 'Event not found.',
        'not_live'       => 'This event is not open for RSVPs.',
        'excluded'       => 'You have been excluded from RSVPing to this event.',
        'cutoff_passed'  => 'RSVPs for this event have closed.',
        'event_ended'    => 'This event has finished, so RSVPs have closed.',
        'already_rsvped' => 'You have already RSVPed to this event.',
        'already_wrangling' => 'You have already signed up to wrangle this event.',
    );

    return isset($messages[$reason]) ? $messages[$reason] : 'You cannot RSVP to this event.';
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
 * They are still asked for the details a coordinator needs on the day.
 *
 * @param int|array $event
 * @param int|null $user_id
 * @param string $role
 * @return array field key => true
 */
function events_check_prerequisites($event, $user_id = null, $role = 'trooper')
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

    $required = array('mobile', 'emergency_contact');
    if(events_rsvp_role($role) === 'trooper')
    {
        array_unshift($required, 'tk_id');
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
    return array(
        'tk_id'             => array('label' => 'TK ID', 'hint' => 'Your 501st legion ID.'),
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
            'tk_id'             => events_get_user_field($row['user_id'], 'tk_id'),
            'mobile'            => events_get_user_field($row['user_id'], 'mobile'),
            'emergency_contact' => events_get_user_field($row['user_id'], 'emergency_contact'),
            'wwcc'              => events_get_user_field($row['user_id'], 'wwcc'),
        );
    }

    return $attendees;
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

    return my_date($format, strtotime($date), 0, 0);
}

/**
 * Has the event finished?
 *
 * @param array $event
 * @return bool
 */
function events_has_ended($event)
{
    return !empty($event) && strtotime($event['end_date']) < TIME_NOW;
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

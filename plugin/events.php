<?php
/**
 * MyBB Event Plugin - Events index (list and calendar views)
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "events.php");

$templatelist = "events_list,events_calendar";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

if(!events_can_view_events_page())
{
    error_no_permission();
}

add_breadcrumb("Events", "events.php");

// A view named in the URL wins and becomes the member's preference; a bare events.php
// opens in whichever view they last used. Every link that leaves the index for one of its
// own views carries `view` along, so the preference follows the toggle, the month paging
// and the region filter alike.
$view = $mybb->get_input('view');
if(in_array($view, events_views(), true))
{
    events_save_view_preference($view);
}
else
{
    $view = events_view_preference();
}

$region_filter = $mybb->get_input('region');
if(!in_array($region_filter, events_regions(), true))
{
    $region_filter = '';
}

// An archived event is one the board has already turned out to, and the index is a
// schedule of what is coming - left in it they accumulate at the top of the list and in
// every calendar month behind the current one, so the schedule reads as history. Hidden
// by default and shown when the filter asks, rather than dropped: archiving is how an
// event is closed out, not how it is deleted, and the record has to stay reachable.
//
// Only the index hides them. event.php, rsvp.php and the announcement thread all answer
// for an archived event exactly as they did - see events_can_view_event() - so a link
// into one from a troop report or an old thread still opens.
$show_archived = $mybb->get_input('archived', MyBB::INPUT_INT) === 1;

// Coordinators and admins also see events that are still pending.
$statuses = array('live');
if(events_is_gec())
{
    $statuses[] = 'pending';
}
if($show_archived)
{
    $statuses[] = 'archived';
}

// The names are this file's own literals, not input - $show_archived and events_is_gec()
// are what the request gets a say in.
$where = "status IN ('" . implode("','", $statuses) . "')";
if($region_filter !== '')
{
    $where .= " AND region = '" . $db->escape_string($region_filter) . "'";
}

// An event somebody has been excluded from is not theirs to know about, so it leaves the
// list and the calendar rather than sitting there with its signup button locked. Filtered
// in the query and not in the loop below, so a hidden event cannot be counted, paged or
// drawn onto a calendar cell by anything downstream.
$hidden_event_ids = events_hidden_event_ids();
if(!empty($hidden_event_ids))
{
    $where .= " AND e.id NOT IN (" . implode(',', $hidden_event_ids) . ")";
}

// Tracked per role, because the listing shows which way round the viewer is signed up -
// a mixed signup holds both, and reads as "Trooping" and "Wrangling" side by side.
$user_roles = array();
// A member waiting for a place has not got one, so they are told they are waiting rather
// than offered a Sign Up button for a signup they already hold.
$user_waitlisted = array();
$rsvp_query = $db->simple_select("event_plugin_rsvps", "event_id, role, status",
    "user_id = " . (int)$mybb->user['uid']);
while($row = $db->fetch_array($rsvp_query))
{
    if($row['status'] === 'waitlisted')
    {
        $user_waitlisted[(int)$row['event_id']] = true;
        continue;
    }

    $user_roles[(int)$row['event_id']][] = events_rsvp_role($row['role']);
}

// The calendar only highlights "you are involved in this", so either role counts.
$user_rsvps = array_keys($user_roles);

// report_posted_at rides along so the listing can say which finished events are still
// waiting on their troop report without a query per row - see events_needs_troop_report(),
// which reads the column when it is there. Joined rather than sub-selected because
// event_id is unique on that table, so there is exactly one row to find or none.
$query = $db->query("
    SELECT e.*,
           tr.posted_at AS report_posted_at,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'trooper' AND r.status = 'attending') AS rsvp_count,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'wrangler' AND r.status = 'attending') AS wrangler_count,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'attendee' AND r.status = 'attending') AS attendee_count
    FROM " . TABLE_PREFIX . "event_plugin_events e
    LEFT JOIN " . TABLE_PREFIX . "event_plugin_troop_reports tr ON tr.event_id = e.id
    WHERE {$where}
    ORDER BY e.start_date ASC
");

$events = array();
$thread_ids = array();
while($event = $db->fetch_array($query))
{
    $events[] = $event;
    $thread_ids[] = (int)$event['thread_id'];
}

// Each event links to its thread when it has one - see events_event_url() - so the whole
// page's threads are looked up in one go rather than once per row.
events_thread_rows($thread_ids);

$events_region_filter = events_region_filter($region_filter);
$events_view_toggle = events_view_toggle($view, $region_filter, $show_archived);
$events_archived_filter = events_archived_filter($show_archived);
$events_filter_disclosure = events_filter_disclosure($region_filter, $show_archived);
$events_filter_script = events_filter_script();

// The calendar's month links are anchors rather than forms, so they have to carry the
// filters themselves - see events_index_filter_params().
$calendar_filter_params = events_index_filter_params($region_filter, $show_archived);

// Coordinators build their own events now, so the listing is where a new one starts. It
// sits in the toolbar on both views and is simply absent for everybody else.
//
// A submit button in a one-line GET form rather than a link, because it stands next to
// the Filter button and has to read as the same kind of control on whatever theme is
// installed. Themes style `input.button` and `button.button` - MyBB's own default theme
// and the garrison's both do - and none of them style a bare `.button` on an anchor, so
// an <a> would have to carry a look of its own and would drift from its neighbour the
// first time a theme restyled its buttons.
$events_manage_link = '';
if(events_is_gec())
{
    $events_manage_link = '<form method="get" action="manage_event.php" class="events_filter_form">'
        . '<input type="submit" class="button" id="events_create" value="Create Event" />'
        . '</form>';
}

if($view === 'calendar')
{
    $month_input = $mybb->get_input('month');
    if(!preg_match('/^\d{4}-\d{2}$/', $month_input))
    {
        $month_input = events_date('Y-m', TIME_NOW);
    }

    $month_start = events_strtotime($month_input . '-01 00:00:00');
    $calendar_month = $month_input;
    $calendar_month_name = events_date('F Y', $month_start);
    $calendar_prev = events_date('Y-m', events_strtotime('-1 month', $month_start));
    $calendar_next = events_date('Y-m', events_strtotime('+1 month', $month_start));
    $calendar_content = events_calendar_grid($month_start, $events, $user_rsvps);

    $events_print_header = events_print_header('Events Calendar',
        array($calendar_month_name, $region_filter, $show_archived ? 'Including archived' : ''));

    eval("\$page = \"" . $templates->get("events_calendar") . "\";");
    output_page($page);
    exit;
}

// A board with no regions has no Region column to fill.
$has_regions = events_has_regions();
$events_region_head = $has_regions ? '<td class="tcat"><strong>Region</strong></td>' : '';
$events_columns = $has_regions ? 6 : 5;

$events_rows = '';
foreach($events as $event)
{
    $signed_up_as = isset($user_roles[(int)$event['id']]) ? $user_roles[(int)$event['id']] : array();
    $lock_reason = events_signup_lock_reason($event);

    // Once the event is over the pill reports what the member did rather than what they
    // are down to do - "Trooped", not "Trooping". The class keeps the present-tense verb
    // whatever the text says: it is what the stylesheet colours and what the suite locates
    // the pill by, and neither has any business changing when the event ends.
    $ended = events_has_ended($event);
    if(!empty($signed_up_as))
    {
        $you = '';
        foreach(events_event_roles($event) as $role)
        {
            if(in_array($role, $signed_up_as, true))
            {
                $you .= '<span class="event_pill event_pill_' . $role . ' event_signed_up event_' . strtolower(events_role_verb($role)) . '">'
                      . events_role_verb($role, $ended) . '</span> ';
            }
        }
    }
    elseif(isset($user_waitlisted[(int)$event['id']]))
    {
        $you = '<span class="event_pill event_pill_waitlisted event_waitlisted">Waitlisted</span>';
    }
    elseif($lock_reason === null)
    {
        // The same rule as the event card's button (events_render_event_card()): one full
        // role is enough for the button to say it joins a waitlist.
        if(!empty(events_full_roles($event)))
        {
            $you = '<a class="event_btn event_signup_link" href="rsvp.php?id=' . (int)$event['id'] . '" data-waitlist="1">Join Waitlist</a>';
        }
        else
        {
            $you = '<a class="event_btn event_signup_link" href="rsvp.php?id=' . (int)$event['id'] . '">Sign Up</a>';
        }
    }
    else
    {
        $you = '<span class="event_pill event_pill_locked event_locked" data-lock-reason="' . htmlspecialchars_uni($lock_reason) . '"'
             . ' title="' . htmlspecialchars_uni(events_signup_lock_message($lock_reason)) . '">'
             . htmlspecialchars_uni(events_signup_lock_label($lock_reason, $event)) . '</span>';
    }

    $events_rows .= '<tr class="event_row" data-event-id="' . (int)$event['id'] . '" data-event-status="' . htmlspecialchars_uni($event['status']) . '">';
    // Under the title rather than in a column of its own: an address is as long as a
    // whole row of this table, and giving it a column would squeeze everything beside it.
    $address_link = events_address_link(isset($event['address']) ? $event['address'] : '', 'event_address_link');
    $address_line = $address_link === '' ? '' : '<span class="event_address">' . $address_link . '</span>';

    // A troop is what the listing is mostly made of, so only the exception is marked.
    $type_pill = events_is_social($event) ? ' <span class="event_pill event_pill_social event_type_social">Social</span>' : '';

    $events_rows .= '<td class="trow1 event_title"><a class="event_link" href="' . events_event_url($event) . '">'
        . htmlspecialchars_uni($event['title']) . '</a>' . $type_pill . $address_line . '</td>';
    if($has_regions)
    {
        $events_rows .= '<td class="trow1 event_region">' . htmlspecialchars_uni($event['region']) . '</td>';
    }
    $events_rows .= '<td class="trow1 event_start">'
        . events_format_list_date($event['start_date'], isset($event['end_date']) ? $event['end_date'] : null) . '</td>';
    // Abbreviated to T / W here (A for a social event's attendees): the column is narrow
    // and the pair repeats once per row. The event page shows the same lozenges with the
    // words spelled out - see events_signup_counts().
    $role_counts = array('trooper' => $event['rsvp_count'], 'wrangler' => $event['wrangler_count'], 'attendee' => $event['attendee_count']);
    $events_rows .= '<td class="trow1 event_counts">'
        . events_signup_counts(array_intersect_key($role_counts, array_flip(events_event_roles($event))))
        . '</td>';
    // events_status_label() owns what this reads, including the "Needs Troop Report" a
    // finished event with no posted report shows instead of "Live". The class is what
    // colours that one, since it is a job outstanding rather than a state.
    $needs_report = events_needs_troop_report($event);
    $events_rows .= '<td class="trow1 event_status' . ($needs_report ? ' event_status_needs_report' : '') . '">'
        . htmlspecialchars_uni(events_status_label($event)) . '</td>';
    $events_rows .= '<td class="trow1 event_you">' . $you . '</td>';
    $events_rows .= '</tr>';
}

if($events_rows === '')
{
    $events_rows = '<tr id="events_empty"><td class="trow1" colspan="' . $events_columns . '">There are no events to show.</td></tr>';
}

$events_print_header = events_print_header('Events', array($region_filter,
    $show_archived ? 'Including archived' : ''));

eval("\$page = \"" . $templates->get("events_list") . "\";");
output_page($page);

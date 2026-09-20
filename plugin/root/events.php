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

$view = $mybb->get_input('view') === 'calendar' ? 'calendar' : 'list';
$region_filter = $mybb->get_input('region');
if(!in_array($region_filter, events_regions(), true))
{
    $region_filter = '';
}

// Coordinators and admins also see events that are still pending.
$where = events_is_gec() ? "status IN ('pending','live','archived')" : "status IN ('live','archived')";
if($region_filter !== '')
{
    $where .= " AND region = '" . $db->escape_string($region_filter) . "'";
}

// Tracked per role, because the listing shows which way round the viewer is signed up -
// a mixed signup holds both, and reads as "Trooping" and "Wrangling" side by side.
$user_roles = array();
$rsvp_query = $db->simple_select("event_plugin_rsvps", "event_id, role",
    "user_id = " . (int)$mybb->user['uid'] . " AND status = 'attending'");
while($row = $db->fetch_array($rsvp_query))
{
    $user_roles[(int)$row['event_id']][] = events_rsvp_role($row['role']);
}

// The calendar only highlights "you are involved in this", so either role counts.
$user_rsvps = array_keys($user_roles);

$query = $db->query("
    SELECT e.*,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'trooper' AND r.status = 'attending') AS rsvp_count,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'wrangler' AND r.status = 'attending') AS wrangler_count
    FROM " . TABLE_PREFIX . "event_plugin_events e
    WHERE {$where}
    ORDER BY e.start_date ASC
");

$events = array();
while($event = $db->fetch_array($query))
{
    $events[] = $event;
}

$region_options = events_region_options($region_filter);

if($view === 'calendar')
{
    $month_input = $mybb->get_input('month');
    if(!preg_match('/^\d{4}-\d{2}$/', $month_input))
    {
        $month_input = my_date('Y-m', TIME_NOW, 0, 0);
    }

    $month_start = strtotime($month_input . '-01 00:00:00');
    $calendar_month = $month_input;
    $calendar_month_name = my_date('F Y', $month_start, 0, 0);
    $calendar_prev = date('Y-m', strtotime('-1 month', $month_start));
    $calendar_next = date('Y-m', strtotime('+1 month', $month_start));
    $calendar_content = events_calendar_grid($month_start, $events, $user_rsvps);

    $events_print_header = events_print_header('Events Calendar', array($calendar_month_name, $region_filter));

    eval("\$page = \"" . $templates->get("events_calendar") . "\";");
    output_page($page);
    exit;
}

$events_rows = '';
foreach($events as $event)
{
    $signed_up_as = isset($user_roles[(int)$event['id']]) ? $user_roles[(int)$event['id']] : array();
    $lock_reason = events_signup_lock_reason($event);

    // Note the pill text stays exactly "Trooping"/"Wrangling": the styling lives on the
    // class, so the labels remain the whole text content of those elements.
    if(!empty($signed_up_as))
    {
        $you = '';
        foreach(events_rsvp_roles() as $role)
        {
            if(in_array($role, $signed_up_as, true))
            {
                $you .= '<span class="event_pill event_pill_' . $role . ' event_signed_up event_' . strtolower(events_role_verb($role)) . '">'
                      . events_role_verb($role) . '</span> ';
            }
        }
    }
    elseif($lock_reason === null)
    {
        $you = '<a class="event_btn event_signup_link" href="rsvp.php?id=' . (int)$event['id'] . '">Sign Up</a>';
    }
    else
    {
        $you = '<span class="event_pill event_pill_locked event_locked" data-lock-reason="' . htmlspecialchars_uni($lock_reason) . '">'
             . htmlspecialchars_uni(events_signup_lock_message($lock_reason)) . '</span>';
    }

    $events_rows .= '<tr class="event_row" data-event-id="' . (int)$event['id'] . '" data-event-status="' . htmlspecialchars_uni($event['status']) . '">';
    $events_rows .= '<td class="trow1"><a class="event_link" href="event.php?id=' . (int)$event['id'] . '">' . htmlspecialchars_uni($event['title']) . '</a></td>';
    $events_rows .= '<td class="trow1 event_region">' . htmlspecialchars_uni($event['region']) . '</td>';
    $events_rows .= '<td class="trow1 event_start">' . events_format_date($event['start_date']) . '</td>';
    // Two lozenges rather than one number, so an event with only wranglers still reads as
    // "0 troopers, 1 wrangler" instead of an unexplained 0. The dot is backed up by a
    // title and a letter, so the breakdown does not depend on colour alone.
    $events_rows .= '<td class="trow1 event_counts">'
        . '<span class="event_count event_count_trooper" title="Troopers">'
        . '<span class="event_count_dot"></span><span class="event_rsvp_count">' . (int)$event['rsvp_count'] . '</span>'
        . '<span class="event_count_key">T</span></span>'
        . '<span class="event_count event_count_wrangler" title="Wranglers">'
        . '<span class="event_count_dot"></span><span class="event_wrangler_count">' . (int)$event['wrangler_count'] . '</span>'
        . '<span class="event_count_key">W</span></span>'
        . '</td>';
    $events_rows .= '<td class="trow1 event_status">' . htmlspecialchars_uni($event['status']) . '</td>';
    $events_rows .= '<td class="trow1 event_you">' . $you . '</td>';
    $events_rows .= '</tr>';
}

if($events_rows === '')
{
    $events_rows = '<tr id="events_empty"><td class="trow1" colspan="6">There are no events to show.</td></tr>';
}

$events_print_header = events_print_header('Events', array($region_filter));

eval("\$page = \"" . $templates->get("events_list") . "\";");
output_page($page);

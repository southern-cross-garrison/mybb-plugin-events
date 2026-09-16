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

if(!$mybb->user['uid'])
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

$user_rsvps = array();
$rsvp_query = $db->simple_select("event_plugin_rsvps", "event_id",
    "user_id = " . (int)$mybb->user['uid'] . " AND status = 'attending'");
while($row = $db->fetch_array($rsvp_query))
{
    $user_rsvps[] = (int)$row['event_id'];
}

$query = $db->query("
    SELECT e.*,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.status = 'attending') AS rsvp_count
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

    eval("\$page = \"" . $templates->get("events_calendar") . "\";");
    output_page($page);
    exit;
}

$events_rows = '';
foreach($events as $event)
{
    $rsvped = in_array((int)$event['id'], $user_rsvps);
    $lock_reason = events_rsvp_lock_reason($event);

    if($rsvped)
    {
        $you = '<span class="event_rsvped">Attending</span>';
    }
    elseif($lock_reason === null)
    {
        $you = '<a class="event_rsvp_link" href="rsvp.php?id=' . (int)$event['id'] . '">RSVP</a>';
    }
    else
    {
        $you = '<span class="event_locked" data-lock-reason="' . htmlspecialchars_uni($lock_reason) . '">'
             . htmlspecialchars_uni(events_rsvp_lock_message($lock_reason)) . '</span>';
    }

    $events_rows .= '<tr class="event_row" data-event-id="' . (int)$event['id'] . '" data-event-status="' . htmlspecialchars_uni($event['status']) . '">';
    $events_rows .= '<td class="trow1"><a class="event_link" href="event.php?id=' . (int)$event['id'] . '">' . htmlspecialchars_uni($event['title']) . '</a></td>';
    $events_rows .= '<td class="trow1 event_region">' . htmlspecialchars_uni($event['region']) . '</td>';
    $events_rows .= '<td class="trow1 event_start">' . events_format_date($event['start_date']) . '</td>';
    $events_rows .= '<td class="trow1 event_rsvp_count">' . (int)$event['rsvp_count'] . '</td>';
    $events_rows .= '<td class="trow1 event_status">' . htmlspecialchars_uni($event['status']) . '</td>';
    $events_rows .= '<td class="trow1 event_you">' . $you . '</td>';
    $events_rows .= '</tr>';
}

if($events_rows === '')
{
    $events_rows = '<tr id="events_empty"><td class="trow1" colspan="6">There are no events to show.</td></tr>';
}

eval("\$page = \"" . $templates->get("events_list") . "\";");
output_page($page);

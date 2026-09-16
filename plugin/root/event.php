<?php
/**
 * MyBB Event Plugin - Single event view, coordinator RSVP list and attendance sheet
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "event.php");

$templatelist = "events_event,events_rsvp_list,events_attendance";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
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

$action = $mybb->get_input('action');
$is_gec = events_is_event_gec($event_id);
$event_days = events_get_event_days($event_id);

add_breadcrumb("Events", "events.php");
add_breadcrumb($event['title'], "event.php?id=" . $event_id);

$event_title = htmlspecialchars_uni($event['title']);
$filter_costume = $mybb->get_input('filter_costume');
$filter_day = $mybb->get_input('filter_day', MyBB::INPUT_INT);

// ---------------------------------------------------------------------------
// Attendance sheet
// ---------------------------------------------------------------------------
if($action === 'attendance')
{
    if(!$is_gec)
    {
        error_no_permission();
    }

    add_breadcrumb("Attendance Sheet", "event.php?id=" . $event_id . "&amp;action=attendance");

    $attendees = events_get_attendees($event_id, array('day' => $filter_day));

    $attendance_day_heading = '';
    $attendance_day_filter = '';

    if(!empty($event_days))
    {
        $options = '<option value="0">All days</option>';
        foreach($event_days as $day)
        {
            $selected = ($filter_day === (int)$day['id']) ? ' selected="selected"' : '';
            $options .= '<option value="' . (int)$day['id'] . '"' . $selected . '>' . events_day_label($day) . '</option>';

            if($filter_day === (int)$day['id'])
            {
                $attendance_day_heading = '<h4 id="attendance_day">' . events_day_label($day) . '</h4>';
            }
        }

        $attendance_day_filter = '<form method="get" action="event.php" id="attendance_day_form">'
            . '<input type="hidden" name="id" value="' . $event_id . '" />'
            . '<input type="hidden" name="action" value="attendance" />'
            . '<label>Day: <select name="filter_day" id="attendance_filter_day">' . $options . '</select></label> '
            . '<input type="submit" class="button" value="Show" />'
            . '</form>';
    }

    $attendees_rows = '';
    $position = 0;
    foreach($attendees as $attendee)
    {
        $position++;
        $attendees_rows .= '<tr class="attendee_row" data-uid="' . $attendee['uid'] . '">';
        $attendees_rows .= '<td>' . $position . '</td>';
        $attendees_rows .= '<td class="attendee_username">' . htmlspecialchars_uni($attendee['username']) . '</td>';
        $attendees_rows .= '<td class="attendee_tkid">' . htmlspecialchars_uni($attendee['tk_id']) . '</td>';
        $attendees_rows .= '<td class="attendee_costumes">' . htmlspecialchars_uni(implode(', ', $attendee['costumes'])) . '</td>';
        $attendees_rows .= '<td class="attendee_mobile">' . htmlspecialchars_uni($attendee['mobile']) . '</td>';
        $attendees_rows .= '<td class="attendee_emergency">' . htmlspecialchars_uni($attendee['emergency_contact']) . '</td>';
        $attendees_rows .= '<td class="attendee_signature">&nbsp;</td>';
        $attendees_rows .= '</tr>';
    }

    if($attendees_rows === '')
    {
        $attendees_rows = '<tr id="attendance_empty"><td colspan="7">No attendees yet.</td></tr>';
    }

    eval("\$page = \"" . $templates->get("events_attendance") . "\";");
    output_page($page);
    exit;
}

// ---------------------------------------------------------------------------
// Event detail
// ---------------------------------------------------------------------------
$event_status = htmlspecialchars_uni($event['status']);
$event_region = htmlspecialchars_uni($event['region']);
$event_start_date = events_format_date($event['start_date']);
$event_end_date = events_format_date($event['end_date']);
$event_description = nl2br(htmlspecialchars_uni($event['description']));
$rsvp_count = events_rsvp_count($event_id);

$event_cutoff_row = '';
if(!empty($event['signup_cutoff']) && $event['signup_cutoff'] !== '0000-00-00 00:00:00')
{
    $event_cutoff_row = '<p><strong>Signups close:</strong> <span id="event_cutoff">' . events_format_date($event['signup_cutoff']) . '</span></p>';
}

$event_wwcc_row = '';
if(!empty($event['requires_wwcc']))
{
    $event_wwcc_row = '<p id="event_requires_wwcc"><strong>Requires WWCC:</strong> Yes</p>';
}

$event_days_block = '';
if(!empty($event_days))
{
    $items = '';
    foreach($event_days as $day)
    {
        $items .= '<li class="event_day" data-day-id="' . (int)$day['id'] . '">' . events_day_label($day) . '</li>';
    }
    $event_days_block = '<div id="event_days"><h3>Event Days</h3><ul>' . $items . '</ul></div>';
}

$has_rsvped = events_has_rsvped($event_id);
$lock_reason = events_rsvp_lock_reason($event);

$event_actions = '';
if($has_rsvped)
{
    $event_actions .= '<span id="event_rsvp_status">You have RSVPed to this event</span> ';
    $event_actions .= '<a href="ical.php?id=' . $event_id . '" id="event_ical">Download iCal</a> ';
}
elseif($lock_reason === null)
{
    $event_actions .= '<a href="rsvp.php?id=' . $event_id . '" id="event_rsvp">RSVP to Event</a> ';
}
else
{
    $event_actions .= '<span id="event_rsvp_locked" data-lock-reason="' . htmlspecialchars_uni($lock_reason) . '">'
                    . htmlspecialchars_uni(events_rsvp_lock_message($lock_reason)) . '</span> ';
}

if(!empty($event['thread_id']))
{
    $event_actions .= '<a href="showthread.php?tid=' . (int)$event['thread_id'] . '" id="event_thread">View Discussion Thread</a> ';
}

if(events_can_create_troop_report($event))
{
    $event_actions .= '<a href="troop_report.php?id=' . $event_id . '" id="event_troop_report">Create Troop Report</a> ';
}

$report = events_get_troop_report($event_id);
if($report && !empty($report['posted_at']) && !empty($report['thread_id']))
{
    $event_actions .= '<a href="showthread.php?tid=' . (int)$report['thread_id'] . '" id="event_troop_report_posted">View Troop Report</a> ';
}

// ---------------------------------------------------------------------------
// Coordinator controls
// ---------------------------------------------------------------------------
$gec_block = '';
if($is_gec)
{
    $gec_block = '<div id="gec_controls"><h3>Coordinator Controls</h3>'
        . '<a href="event.php?id=' . $event_id . '&amp;action=rsvps" id="gec_view_rsvps">View RSVPs</a> | '
        . '<a href="event.php?id=' . $event_id . '&amp;action=attendance" id="gec_attendance">View Attendance Sheet</a>'
        . '</div>';

    if($action === 'rsvps')
    {
        $attendees = events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day));

        $filter_day_select = '';
        if(!empty($event_days))
        {
            $options = '<option value="0">All days</option>';
            foreach($event_days as $day)
            {
                $selected = ($filter_day === (int)$day['id']) ? ' selected="selected"' : '';
                $options .= '<option value="' . (int)$day['id'] . '"' . $selected . '>' . events_day_label($day) . '</option>';
            }
            $filter_day_select = '<label>Day: <select name="filter_day" id="filter_day">' . $options . '</select></label> ';
        }

        $rsvp_rows = '';
        foreach($attendees as $attendee)
        {
            $day_labels = array();
            foreach($attendee['days'] as $day)
            {
                $day_labels[] = events_day_short_label($day);
            }

            $rsvp_rows .= '<tr class="rsvp_row" data-uid="' . $attendee['uid'] . '">';
            $rsvp_rows .= '<td class="trow1 rsvp_username">' . htmlspecialchars_uni($attendee['username']) . '</td>';
            $rsvp_rows .= '<td class="trow1 rsvp_tkid">' . htmlspecialchars_uni($attendee['tk_id']) . '</td>';
            $rsvp_rows .= '<td class="trow1 rsvp_costumes">' . htmlspecialchars_uni(implode(', ', $attendee['costumes'])) . '</td>';
            $rsvp_rows .= '<td class="trow1 rsvp_days">' . htmlspecialchars_uni(implode(', ', $day_labels)) . '</td>';
            $rsvp_rows .= '<td class="trow1 rsvp_date">' . events_format_date($attendee['rsvp_date']) . '</td>';
            $rsvp_rows .= '</tr>';
        }

        if($rsvp_rows === '')
        {
            $rsvp_rows = '<tr id="rsvp_list_empty"><td class="trow1" colspan="5">No RSVPs yet.</td></tr>';
        }

        $filter_costume = htmlspecialchars_uni($filter_costume);

        eval("\$rsvp_list = \"" . $templates->get("events_rsvp_list") . "\";");
        $gec_block .= $rsvp_list;
    }
}

eval("\$page = \"" . $templates->get("events_event") . "\";");
output_page($page);

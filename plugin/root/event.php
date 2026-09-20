<?php
/**
 * MyBB Event Plugin - Single event view with its signup list, and the attendance sheet
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
// Read defensively: an event written before the column existed has no key at all until the
// board has been re-activated, and both the sheet and the page below want it.
$event_address = isset($event['address']) ? trim((string)$event['address']) : '';
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

    // Fetched a role at a time rather than sorted in SQL: MySQL orders ENUMs by their
    // declaration ordinal, which only matches alphabetical order here by coincidence.
    // Troopers first, then the people who are only wrangling.
    $signups = array_merge(
        events_get_attendees($event_id, array('day' => $filter_day, 'role' => 'trooper')),
        events_get_attendees($event_id, array('day' => $filter_day, 'role' => 'wrangler'))
    );

    // One line per person rather than per role. Somebody trooping the Saturday and
    // wrangling the Sunday is one human to tick off on the day, and it is their day list
    // that says which way round - two rows would mean two ticks for one person.
    $attendees = array();
    foreach($signups as $signup_row)
    {
        $uid = (int)$signup_row['uid'];

        if(!isset($attendees[$uid]))
        {
            $attendees[$uid] = $signup_row;
            $attendees[$uid]['roles'] = array();
            $attendees[$uid]['role_days'] = array();
            $attendees[$uid]['costumes'] = array();
        }

        $attendees[$uid]['roles'][] = $signup_row['role'];

        $day_ids = array();
        foreach($signup_row['days'] as $day)
        {
            $day_ids[] = (int)$day['id'];
        }
        $attendees[$uid]['role_days'][$signup_row['role']] = $day_ids;

        // Only the trooper half of a signup carries costumes.
        if($signup_row['role'] === 'trooper')
        {
            $attendees[$uid]['costumes'] = $signup_row['costumes'];
        }
    }
    $attendees = array_values($attendees);

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

        $attendance_day_filter = '<form method="get" action="event.php" id="attendance_day_form" class="events_filter_form">'
            . '<input type="hidden" name="id" value="' . $event_id . '" />'
            . '<input type="hidden" name="action" value="attendance" />'
            . '<label>Day: <select name="filter_day" id="attendance_filter_day" class="events_select">' . $options . '</select></label> '
            . '<input type="submit" class="button" value="Show" />'
            . '</form>';
    }

    // The Days column only exists for an event that has days to list, so the header is
    // built here rather than sitting static in the template.
    $attendance_columns = array(
        'attendee_num'       => '#',
        'attendee_username'  => 'Username',
        'attendee_role'      => 'Role',
        'attendee_tkid'      => 'Legion ID',
        'attendee_costumes'  => 'Costumes',
    );

    if(!empty($event_days))
    {
        $attendance_columns['attendee_days'] = 'Days';
    }

    $attendance_columns['attendee_mobile'] = 'Mobile';
    $attendance_columns['attendee_emergency'] = 'Emergency Contact';
    $attendance_columns['attendee_attended'] = 'Attended';

    $attendance_headers = '<tr>';
    foreach($attendance_columns as $class => $label)
    {
        $attendance_headers .= '<th class="' . $class . '">' . $label . '</th>';
    }
    $attendance_headers .= '</tr>';

    $attendance_colspan = count($attendance_columns);
    // Drives the column widths, which differ by one column between the two layouts.
    $attendance_table_class = !empty($event_days) ? 'has_days' : '';

    $attendees_rows = '';
    $position = 0;
    foreach($attendees as $attendee)
    {
        $position++;
        $attendees_rows .= '<tr class="attendee_row" data-uid="' . $attendee['uid'] . '">';
        $attendees_rows .= '<td class="attendee_num">' . $position . '</td>';
        $attendees_rows .= '<td class="attendee_username">' . htmlspecialchars_uni($attendee['username']) . '</td>';
        $attendees_rows .= '<td class="attendee_role">'
            . htmlspecialchars_uni(implode(' / ', array_map('events_role_label', array_unique($attendee['roles'])))) . '</td>';
        $attendees_rows .= '<td class="attendee_tkid">' . htmlspecialchars_uni($attendee['tk_id']) . '</td>';
        $attendees_rows .= '<td class="attendee_costumes">' . htmlspecialchars_uni(implode(', ', $attendee['costumes'])) . '</td>';

        if(!empty($event_days))
        {
            // Filtering to one day is a question about that day, so the answer names it
            // rather than reciting the rest of the signup around it.
            $role_days = $attendee['role_days'];
            if($filter_day)
            {
                foreach($role_days as $role => $day_ids)
                {
                    $role_days[$role] = array_values(array_intersect($day_ids, array($filter_day)));
                    if(empty($role_days[$role]))
                    {
                        unset($role_days[$role]);
                    }
                }
            }

            $day_items = events_attendance_day_items($event_days, $role_days);
            $day_items = array_map('htmlspecialchars_uni', $day_items);

            // A single answer is a sentence, not a list; more than one gets bullets.
            $days_cell = (count($day_items) > 1)
                ? '<ul class="attendee_days_list"><li>' . implode('</li><li>', $day_items) . '</li></ul>'
                : implode('', $day_items);

            $attendees_rows .= '<td class="attendee_days">' . $days_cell . '</td>';
        }

        $attendees_rows .= '<td class="attendee_mobile">' . htmlspecialchars_uni($attendee['mobile']) . '</td>';
        $attendees_rows .= '<td class="attendee_emergency">' . htmlspecialchars_uni($attendee['emergency_contact']) . '</td>';
        // A real checkbox rather than a drawn box, so a coordinator can tick people off on
        // screen and print the sheet with those ticks already on it - the print comes off
        // the live page, so its state goes with it.
        $attendees_rows .= '<td class="attendee_attended">'
            . '<input type="checkbox" class="attendee_tick" aria-label="Attended: '
            . htmlspecialchars_uni($attendee['username']) . '" /></td>';
        $attendees_rows .= '</tr>';
    }

    if($attendees_rows === '')
    {
        $attendees_rows = '<tr id="attendance_empty"><td colspan="' . $attendance_colspan . '">No attendees yet.</td></tr>';
    }

    // The printed sheet leaves the board behind, so the facts a coordinator needs on the
    // clipboard - which event, where, when, and how many people to tick off - ride along
    // in the masthead rather than being left on the screen behind them.
    // The address goes on the clipboard as plain text: a link is no use on paper, and the
    // sheet is the one thing a coordinator has in their hand on the way to the venue.
    $events_print_header = events_print_header(
        $event['title'],
        array(
            $event['region'],
            $event_address,
            events_format_date($event['start_date']),
            count($attendees) . ' ' . (count($attendees) === 1 ? 'attendee' : 'attendees'),
        ),
        'Attendance Sheet'
    );

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
$rsvp_count = events_rsvp_count($event_id, 'trooper');
$wrangler_count = events_rsvp_count($event_id, 'wrangler');

// Built here rather than sat in the template, because an event with no address has no
// row at all and a MyBB template cannot ask.
$event_address_row = '';
$event_address_link = events_address_link($event_address, 'event_address_link');
if($event_address_link !== '')
{
    $event_address_row = '<p><strong>Address:</strong> <span id="event_address">' . $event_address_link . '</span></p>';
}

$event_cutoff_row = '';
if(!empty($event['signup_cutoff']) && $event['signup_cutoff'] !== '0000-00-00 00:00:00')
{
    $event_cutoff_row = '<p><strong>Signups close:</strong> <span id="event_cutoff">' . events_format_date($event['signup_cutoff']) . '</span></p>';
}

$event_wrangler_row = '<p><strong>Wranglers:</strong> <span id="event_wrangler_count">' . $wrangler_count . '</span></p>';

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
    $event_days_block = '<div id="event_days"><h3 class="events_section_heading">Event Days</h3><ul>' . $items . '</ul></div>';
}

$signup = events_get_user_signup($event_id);
$has_signup = !empty($signup);
$lock_reason = events_signup_lock_reason($event);

// The signup call to action is styled as a button (see the events_event template) with
// the primary colour matching the trooper dot on the events listing. Everything that is
// not the signup is a secondary button, so signing up stays the obvious thing to do.
$event_actions = '';
if($has_signup)
{
    // One pill per role held, each naming the days it covers, so a mixed signup reads
    // back as what it is rather than as a single "you are attending".
    foreach(events_rsvp_roles() as $role)
    {
        if(!isset($signup[$role]))
        {
            continue;
        }

        // Days are only spelled out when the role covers some of them. "Trooping" says
        // everything there is to say about a signup that covers the whole event.
        $label = events_role_verb($role);
        $day_labels = events_day_labels($event_days, $signup[$role]['days'], 'short');
        if(!empty($day_labels) && count($day_labels) < count($event_days))
        {
            $label .= ': ' . implode(', ', $day_labels);
        }

        $event_actions .= '<span class="event_action_status event_signup_status event_action_status_' . $role . '" id="event_signup_status_' . $role . '">'
                        . '<span class="event_signup_tick">&#10003;</span> ' . htmlspecialchars_uni($label) . '</span>';
    }

    if($lock_reason === null)
    {
        $event_actions .= '<a class="event_action event_action_secondary" href="rsvp.php?id=' . $event_id . '" id="event_signup_update">Update Your Signup</a>';
    }
}
elseif($lock_reason === null)
{
    $event_actions .= '<a class="event_action event_action_primary" href="rsvp.php?id=' . $event_id . '" id="event_signup">Sign Up to Attend</a>';
}
else
{
    $event_actions .= '<span class="event_action event_action_locked" id="event_signup_locked" data-lock-reason="' . htmlspecialchars_uni($lock_reason) . '">'
                    . htmlspecialchars_uni(events_signup_lock_message($lock_reason)) . '</span>';
}

// A wrangler is attending too, so any signup gets the calendar file.
if($has_signup)
{
    $event_actions .= '<a class="event_action event_action_secondary" href="ical.php?id=' . $event_id . '" id="event_ical">Add to Calendar</a>';
}

if(!empty($event['thread_id']))
{
    $event_actions .= '<a class="event_action event_action_secondary" href="showthread.php?tid=' . (int)$event['thread_id'] . '" id="event_thread">View Discussion Thread</a>';
}

if(events_can_create_troop_report($event))
{
    $event_actions .= '<a class="event_action event_action_secondary" href="troop_report.php?id=' . $event_id . '" id="event_troop_report">Create Troop Report</a>';
}

$report = events_get_troop_report($event_id);
if($report && !empty($report['posted_at']) && !empty($report['thread_id']))
{
    $event_actions .= '<a class="event_action event_action_secondary" href="showthread.php?tid=' . (int)$report['thread_id'] . '" id="event_troop_report_posted">View Troop Report</a>';
}

// ---------------------------------------------------------------------------
// Coordinator controls
// ---------------------------------------------------------------------------
$gec_block = '';
if($is_gec)
{
    // Built with the same tborder/thead/trow structure as the plugin's templates, so the
    // block picks up a theme's table styling like everything else rather than sitting on
    // the page as a bare heading.
    $gec_block = '<table border="0" cellspacing="' . (int)$theme['borderwidth'] . '" cellpadding="' . (int)$theme['tablespace'] . '" class="tborder" id="gec_controls">'
        . '<tr><td class="thead"><strong>Coordinator Controls</strong></td></tr>'
        . '<tr><td class="trow1"><div class="gec_actions">'
        . '<a class="event_action event_action_secondary" href="manage_event.php?id=' . $event_id . '" id="gec_edit">Edit Event</a>'
        . '<a class="event_action event_action_secondary" href="event.php?id=' . $event_id . '&amp;action=attendance" id="gec_attendance">View Attendance Sheet</a>'
        . '</div></td></tr></table>';
}

// ---------------------------------------------------------------------------
// Signup list
// ---------------------------------------------------------------------------
// Anyone who can see the event can see who is going, so the list is part of the event
// page rather than something to go and fetch. It carries no contact details - mobile and
// emergency contact live on the attendance sheet, which stays behind
// events_is_event_gec() above.
// The costume filter can only ever match troopers, so wranglers drop out of a
// filtered list by definition. That is intended, not an oversight.
$attendees = array_merge(
    events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day, 'role' => 'trooper')),
    events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day, 'role' => 'wrangler'))
);

$filter_day_select = '';
if(!empty($event_days))
{
    $options = '<option value="0">All days</option>';
    foreach($event_days as $day)
    {
        $selected = ($filter_day === (int)$day['id']) ? ' selected="selected"' : '';
        $options .= '<option value="' . (int)$day['id'] . '"' . $selected . '>' . events_day_label($day) . '</option>';
    }
    $filter_day_select = '<label>Day: <select name="filter_day" id="filter_day" class="events_select">' . $options . '</select></label> ';
}

$rsvp_rows = '';
foreach($attendees as $attendee)
{
    $attended_day_ids = array();
    foreach($attendee['days'] as $day)
    {
        $attended_day_ids[] = (int)$day['id'];
    }
    $day_labels = events_day_labels($event_days, $attended_day_ids, 'short');

    // Only the parts a person actually has. A wrangler carries no Legion ID and no
    // costume, and an event with no days has no days to name - an empty span each time
    // would leave the separator dots hanging off the end of the line.
    $details = array(
        'rsvp_tkid'     => htmlspecialchars_uni($attendee['tk_id']),
        'rsvp_costumes' => htmlspecialchars_uni(implode(', ', $attendee['costumes'])),
        'rsvp_days'     => htmlspecialchars_uni(implode(', ', $day_labels)),
        'rsvp_date'     => events_format_date($attendee['rsvp_date']),
    );

    $rsvp_rows .= '<li class="rsvp_row" data-uid="' . $attendee['uid'] . '">';
    $rsvp_rows .= '<span class="rsvp_username">' . htmlspecialchars_uni($attendee['username']) . '</span>';
    $rsvp_rows .= '<span class="rsvp_role event_pill event_pill_' . $attendee['role'] . '">'
                . events_role_label($attendee['role']) . '</span>';

    foreach($details as $class => $value)
    {
        if($value === '')
        {
            continue;
        }

        $rsvp_rows .= '<span class="rsvp_detail ' . $class . '">' . $value . '</span>';
    }

    $rsvp_rows .= '</li>';
}

$rsvp_list_count = count($attendees);

if($rsvp_rows === '')
{
    $rsvp_rows = '<li id="rsvp_list_empty">Nobody has signed up yet.</li>';
}

// A filter that is doing something stays on show, so a short list is never a mystery:
// the panel that explains why it is short is already open above it.
$rsvp_filter_open = ($filter_costume !== '' || $filter_day) ? ' open' : '';

$filter_costume = htmlspecialchars_uni($filter_costume);

eval("\$rsvp_list = \"" . $templates->get("events_rsvp_list") . "\";");

$events_print_header = events_print_header($event['title'], array(
    $event['region'],
    $event_address,
    events_format_date($event['start_date']),
));

eval("\$page = \"" . $templates->get("events_event") . "\";");
output_page($page);

<?php
/**
 * MyBB Event Plugin - Single event view with its signup list, and the attendance sheet
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "event.php");

$templatelist = "events_event,events_event_card,events_rsvp_list,events_attendance";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_event_card.php";

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
add_breadcrumb(htmlspecialchars_uni($event['title']), "event.php?id=" . $event_id);

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
    // The order the two come back in does not matter here - the sheet is sorted by name
    // below, once the two roles have been folded into one row per person.
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

    // Sorted by the name that will be called out rather than by the forum handle beside
    // it: the sheet is read down while people are ticked off at a staging area, and a
    // roll called in username order is a roll called in an order nobody present knows.
    //
    // Somebody with the field empty sorts under their username, which is the only other
    // name the sheet has for them - blanks gathered at one end would be exactly the rows
    // that are hardest to find. The username also breaks ties, so two people who go by
    // the same name keep a stable order between loads rather than swapping places.
    usort($attendees, 'events_compare_by_preferred_name');

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

    // Each attendee is two rows, not one. Ten columns of who-they-are and how-to-reach-them
    // across a portrait A4 sheet leaves every one of them too narrow to read, let alone
    // write in, so the identity half goes on the first row and the contact half on the
    // second - the number and the tick box spanning both, because there is still only one
    // person to count and one box to tick.
    //
    // The Days column only exists for an event that has days to list, so the header is
    // built here rather than sitting static in the template.
    $attendance_identity_columns = array(
        'attendee_preferred_name' => 'Preferred Name',
        'attendee_username'       => 'Username',
        'attendee_role'           => 'Role',
        'attendee_tkid'           => 'Legion ID',
    );

    if(!empty($event_days))
    {
        $attendance_identity_columns['attendee_days'] = 'Days';
    }

    // The second row says the same three things whatever the event, so it is laid over the
    // first row's columns rather than having any of its own: costumes take two of them,
    // the mobile one, and the emergency contact whatever is left - which is one column
    // more on an event that has a Days column to absorb.
    $attendance_contact_columns = array(
        'attendee_costumes'  => array('label' => 'Costumes', 'span' => 2),
        'attendee_mobile'    => array('label' => 'Mobile', 'span' => 1),
        'attendee_emergency' => array('label' => 'Emergency Contact', 'span' => count($attendance_identity_columns) - 3),
    );

    $attendance_headers = '<tr class="attendance_identity_head">'
        . '<th class="attendee_num" rowspan="2">#</th>';
    foreach($attendance_identity_columns as $class => $label)
    {
        $attendance_headers .= '<th class="' . $class . '">' . $label . '</th>';
    }
    $attendance_headers .= '<th class="attendee_attended" rowspan="2">Attended</th></tr>';

    $attendance_headers .= '<tr class="attendance_contact_head">';
    foreach($attendance_contact_columns as $class => $column)
    {
        $attendance_headers .= '<th class="' . $class . '" colspan="' . $column['span'] . '">' . $column['label'] . '</th>';
    }
    $attendance_headers .= '</tr>';

    // The number and the tick box either side of the identity columns.
    $attendance_colspan = count($attendance_identity_columns) + 2;
    // Drives the column widths, which differ by one column between the two layouts.
    $attendance_table_class = !empty($event_days) ? 'has_days' : '';

    $attendees_rows = '';
    $position = 0;
    foreach($attendees as $attendee)
    {
        $position++;

        // One <tbody> per attendee, so the pair of rows is a thing the stylesheet can
        // band, rule off and keep on one page - none of which is sayable about two
        // sibling <tr>s that only happen to be next to each other.
        $attendees_rows .= '<tbody class="attendee_group" data-uid="' . $attendee['uid'] . '">';

        $attendees_rows .= '<tr class="attendee_row" data-uid="' . $attendee['uid'] . '">';
        // A real checkbox rather than a drawn box, so a coordinator can tick people off on
        // screen and print the sheet with those ticks already on it - the print comes off
        // the live page, so its state goes with it. It spans both rows for the same reason
        // the number does: one person, one tick.
        $attendees_rows .= '<td class="attendee_num" rowspan="2">' . $position . '</td>';
        $attendees_rows .= '<td class="attendee_preferred_name">' . htmlspecialchars_uni($attendee['preferred_name']) . '</td>';
        $attendees_rows .= '<td class="attendee_username">' . htmlspecialchars_uni($attendee['username']) . '</td>';
        // The point of contact is the one person on the sheet somebody on the day will come
        // looking for, so that is what their role says rather than which hat they signed up
        // in. Only attendees are on the sheet at all, so a contact who has withdrawn simply
        // is not here to be labelled.
        $attendee_role = ((int)$attendee['uid'] === (int)$event['poc_user_id'])
            ? 'Point of Contact'
            : implode(' / ', array_map('events_role_label', array_unique($attendee['roles'])));
        $attendees_rows .= '<td class="attendee_role">' . htmlspecialchars_uni($attendee_role) . '</td>';
        $attendees_rows .= '<td class="attendee_tkid">' . htmlspecialchars_uni($attendee['tk_id']) . '</td>';

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

        $attendees_rows .= '<td class="attendee_attended" rowspan="2">'
            . '<input type="checkbox" class="attendee_tick" aria-label="Attended: '
            . htmlspecialchars_uni($attendee['username']) . '" /></td>';
        $attendees_rows .= '</tr>';

        // The contact half, laid over the identity row's columns - the spans are the ones
        // the header row was built with, or the two halves would not line up.
        $contact_cells = array(
            'attendee_costumes'  => implode(', ', $attendee['costumes']),
            'attendee_mobile'    => $attendee['mobile'],
            'attendee_emergency' => $attendee['emergency_contact'],
        );

        $attendees_rows .= '<tr class="attendee_row_contact">';
        foreach($contact_cells as $class => $value)
        {
            $attendees_rows .= '<td class="' . $class . '" colspan="' . $attendance_contact_columns[$class]['span'] . '">'
                . htmlspecialchars_uni($value) . '</td>';
        }
        $attendees_rows .= '</tr></tbody>';
    }

    if($attendees_rows === '')
    {
        $attendees_rows = '<tbody><tr id="attendance_empty"><td colspan="' . $attendance_colspan . '">No attendees yet.</td></tr></tbody>';
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
// An event with an announcement thread is read *in* that thread, with the card standing
// in for the thread's first post (see events_thread_postbit()), so this page hands the
// viewer over to it. What stays here is everything that has no thread to be shown in: a
// pending draft, an event whose region has no forum, and one whose thread this member
// cannot open - a forum they have no access to is not a reason to lose the event too.
//
// A plain 302 rather than MyBB's redirect(), which would stop on an interstitial page
// for what is only a change of address. The signup list's filters ride along, so a
// filtered link to the old page still lands on a filtered list.
$event_thread = events_event_thread($event);
if($event_thread)
{
    $params = array('tid' => (int)$event_thread['tid']);
    if($filter_costume !== '')
    {
        $params['filter_costume'] = $filter_costume;
    }
    if($filter_day)
    {
        $params['filter_day'] = $filter_day;
    }

    header("Location: " . $mybb->settings['bburl'] . "/showthread.php?" . http_build_query($params, '', '&'));
    exit;
}

$event_card = events_render_event_card($event);

eval("\$page = \"" . $templates->get("events_event") . "\";");
output_page($page);

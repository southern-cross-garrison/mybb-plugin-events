<?php
/**
 * MyBB Event Plugin - RSVP review in the Admin CP
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

function events_admin_rsvps()
{
    global $mybb, $db, $page;

    if(!events_is_gec())
    {
        flash_message("You do not have permission to access this page.", "error");
        admin_redirect("index.php");
    }

    $event_id = $mybb->get_input('event_id', MyBB::INPUT_INT);

    $where = "1=1";
    if(!events_user_can_admin($mybb->user))
    {
        $where = "(gec_user_id = " . (int)$mybb->user['uid'] . " OR created_by = " . (int)$mybb->user['uid'] . ")";
    }

    $events = array('' => 'Select an event...');
    $query = $db->simple_select("event_plugin_events", "id, title, start_date", $where, array("order_by" => "start_date", "order_dir" => "DESC"));
    while($event = $db->fetch_array($query))
    {
        $events[$event['id']] = htmlspecialchars_uni($event['title'] . " (" . events_format_date($event['start_date']) . ")");
    }

    $filter_costume = $mybb->get_input('filter_costume');
    $filter_day = $mybb->get_input('filter_day', MyBB::INPUT_INT);

    $event = $event_id && isset($events[$event_id]) ? events_get_event($event_id) : null;
    $event_days = $event ? events_get_event_days($event_id) : array();

    $day_choices = array('' => 'All days');
    foreach($event_days as $day)
    {
        $day_choices[$day['id']] = events_day_label($day);
    }

    $form = new Form("index.php?module=events&amp;action=rsvps", "get");
    echo $form->generate_hidden_field("module", "events");
    echo $form->generate_hidden_field("action", "rsvps");

    $container = new FormContainer("Filters");
    $container->output_row("Event", "", $form->generate_select_box("event_id", $events, $event_id, array("id" => "event_id")), "event_id");
    $container->output_row("Costume", "Matches any part of a costume name", $form->generate_text_box("filter_costume", $filter_costume, array("id" => "filter_costume")), "filter_costume");
    $container->output_row("Day", "", $form->generate_select_box("filter_day", $day_choices, $filter_day, array("id" => "filter_day")), "filter_day");
    $container->end();

    $form->output_submit_wrapper(array($form->generate_submit_button("Apply Filters")));
    $form->end();

    if(!$event)
    {
        return;
    }

    // Nobody at a social event is in costume, so there the costume filter would only ever
    // empty the list, and the Legion ID and costume columns would only ever be blank.
    $is_social = events_is_social($event);
    if($is_social)
    {
        $filter_costume = '';
    }

    $attendees = array();
    $waiting = array();
    foreach(events_event_roles($event) as $role)
    {
        $filters = array('costume' => $filter_costume, 'day' => $filter_day, 'role' => $role);
        $attendees = array_merge($attendees, events_get_attendees($event_id, $filters));
        $waiting = array_merge($waiting, events_get_attendees($event_id, $filters + array('status' => 'waitlisted')));
    }

    // The waitlist, in the order its places will be given out rather than by name.
    usort($waiting, function($a, $b) {
        $compared = strcmp($a['queued_at'], $b['queued_at']);
        return $compared !== 0 ? $compared : $a['rsvp_id'] - $b['rsvp_id'];
    });

    // One table for each list, the same columns in both. Each column is a header, its
    // width, and what it says about one signup.
    $columns = array(
        'user'     => array("User", 16, function($member) {
            return "<a href=\"index.php?module=user-users&amp;action=edit&amp;uid=" . $member['uid'] . "\">" . htmlspecialchars_uni($member['username']) . "</a>";
        }),
        'role'     => array("Role", 8, function($member) { return events_role_label($member['role']); }),
        'tk_id'    => array("Legion ID", 12, function($member) { return htmlspecialchars_uni($member['tk_id']); }),
        'costumes' => array("Costumes", 26, function($member) { return htmlspecialchars_uni(implode(', ', $member['costumes'])); }),
        'days'     => array("Days Attending", 18, function($member) use ($event_days) {
            $day_ids = array();
            foreach($member['days'] as $day)
            {
                $day_ids[] = (int)$day['id'];
            }
            return htmlspecialchars_uni(implode(', ', events_day_labels($event_days, $day_ids, 'short')));
        }),
        'mobile'   => array("Mobile", 12, function($member) { return htmlspecialchars_uni($member['mobile']); }),
        'date'     => array("RSVPed", 12, function($member) { return events_format_date($member['rsvp_date']); }),
    );
    if($is_social)
    {
        unset($columns['tk_id'], $columns['costumes']);
        $columns['user'][1] = 30;
        $columns['days'][1] = 26;
    }

    $render = function(array $members, $title, array $columns, array $row_options) {
        $table = new Table;
        foreach($columns as $column)
        {
            $table->construct_header($column[0], array("width" => $column[1] . "%"));
        }

        foreach($members as $member)
        {
            foreach($columns as $column)
            {
                $table->construct_cell($column[2]($member));
            }
            $table->construct_row($row_options);
        }

        if($table->num_rows() == 0)
        {
            $table->construct_cell("No RSVPs found.", array("colspan" => count($columns)));
            $table->construct_row();
        }

        $table->output($title);
    };

    $render($attendees, "RSVPs for: " . htmlspecialchars_uni($event['title']) . " (" . count($attendees) . ")", $columns, array());

    if(!empty($waiting))
    {
        $columns['days'][0] = "Days Waiting For";
        $columns['date'] = array("Joined Waitlist", 12, function($member) { return events_format_date($member['queued_at']); });

        $render($waiting, "Waitlist (" . count($waiting) . ")", $columns, array('class' => 'events_admin_waitlist_row'));
    }

    echo "<br /><a href=\"" . $mybb->settings['bburl'] . "/event.php?id=" . $event_id . "&amp;action=attendance\" class=\"button\" id=\"admin_attendance_link\">View Attendance Sheet</a>";
}

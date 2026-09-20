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
        $events[$event['id']] = $event['title'] . " (" . events_format_date($event['start_date']) . ")";
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

    $attendees = array_merge(
        events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day, 'role' => 'trooper')),
        events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day, 'role' => 'wrangler'))
    );

    $table = new Table;
    $table->construct_header("User", array("width" => "16%"));
    $table->construct_header("Role", array("width" => "8%"));
    $table->construct_header("Legion ID", array("width" => "12%"));
    $table->construct_header("Costumes", array("width" => "26%"));
    $table->construct_header("Days Attending", array("width" => "18%"));
    $table->construct_header("Mobile", array("width" => "12%"));
    $table->construct_header("RSVPed", array("width" => "12%"));

    foreach($attendees as $attendee)
    {
        $attended_day_ids = array();
        foreach($attendee['days'] as $day)
        {
            $attended_day_ids[] = (int)$day['id'];
        }
        $days = events_day_labels($event_days, $attended_day_ids, 'short');

        $table->construct_cell("<a href=\"index.php?module=user-users&amp;action=edit&amp;uid=" . $attendee['uid'] . "\">" . htmlspecialchars_uni($attendee['username']) . "</a>");
        $table->construct_cell(events_role_label($attendee['role']));
        $table->construct_cell(htmlspecialchars_uni($attendee['tk_id']));
        $table->construct_cell(htmlspecialchars_uni(implode(', ', $attendee['costumes'])));
        $table->construct_cell(htmlspecialchars_uni(implode(', ', $days)));
        $table->construct_cell(htmlspecialchars_uni($attendee['mobile']));
        $table->construct_cell(events_format_date($attendee['rsvp_date']));
        $table->construct_row();
    }

    if($table->num_rows() == 0)
    {
        $table->construct_cell("No RSVPs found.", array("colspan" => 7));
        $table->construct_row();
    }

    $table->output("RSVPs for: " . htmlspecialchars_uni($event['title']) . " (" . count($attendees) . ")");

    echo "<br /><a href=\"" . $mybb->settings['bburl'] . "/event.php?id=" . $event_id . "&amp;action=attendance\" class=\"button\" id=\"admin_attendance_link\">View Attendance Sheet</a>";
}

<?php
/**
 * MyBB Event Plugin - Event management (CRUD) in the Admin CP
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
// Reading, validating and writing an event is shared with manage_event.php on the front
// end, so the two forms cannot disagree about what is valid. This module only renders.
require_once MYBB_ROOT . "inc/plugins/events/inc/events_form.php";

function events_admin_list_events()
{
    global $mybb, $db, $page;

    if(!events_is_gec())
    {
        flash_message("You do not have permission to access this page.", "error");
        admin_redirect("index.php");
    }

    $per_page = 20;
    $page_num = max(1, $mybb->get_input('page', MyBB::INPUT_INT));
    $start = ($page_num - 1) * $per_page;

    $where = "1=1";
    $status_filter = $mybb->get_input('status');
    if(in_array($status_filter, array('pending', 'live', 'archived'), true))
    {
        $where .= " AND status = '" . $db->escape_string($status_filter) . "'";
    }

    if(!events_user_can_admin($mybb->user))
    {
        $where .= " AND (gec_user_id = " . (int)$mybb->user['uid'] . " OR created_by = " . (int)$mybb->user['uid'] . ")";
    }

    $total = (int)$db->fetch_field($db->simple_select("event_plugin_events", "COUNT(*) AS total", $where), "total");

    $query = $db->query("
        SELECT e.*, u.username AS gec_username,
               (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'trooper' AND r.status = 'attending') AS rsvp_count,
           (SELECT COUNT(*) FROM " . TABLE_PREFIX . "event_plugin_rsvps r WHERE r.event_id = e.id AND r.role = 'wrangler' AND r.status = 'attending') AS wrangler_count
        FROM " . TABLE_PREFIX . "event_plugin_events e
        LEFT JOIN " . TABLE_PREFIX . "users u ON e.gec_user_id = u.uid
        WHERE {$where}
        ORDER BY e.start_date DESC
        LIMIT {$start}, {$per_page}
    ");

    $table = new Table;
    $table->construct_header("Title", array("width" => "28%"));
    $table->construct_header("Status", array("width" => "10%"));
    $table->construct_header("Region", array("width" => "10%"));
    $table->construct_header("Starts", array("width" => "15%"));
    $table->construct_header("Troopers", array("width" => "7%"));
    $table->construct_header("Wranglers", array("width" => "7%"));
    $table->construct_header("Coordinator", array("width" => "12%"));
    $table->construct_header("Actions", array("width" => "15%", "class" => "align_center"));

    while($event = $db->fetch_array($query))
    {
        $table->construct_cell("<a href=\"" . $mybb->settings['bburl'] . "/event.php?id=" . (int)$event['id'] . "\">" . htmlspecialchars_uni($event['title']) . "</a>");
        $table->construct_cell("<span class=\"event_status_" . htmlspecialchars_uni($event['status']) . "\">" . ucfirst($event['status']) . "</span>");
        $table->construct_cell(htmlspecialchars_uni($event['region']));
        $table->construct_cell(events_format_date($event['start_date']));
        $table->construct_cell((int)$event['rsvp_count']);
        $table->construct_cell((int)$event['wrangler_count']);
        $table->construct_cell(htmlspecialchars_uni((string)$event['gec_username']));

        $popup = new PopupMenu("event_" . $event['id'], "Actions");
        $popup->add_item("Edit", "index.php?module=events&amp;action=edit&amp;id=" . $event['id']);
        $popup->add_item("View RSVPs", "index.php?module=events&amp;action=rsvps&amp;event_id=" . $event['id']);

        if($event['status'] === 'pending')
        {
            $popup->add_item("Make Live", "index.php?module=events&amp;action=status&amp;id=" . $event['id'] . "&amp;status=live&amp;my_post_key=" . $mybb->post_code);
        }
        elseif($event['status'] === 'live')
        {
            $popup->add_item("Archive", "index.php?module=events&amp;action=status&amp;id=" . $event['id'] . "&amp;status=archived&amp;my_post_key=" . $mybb->post_code);
        }
        else
        {
            $popup->add_item("Make Live", "index.php?module=events&amp;action=status&amp;id=" . $event['id'] . "&amp;status=live&amp;my_post_key=" . $mybb->post_code);
        }

        $popup->add_item("Delete", "index.php?module=events&amp;action=delete&amp;id=" . $event['id'] . "&amp;my_post_key=" . $mybb->post_code, "return confirm('Are you sure you want to delete this event?');");

        $table->construct_cell($popup->fetch(), array("class" => "align_center"));
        $table->construct_row();
    }

    if($table->num_rows() == 0)
    {
        $table->construct_cell("No events found.", array("colspan" => 8));
        $table->construct_row();
    }

    $table->output("Events");

    echo draw_admin_pagination($page_num, $per_page, $total, "index.php?module=events&amp;page=");
    echo "<br /><a href=\"index.php?module=events&amp;action=add\" class=\"button\" id=\"events_add_button\">Add New Event</a>";
}

function events_admin_edit_event()
{
    global $mybb, $db, $page;

    $event_id = $mybb->get_input('id', MyBB::INPUT_INT);
    $is_edit = $event_id > 0;
    $event = array();

    if($is_edit)
    {
        $event = events_get_event($event_id);
        if(!$event)
        {
            flash_message("Event not found.", "error");
            admin_redirect("index.php?module=events");
        }

        if(!events_is_event_gec($event_id))
        {
            flash_message("You do not have permission to edit this event.", "error");
            admin_redirect("index.php?module=events");
        }
    }
    elseif(!events_is_gec())
    {
        flash_message("You do not have permission to create events.", "error");
        admin_redirect("index.php?module=events");
    }

    $errors = array();
    $values = events_event_form_values($event);
    $preview = '';

    if($mybb->request_method === "post")
    {
        // Re-rendering from the submitted values rather than from the database is what
        // puts a failed submit back on screen as it was typed.
        $values = events_event_form_input();

        // Preview comes straight back with the form, the way MyBB's own Preview Post
        // does, and validates nothing: nothing is being saved, and a form half filled in
        // is the normal state to preview a description from.
        if(events_is_description_preview())
        {
            $preview = events_description_preview($values['description']);
        }
        else
        {
            $errors = events_validate_event_input($values, $event);

            if(empty($errors))
            {
                $thread_error = null;
                events_save_event($is_edit ? $event_id : 0, $values, $mybb->user['uid'], $thread_error);

                $message = $is_edit ? "Event updated successfully." : "Event created successfully.";
                if($thread_error !== null)
                {
                    // The event saved; only its announcement did not.
                    flash_message($message . " " . $thread_error, "error");
                }
                else
                {
                    flash_message($message, "success");
                }
                admin_redirect("index.php?module=events");
            }
        }
    }

    echo $preview;

    if(!empty($errors))
    {
        $page->output_inline_error($errors);
    }

    // The event's stored coordinator rather than the posted one: a forged uid that failed
    // validation should not earn itself a place on the list when the form comes back.
    $coordinators = events_coordinator_choices(array(
        $mybb->user['uid'],
        isset($event['gec_user_id']) ? $event['gec_user_id'] : 0,
    ));

    $form = new Form("index.php?module=events&amp;action=" . ($is_edit ? "edit&amp;id=" . $event_id : "add"), "post");

    $container = new FormContainer($is_edit ? "Edit Event" : "Add Event");
    $container->output_row("Title", "The event's name", $form->generate_text_box("title", $values['title'], array("id" => "title")), "title");
    // The description is BBCode, so it gets the board's own editor - see
    // events_description_editor(). The markup goes after the box it binds to, which is
    // where MyBB puts it in its own posting templates and in the Admin CP's signature box.
    $container->output_row(
        "Description",
        "Shown on the event page and in the announcement thread. BBCode and smilies work here the same way they do in a post.",
        $form->generate_text_area("description", $values['description'], array("id" => "description", "rows" => 8))
            . events_description_editor("description"),
        "description"
    );
    $container->output_row("Status", "Pending events are only visible to coordinators; setting an event live posts its announcement thread", $form->generate_select_box("status", events_event_statuses(), $values['status'], array("id" => "status")), "status");
    $container->output_row("Region", "Used by the region filter", $form->generate_select_box("region", array_combine(events_regions(), events_regions()), $values['region'], array("id" => "region")), "region");
    $container->output_row("Address", "Optional. Where the event happens; shown as a Google Maps link on the event pages and in the announcement thread", $form->generate_text_box("address", $values['address'], array("id" => "address", "maxlength" => 255)), "address");
    // The date boxes are not generate_text_box(): it can set a class, an id and a style and
    // nothing else, so it cannot produce the time input beside each one. events_datetime_field()
    // renders both halves for the Admin CP and the front end alike, wearing whichever form's
    // class it is handed - MyBB's own .text_input here.
    $date_options = array("input_class" => "text_input");
    $container->output_row("Start Date", "When the event itself begins. Pick a date from the calendar, or type it as YYYY-MM-DD.", events_datetime_field("start_date", "start_date", $values['start_date'], $date_options + array("required" => true, "label" => "Start")), "start_date");
    $container->output_row("End Date", "When it finishes. Signups close here when no cutoff is set below.", events_datetime_field("end_date", "end_date", $values['end_date'], $date_options + array("required" => true, "label" => "End")), "end_date");
    $container->output_row("Signup Cutoff", "Optional. RSVPs close at this time; leave blank to keep them open until the event ends.", events_datetime_field("signup_cutoff", "signup_cutoff", $values['signup_cutoff'], $date_options + array("label" => "Signup cutoff")), "signup_cutoff");
    $container->output_row("Requires WWCC", "Attendees must have a WWCC number on file", $form->generate_check_box("requires_wwcc", 1, "This event requires a WWCC", array("id" => "requires_wwcc", "checked" => !empty($values['requires_wwcc']))), "requires_wwcc");
    $container->output_row("Coordinator", "The member who manages this event", $form->generate_select_box("gec_user_id", $coordinators, $values['gec_user_id'], array("id" => "gec_user_id")), "gec_user_id");

    // Event days: one row per day between the start and end dates, worked out rather than
    // typed, and nothing at all for a single-day event - see events_event_days_grid().
    //
    // It sits in the main container rather than one of its own so that the whole row can
    // be hidden: a FormContainer of its own would leave an empty "Event Days" box behind.
    $days_grid = events_event_days_grid($values, array(
        'container_id' => 'event_days_grid',
        'start_input'  => 'start_date',
        'end_input'    => 'end_date',
        'id_prefix'    => 'event_day_',
        'input_class'  => 'text_input',
    ));

    // The heading goes inside the cell rather than being output_row()'s title, because the
    // whole section has to be hideable and Table::construct_row() will not carry a style
    // onto the <tr> - a row with a heading and nothing under it is worse than no row.
    $container->output_row("", "", '<div data-events-day-section="1"'
        . ($days_grid['rows'] ? '' : ' style="display: none;"') . '>'
        . '<label>Event Days</label>'
        . '<div class="description">The hours the event runs on each of its days (HH:MM:SS).'
        . ' Leave a day blank to run it in full.</div>'
        . $days_grid['html']
        . '</div>');
    $container->end();

    // Not generate_text_box(): the field is a tag input built around the box that posts -
    // see events_exclusions_field() - and the search it types against is reached by a path
    // that differs between here and the board.
    $exclusions_container = new FormContainer("Excluded Members");
    $exclusions_container->output_row(
        "Excluded Members",
        "Start typing a username and pick from the list. These members can see the event but cannot RSVP.",
        events_exclusions_field($values['exclusions'], array(
            'id'          => 'exclusions',
            'input_class' => 'text_input',
            'search_url'  => '../xmlhttp.php?action=get_users&search_type=2',
        )),
        "exclusions"
    );
    $exclusions_container->end();

    // Preview is an ordinary submit rather than anything scripted: it posts the form and
    // the page comes back with the rendered description above it, so it works with the
    // editor turned off and with no JavaScript at all.
    //
    // Written out rather than generated because it needs formnovalidate, which
    // generate_submit_button() has no option for - see events_is_description_preview()
    // for why the button must not be held up by the form's required dates. It wears
    // MyBB's own .submit_button so it reads as the button beside it.
    $buttons = array(
        $form->generate_submit_button($is_edit ? "Update Event" : "Create Event"),
        '<input type="submit" class="submit_button" name="preview_description"'
            . ' id="events_preview_button" value="Preview" formnovalidate="formnovalidate" />',
    );
    $form->output_submit_wrapper($buttons);
    $form->end();

    // Keeps the day rows in step with the dates as they are picked, so a three-day event
    // can be created in one pass rather than saved and then reopened, and turns the
    // excluded members box into a tag input.
    echo events_datepicker_assets('../jscripts/events/');
    echo events_tag_field_assets('../jscripts/events/');
    echo events_datepicker_script();
    echo events_event_days_script();
    echo events_tag_field_script();
}

/**
 * Move an event between pending / live / archived.
 */
function events_admin_set_status()
{
    global $mybb, $db, $lang;

    // In the Admin CP verify_post_check() *returns* false rather than erroring, so the
    // result has to be acted on - calling it bare checks nothing at all. Status and
    // delete are both GET links carrying the key, which is exactly the shape somebody
    // can be sent as a link, so this is the whole guard on either of them.
    if(!verify_post_check($mybb->get_input('my_post_key')))
    {
        flash_message($lang->invalid_post_verify_key2, 'error');
        admin_redirect("index.php?module=events");
    }

    $event_id = $mybb->get_input('id', MyBB::INPUT_INT);
    $status = $mybb->get_input('status');

    if(!in_array($status, array('pending', 'live', 'archived'), true))
    {
        flash_message("Invalid status.", "error");
        admin_redirect("index.php?module=events");
    }

    $event = events_get_event($event_id);
    if(!$event)
    {
        flash_message("Event not found.", "error");
        admin_redirect("index.php?module=events");
    }

    if(!events_is_event_gec($event_id))
    {
        flash_message("You do not have permission to change this event.", "error");
        admin_redirect("index.php?module=events");
    }

    $db->update_query("event_plugin_events", array(
        'status'     => $db->escape_string($status),
        'updated_at' => $db->escape_string(events_date('Y-m-d H:i:s')),
    ), "id = " . $event_id);

    // An event reaches "live" from here as often as it does from the form, and that is
    // the point at which it is announced.
    $thread_error = null;
    events_sync_event_thread($event_id, $thread_error);

    if($thread_error !== null)
    {
        flash_message("Event is now " . $status . ". " . $thread_error, "error");
        admin_redirect("index.php?module=events");
    }

    flash_message("Event is now " . $status . ".", "success");
    admin_redirect("index.php?module=events");
}

function events_admin_delete_event()
{
    global $mybb, $db, $lang;

    // See events_admin_set_status(): the return value is the check.
    if(!verify_post_check($mybb->get_input('my_post_key')))
    {
        flash_message($lang->invalid_post_verify_key2, 'error');
        admin_redirect("index.php?module=events");
    }

    $event_id = $mybb->get_input('id', MyBB::INPUT_INT);
    $event = events_get_event($event_id);

    if(!$event)
    {
        flash_message("Event not found.", "error");
        admin_redirect("index.php?module=events");
    }

    if(!events_is_event_gec($event_id))
    {
        flash_message("You do not have permission to delete this event.", "error");
        admin_redirect("index.php?module=events");
    }

    // Remove the RSVP children before the RSVPs themselves.
    $rsvp_ids = array();
    $query = $db->simple_select("event_plugin_rsvps", "id", "event_id = " . $event_id);
    while($row = $db->fetch_array($query))
    {
        $rsvp_ids[] = (int)$row['id'];
    }

    if(!empty($rsvp_ids))
    {
        $db->delete_query("event_plugin_rsvp_costumes", "rsvp_id IN (" . implode(',', $rsvp_ids) . ")");
        $db->delete_query("event_plugin_rsvp_days", "rsvp_id IN (" . implode(',', $rsvp_ids) . ")");
    }

    $db->delete_query("event_plugin_rsvps", "event_id = " . $event_id);
    $db->delete_query("event_plugin_event_days", "event_id = " . $event_id);
    $db->delete_query("event_plugin_event_exclusions", "event_id = " . $event_id);
    $db->delete_query("event_plugin_troop_reports", "event_id = " . $event_id);
    $db->delete_query("event_plugin_events", "id = " . $event_id);

    flash_message("Event deleted successfully.", "success");
    admin_redirect("index.php?module=events");
}

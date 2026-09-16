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

/**
 * Users who can be assigned as an event's coordinator: admins, members of the
 * configured coordinator groups, and anyone already assigned to an event.
 *
 * @return array uid => username
 */
function events_admin_coordinator_choices()
{
    global $db;

    $group_ids = array();
    foreach(explode(',', (string)events_get_setting('event_coordinator_groups')) as $gid)
    {
        $gid = (int)$gid;
        if($gid)
        {
            $group_ids[] = $gid;
        }
    }

    $conditions = array("u.usergroup IN (SELECT gid FROM " . TABLE_PREFIX . "usergroups WHERE cancp = 1)");
    $conditions[] = "u.uid IN (SELECT gec_user_id FROM " . TABLE_PREFIX . "event_plugin_events)";

    foreach($group_ids as $gid)
    {
        $conditions[] = "u.usergroup = " . $gid;
        $conditions[] = "CONCAT(',', u.additionalgroups, ',') LIKE '%," . $gid . ",%'";
    }

    $query = $db->query("
        SELECT u.uid, u.username
        FROM " . TABLE_PREFIX . "users u
        WHERE " . implode(' OR ', $conditions) . "
        ORDER BY u.username ASC
    ");

    $users = array();
    while($user = $db->fetch_array($query))
    {
        $users[$user['uid']] = $user['username'];
    }

    return $users;
}

/**
 * Turn the free-text exclusion box into a list of user ids.
 *
 * Accepts a comma separated list of usernames and/or user ids.
 *
 * @param string $input
 * @return array of int
 */
function events_admin_parse_exclusions($input)
{
    global $db;

    $uids = array();
    foreach(explode(',', (string)$input) as $token)
    {
        $token = trim($token);
        if($token === '')
        {
            continue;
        }

        if(ctype_digit($token))
        {
            $uids[] = (int)$token;
            continue;
        }

        $user = $db->fetch_array($db->simple_select("users", "uid", "username = '" . $db->escape_string($token) . "'"));
        if($user)
        {
            $uids[] = (int)$user['uid'];
        }
    }

    return array_values(array_unique($uids));
}

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

    if($mybb->request_method === "post")
    {
        $title = trim($mybb->get_input('title'));
        $start_date = trim($mybb->get_input('start_date'));
        $end_date = trim($mybb->get_input('end_date'));
        $signup_cutoff = trim($mybb->get_input('signup_cutoff'));
        $status = $mybb->get_input('status');
        $region = $mybb->get_input('region');

        if($title === '')
        {
            $errors[] = "A title is required.";
        }
        if(!strtotime($start_date))
        {
            $errors[] = "The start date must be a valid date and time (YYYY-MM-DD HH:MM:SS).";
        }
        if(!strtotime($end_date))
        {
            $errors[] = "The end date must be a valid date and time (YYYY-MM-DD HH:MM:SS).";
        }
        if(strtotime($start_date) && strtotime($end_date) && strtotime($end_date) < strtotime($start_date))
        {
            $errors[] = "The end date cannot be before the start date.";
        }
        if($signup_cutoff !== '' && !strtotime($signup_cutoff))
        {
            $errors[] = "The signup cutoff must be a valid date and time, or empty.";
        }
        if(!in_array($status, array('pending', 'live', 'archived'), true))
        {
            $errors[] = "Invalid status.";
        }
        if(!in_array($region, events_regions(), true))
        {
            $errors[] = "Invalid region.";
        }

        $event_days = array();
        foreach((array)$mybb->get_input('event_days', MyBB::INPUT_ARRAY) as $day)
        {
            if(empty($day['date']))
            {
                continue;
            }

            if(!strtotime($day['date']))
            {
                $errors[] = "Event day '" . htmlspecialchars_uni($day['date']) . "' is not a valid date.";
                continue;
            }

            $event_days[] = array(
                'date'       => date('Y-m-d', strtotime($day['date'])),
                'start_time' => !empty($day['start_time']) ? $db->escape_string($day['start_time']) : '00:00:00',
                'end_time'   => !empty($day['end_time']) ? $db->escape_string($day['end_time']) : '23:59:59',
            );
        }

        $exclusions = events_admin_parse_exclusions($mybb->get_input('exclusions'));

        if(empty($errors))
        {
            $data = array(
                'title'          => $db->escape_string($title),
                'description'    => $db->escape_string($mybb->get_input('description')),
                'status'         => $db->escape_string($status),
                'region'         => $db->escape_string($region),
                'start_date'     => $db->escape_string(date('Y-m-d H:i:s', strtotime($start_date))),
                'end_date'       => $db->escape_string(date('Y-m-d H:i:s', strtotime($end_date))),
                'requires_wwcc'  => $mybb->get_input('requires_wwcc', MyBB::INPUT_INT) ? 1 : 0,
                'gec_user_id'    => $mybb->get_input('gec_user_id', MyBB::INPUT_INT),
                'updated_at'     => $db->escape_string(date('Y-m-d H:i:s', TIME_NOW)),
            );

            // MyBB quotes insert/update values but has no way to express SQL NULL, and an
            // empty string is not a valid DATETIME under strict mode, so the nullable
            // columns are cleared in a second statement.
            $nullable = array();

            if($signup_cutoff !== '')
            {
                $data['signup_cutoff'] = $db->escape_string(date('Y-m-d H:i:s', strtotime($signup_cutoff)));
            }
            else
            {
                $nullable[] = 'signup_cutoff';
            }

            $thread_id = $mybb->get_input('thread_id', MyBB::INPUT_INT);
            if($thread_id > 0)
            {
                $data['thread_id'] = $thread_id;
            }
            else
            {
                $nullable[] = 'thread_id';
            }

            if($is_edit)
            {
                $db->update_query("event_plugin_events", $data, "id = " . $event_id);
            }
            else
            {
                $data['created_by'] = (int)$mybb->user['uid'];
                $data['created_at'] = $db->escape_string(date('Y-m-d H:i:s', TIME_NOW));
                $event_id = (int)$db->insert_query("event_plugin_events", $data);
            }

            if(!empty($nullable))
            {
                $db->write_query("UPDATE " . TABLE_PREFIX . "event_plugin_events
                    SET " . implode(' = NULL, ', $nullable) . " = NULL
                    WHERE id = " . (int)$event_id);
            }

            $db->delete_query("event_plugin_event_days", "event_id = " . $event_id);
            foreach($event_days as $day)
            {
                $db->insert_query("event_plugin_event_days", array_merge(array('event_id' => $event_id), $day));
            }

            $db->delete_query("event_plugin_event_exclusions", "event_id = " . $event_id);
            foreach($exclusions as $uid)
            {
                $db->insert_query("event_plugin_event_exclusions", array('event_id' => $event_id, 'user_id' => $uid));
            }

            flash_message($is_edit ? "Event updated successfully." : "Event created successfully.", "success");
            admin_redirect("index.php?module=events");
        }

        // Re-render the form with what was submitted.
        $event = array_merge($event, array(
            'title'         => $title,
            'description'   => $mybb->get_input('description'),
            'status'        => $status,
            'region'        => $region,
            'start_date'    => $start_date,
            'end_date'      => $end_date,
            'signup_cutoff' => $signup_cutoff,
            'requires_wwcc' => $mybb->get_input('requires_wwcc', MyBB::INPUT_INT),
            'gec_user_id'   => $mybb->get_input('gec_user_id', MyBB::INPUT_INT),
            'thread_id'     => $mybb->get_input('thread_id', MyBB::INPUT_INT),
        ));
    }

    if(!empty($errors))
    {
        $page->output_inline_error($errors);
    }

    $existing_days = $is_edit ? events_get_event_days($event_id) : array();
    if($mybb->request_method === "post")
    {
        $existing_days = array();
        foreach((array)$mybb->get_input('event_days', MyBB::INPUT_ARRAY) as $day)
        {
            if(!empty($day['date']))
            {
                $existing_days[] = $day;
            }
        }
    }

    $existing_exclusions = array();
    if($is_edit)
    {
        $query = $db->query("
            SELECT u.username
            FROM " . TABLE_PREFIX . "event_plugin_event_exclusions x
            INNER JOIN " . TABLE_PREFIX . "users u ON x.user_id = u.uid
            WHERE x.event_id = " . $event_id . "
        ");
        while($row = $db->fetch_array($query))
        {
            $existing_exclusions[] = $row['username'];
        }
    }
    if($mybb->request_method === "post")
    {
        $existing_exclusions = array($mybb->get_input('exclusions'));
    }

    $coordinators = events_admin_coordinator_choices();
    if(empty($coordinators))
    {
        $coordinators = array((int)$mybb->user['uid'] => $mybb->user['username']);
    }

    $threads = array('' => 'None');
    $query = $db->query("
        SELECT t.tid, t.subject, f.name AS forum_name
        FROM " . TABLE_PREFIX . "threads t
        LEFT JOIN " . TABLE_PREFIX . "forums f ON t.fid = f.fid
        WHERE t.visible = 1
        ORDER BY t.dateline DESC
        LIMIT 100
    ");
    while($thread = $db->fetch_array($query))
    {
        $threads[$thread['tid']] = $thread['subject'] . " (" . $thread['forum_name'] . ")";
    }

    $form = new Form("index.php?module=events&amp;action=" . ($is_edit ? "edit&amp;id=" . $event_id : "add"), "post");

    $container = new FormContainer($is_edit ? "Edit Event" : "Add Event");
    $container->output_row("Title", "The event's name", $form->generate_text_box("title", isset($event['title']) ? $event['title'] : "", array("id" => "title")), "title");
    $container->output_row("Description", "Shown on the event page", $form->generate_text_area("description", isset($event['description']) ? $event['description'] : "", array("id" => "description", "rows" => 8)), "description");
    $container->output_row("Status", "Pending events are only visible to coordinators", $form->generate_select_box("status", array('pending' => 'Pending', 'live' => 'Live', 'archived' => 'Archived'), isset($event['status']) ? $event['status'] : 'pending', array("id" => "status")), "status");
    $container->output_row("Region", "Used by the region filter", $form->generate_select_box("region", array_combine(events_regions(), events_regions()), isset($event['region']) ? $event['region'] : 'Sydney', array("id" => "region")), "region");
    $container->output_row("Start Date", "YYYY-MM-DD HH:MM:SS", $form->generate_text_box("start_date", isset($event['start_date']) ? $event['start_date'] : "", array("id" => "start_date")), "start_date");
    $container->output_row("End Date", "YYYY-MM-DD HH:MM:SS", $form->generate_text_box("end_date", isset($event['end_date']) ? $event['end_date'] : "", array("id" => "end_date")), "end_date");
    $container->output_row("Signup Cutoff", "Optional. RSVPs close at this time; leave blank to keep them open until the event ends.", $form->generate_text_box("signup_cutoff", isset($event['signup_cutoff']) ? $event['signup_cutoff'] : "", array("id" => "signup_cutoff")), "signup_cutoff");
    $container->output_row("Requires WWCC", "Attendees must have a WWCC number on file", $form->generate_check_box("requires_wwcc", 1, "This event requires a WWCC", array("id" => "requires_wwcc", "checked" => !empty($event['requires_wwcc']))), "requires_wwcc");
    $container->output_row("Coordinator", "The member who manages this event", $form->generate_select_box("gec_user_id", $coordinators, isset($event['gec_user_id']) ? $event['gec_user_id'] : $mybb->user['uid'], array("id" => "gec_user_id")), "gec_user_id");
    $container->output_row("Linked Thread", "Optional discussion thread", $form->generate_select_box("thread_id", $threads, isset($event['thread_id']) ? $event['thread_id'] : '', array("id" => "thread_id")), "thread_id");
    $container->end();

    // Event days: existing rows plus three blanks so extra days can be added.
    $days_container = new FormContainer("Event Days");
    $day_count = count($existing_days) + 3;
    for($i = 0; $i < $day_count; $i++)
    {
        $day = isset($existing_days[$i]) ? $existing_days[$i] : array();
        $row = $form->generate_text_box("event_days[{$i}][date]", isset($day['date']) ? $day['date'] : "", array("id" => "event_day_{$i}_date", "style" => "width: 140px;")) . " ";
        $row .= $form->generate_text_box("event_days[{$i}][start_time]", isset($day['start_time']) ? $day['start_time'] : "", array("id" => "event_day_{$i}_start", "style" => "width: 100px;")) . " ";
        $row .= $form->generate_text_box("event_days[{$i}][end_time]", isset($day['end_time']) ? $day['end_time'] : "", array("id" => "event_day_{$i}_end", "style" => "width: 100px;"));
        $days_container->output_row("Day " . ($i + 1), "Date (YYYY-MM-DD), start time and end time (HH:MM:SS)", $row);
    }
    $days_container->end();

    $exclusions_container = new FormContainer("Excluded Members");
    $exclusions_container->output_row(
        "Excluded Members",
        "Comma separated usernames (or user ids). These members can see the event but cannot RSVP.",
        $form->generate_text_box("exclusions", implode(', ', $existing_exclusions), array("id" => "exclusions")),
        "exclusions"
    );
    $exclusions_container->end();

    $buttons = array($form->generate_submit_button($is_edit ? "Update Event" : "Create Event"));
    $form->output_submit_wrapper($buttons);
    $form->end();
}

/**
 * Move an event between pending / live / archived.
 */
function events_admin_set_status()
{
    global $mybb, $db;

    verify_post_check($mybb->get_input('my_post_key'));

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
        'updated_at' => $db->escape_string(date('Y-m-d H:i:s', TIME_NOW)),
    ), "id = " . $event_id);

    flash_message("Event is now " . $status . ".", "success");
    admin_redirect("index.php?module=events");
}

function events_admin_delete_event()
{
    global $mybb, $db;

    verify_post_check($mybb->get_input('my_post_key'));

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

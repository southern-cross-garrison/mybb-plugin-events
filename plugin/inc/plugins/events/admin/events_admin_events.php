<?php
/**
 * MyBB Event Plugin - Event Management (CRUD)
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

function events_admin_list_events()
{
    global $mybb, $db, $page, $lang;
    
    $page->output_nav_tabs($sub_tabs, 'events');
    
    // Check permissions
    if(!events_is_gec() && $mybb->usergroup['cancp'] != 1)
    {
        flash_message("You do not have permission to access this page.", "error");
        admin_redirect("index.php");
    }
    
    $per_page = 20;
    $page_num = $mybb->input['page'] ? (int)$mybb->input['page'] : 1;
    $start = ($page_num - 1) * $per_page;
    
    // Filter by status
    $status_filter = $mybb->input['status'];
    $where = "1=1";
    if($status_filter && in_array($status_filter, array('pending', 'live', 'archived')))
    {
        $where .= " AND status = '" . $db->escape_string($status_filter) . "'";
    }
    
    // If not admin, only show own events or events where user is GEC
    if($mybb->usergroup['cancp'] != 1)
    {
        $where .= " AND (gec_user_id = " . (int)$mybb->user['uid'] . " OR created_by = " . (int)$mybb->user['uid'] . ")";
    }
    
    // Get total count
    $query = $db->simple_select("event_plugin_events", "COUNT(*) as count", $where);
    $total = $db->fetch_field($query, "count");
    
    // Get events
    $query = $db->query("
        SELECT e.*, u.username as gec_username, u2.username as created_username
        FROM " . TABLE_PREFIX . "event_plugin_events e
        LEFT JOIN " . TABLE_PREFIX . "users u ON e.gec_user_id = u.uid
        LEFT JOIN " . TABLE_PREFIX . "users u2 ON e.created_by = u2.uid
        WHERE {$where}
        ORDER BY e.start_date DESC
        LIMIT {$start}, {$per_page}
    ");
    
    $table = new Table;
    $table->construct_header("Title", array("width" => "25%"));
    $table->construct_header("Status", array("width" => "10%"));
    $table->construct_header("Region", array("width" => "10%"));
    $table->construct_header("Start Date", array("width" => "15%"));
    $table->construct_header("GEC", array("width" => "15%"));
    $table->construct_header("Actions", array("width" => "25%", "class" => "align_center"));
    
    while($event = $db->fetch_array($query))
    {
        $table->construct_cell(htmlspecialchars_uni($event['title']));
        
        $status_colors = array(
            'pending' => 'orange',
            'live' => 'green',
            'archived' => 'gray'
        );
        $status_color = $status_colors[$event['status']];
        $table->construct_cell("<span style='color: {$status_color}; font-weight: bold;'>" . ucfirst($event['status']) . "</span>");
        
        $table->construct_cell(htmlspecialchars_uni($event['region']));
        $table->construct_cell(events_format_date($event['start_date']));
        $table->construct_cell(htmlspecialchars_uni($event['gec_username']));
        
        $popup = new PopupMenu("event_" . $event['id'], "Actions");
        $popup->add_item("Edit", "index.php?module=events&action=edit&id=" . $event['id']);
        $popup->add_item("View RSVPs", "index.php?module=events&action=rsvps&event_id=" . $event['id']);
        
        if($event['status'] == 'pending')
        {
            $popup->add_item("Make Live", "index.php?module=events&action=status&id=" . $event['id'] . "&status=live");
        }
        elseif($event['status'] == 'live')
        {
            $popup->add_item("Archive", "index.php?module=events&action=status&id=" . $event['id'] . "&status=archived");
        }
        
        $popup->add_item("Delete", "index.php?module=events&action=delete&id=" . $event['id'] . "&my_post_key=" . $mybb->post_code, "return confirm('Are you sure?');");
        
        $table->construct_cell($popup->fetch(), array("class" => "align_center"));
        $table->construct_row();
    }
    
    if($table->num_rows() == 0)
    {
        $table->construct_cell("No events found.", array("colspan" => 6));
        $table->construct_row();
    }
    
    $table->output("Events");
    
    // Pagination
    echo draw_admin_pagination($page_num, $per_page, $total, "index.php?module=events&page=");
    
    // Add event button
    echo "<br />";
    $button = "<a href='index.php?module=events&action=add' class='button'>Add New Event</a>";
    echo $button;
}

function events_admin_edit_event()
{
    global $mybb, $db, $page, $lang;
    
    $page->output_nav_tabs($sub_tabs, 'events');
    
    $event_id = (int)$mybb->input['id'];
    $is_edit = $event_id > 0;
    
    // Check permissions
    if($is_edit)
    {
        $query = $db->simple_select("event_plugin_events", "*", "id = " . $event_id);
        $event = $db->fetch_array($query);
        
        if(!$event)
        {
            flash_message("Event not found.", "error");
            admin_redirect("index.php?module=events");
        }
        
        if(!events_is_event_gec($event_id) && $mybb->usergroup['cancp'] != 1)
        {
            flash_message("You do not have permission to edit this event.", "error");
            admin_redirect("index.php?module=events");
        }
    }
    else
    {
        if(!events_is_gec() && $mybb->usergroup['cancp'] != 1)
        {
            flash_message("You do not have permission to create events.", "error");
            admin_redirect("index.php?module=events");
        }
    }
    
    if($mybb->request_method == "post")
    {
        // Validate input
        $title = $db->escape_string($mybb->input['title']);
        $description = $db->escape_string($mybb->input['description']);
        $status = $db->escape_string($mybb->input['status']);
        $region = $db->escape_string($mybb->input['region']);
        $start_date = $db->escape_string($mybb->input['start_date']);
        $end_date = $db->escape_string($mybb->input['end_date']);
        $signup_cutoff = $mybb->input['signup_cutoff'] ? $db->escape_string($mybb->input['signup_cutoff']) : null;
        $requires_wwcc = (int)$mybb->input['requires_wwcc'];
        $gec_user_id = (int)$mybb->input['gec_user_id'];
        $thread_id = $mybb->input['thread_id'] ? (int)$mybb->input['thread_id'] : null;
        
        // Get event days
        $event_days = array();
        if(isset($mybb->input['event_days']) && is_array($mybb->input['event_days']))
        {
            foreach($mybb->input['event_days'] as $day)
            {
                if(isset($day['date']) && $day['date'])
                {
                    $event_days[] = array(
                        'date' => $db->escape_string($day['date']),
                        'start_time' => isset($day['start_time']) ? $db->escape_string($day['start_time']) : null,
                        'end_time' => isset($day['end_time']) ? $db->escape_string($day['end_time']) : null
                    );
                }
            }
        }
        
        // Get exclusions
        $exclusions = array();
        if(isset($mybb->input['exclusions']) && is_array($mybb->input['exclusions']))
        {
            foreach($mybb->input['exclusions'] as $user_id)
            {
                $exclusions[] = (int)$user_id;
            }
        }
        
        if($is_edit)
        {
            // Update event
            $update_data = array(
                'title' => $title,
                'description' => $description,
                'status' => $status,
                'region' => $region,
                'start_date' => $start_date,
                'end_date' => $end_date,
                'signup_cutoff' => $signup_cutoff,
                'requires_wwcc' => $requires_wwcc,
                'gec_user_id' => $gec_user_id,
                'thread_id' => $thread_id,
                'updated_at' => date('Y-m-d H:i:s')
            );
            
            $db->update_query("event_plugin_events", $update_data, "id = " . $event_id);
            
            // Update event days
            $db->delete_query("event_plugin_event_days", "event_id = " . $event_id);
            foreach($event_days as $day)
            {
                $db->insert_query("event_plugin_event_days", array(
                    'event_id' => $event_id,
                    'date' => $day['date'],
                    'start_time' => $day['start_time'],
                    'end_time' => $day['end_time']
                ));
            }
            
            // Update exclusions
            $db->delete_query("event_plugin_event_exclusions", "event_id = " . $event_id);
            foreach($exclusions as $user_id)
            {
                $db->insert_query("event_plugin_event_exclusions", array(
                    'event_id' => $event_id,
                    'user_id' => $user_id
                ));
            }
            
            flash_message("Event updated successfully.", "success");
        }
        else
        {
            // Create event
            $insert_data = array(
                'title' => $title,
                'description' => $description,
                'status' => $status,
                'region' => $region,
                'start_date' => $start_date,
                'end_date' => $end_date,
                'signup_cutoff' => $signup_cutoff,
                'requires_wwcc' => $requires_wwcc,
                'gec_user_id' => $gec_user_id,
                'created_by' => $mybb->user['uid'],
                'thread_id' => $thread_id,
                'created_at' => date('Y-m-d H:i:s'),
                'updated_at' => date('Y-m-d H:i:s')
            );
            
            $event_id = $db->insert_query("event_plugin_events", $insert_data);
            
            // Insert event days
            foreach($event_days as $day)
            {
                $db->insert_query("event_plugin_event_days", array(
                    'event_id' => $event_id,
                    'date' => $day['date'],
                    'start_time' => $day['start_time'],
                    'end_time' => $day['end_time']
                ));
            }
            
            // Insert exclusions
            foreach($exclusions as $user_id)
            {
                $db->insert_query("event_plugin_event_exclusions", array(
                    'event_id' => $event_id,
                    'user_id' => $user_id
                ));
            }
            
            flash_message("Event created successfully.", "success");
        }
        
        admin_redirect("index.php?module=events");
    }
    
    // Get users for GEC selection
    $users = array();
    $query = $db->query("
        SELECT u.uid, u.username
        FROM " . TABLE_PREFIX . "users u
        WHERE u.usergroup IN (SELECT gid FROM " . TABLE_PREFIX . "usergroups WHERE canmodcp = 1)
        OR u.uid IN (SELECT DISTINCT gec_user_id FROM " . TABLE_PREFIX . "event_plugin_events)
        ORDER BY u.username ASC
    ");
    while($user = $db->fetch_array($query))
    {
        $users[$user['uid']] = $user['username'];
    }
    
    // Get threads for linking
    $threads = array('' => 'None');
    $query = $db->query("
        SELECT t.tid, t.subject, f.name as forum_name
        FROM " . TABLE_PREFIX . "threads t
        LEFT JOIN " . TABLE_PREFIX . "forums f ON t.fid = f.fid
        ORDER BY t.dateline DESC
        LIMIT 100
    ");
    while($thread = $db->fetch_array($query))
    {
        $threads[$thread['tid']] = $thread['subject'] . " (" . $thread['forum_name'] . ")";
    }
    
    // Get existing event days
    $existing_days = array();
    if($is_edit)
    {
        $query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . $event_id, array("order_by" => "date", "order_dir" => "ASC"));
        while($day = $db->fetch_array($query))
        {
            $existing_days[] = $day;
        }
    }
    
    // Get existing exclusions
    $existing_exclusions = array();
    if($is_edit)
    {
        $query = $db->simple_select("event_plugin_event_exclusions", "user_id", "event_id = " . $event_id);
        while($exclusion = $db->fetch_array($query))
        {
            $existing_exclusions[] = $exclusion['user_id'];
        }
    }
    
    $form = new Form("index.php?module=events&action=" . ($is_edit ? "edit&id=" . $event_id : "add"), "post");
    
    $form_container = new FormContainer($is_edit ? "Edit Event" : "Add Event");
    
    $form_container->output_row("Title", "Event title", $form->generate_text_box("title", $event['title'] ?? "", array("required" => true)));
    $form_container->output_row("Description", "Event description", $form->generate_text_area("description", $event['description'] ?? "", array("rows" => 10)));
    $form_container->output_row("Status", "Event status", $form->generate_select_box("status", array('pending' => 'Pending', 'live' => 'Live', 'archived' => 'Archived'), $event['status'] ?? 'pending'));
    $form_container->output_row("Region", "Event region", $form->generate_select_box("region", array('Sydney' => 'Sydney', 'Hunter' => 'Hunter', 'Canberra' => 'Canberra', 'Other' => 'Other'), $event['region'] ?? 'Sydney'));
    $form_container->output_row("Start Date", "Event start date and time", $form->generate_text_box("start_date", $event['start_date'] ?? "", array("required" => true, "placeholder" => "YYYY-MM-DD HH:MM:SS")));
    $form_container->output_row("End Date", "Event end date and time", $form->generate_text_box("end_date", $event['end_date'] ?? "", array("required" => true, "placeholder" => "YYYY-MM-DD HH:MM:SS")));
    $form_container->output_row("Signup Cutoff", "Last date/time users can RSVP (optional)", $form->generate_text_box("signup_cutoff", $event['signup_cutoff'] ?? "", array("placeholder" => "YYYY-MM-DD HH:MM:SS")));
    $form_container->output_row("Requires WWCC", "Check if this event requires WWCC", $form->generate_check_box("requires_wwcc", 1, "Requires WWCC", array("checked" => $event['requires_wwcc'] ?? 0)));
    $form_container->output_row("GEC", "Garrison Event Coordinator", $form->generate_select_box("gec_user_id", $users, $event['gec_user_id'] ?? $mybb->user['uid']));
    $form_container->output_row("Linked Thread", "Link to existing forum thread (optional)", $form->generate_select_box("thread_id", $threads, $event['thread_id'] ?? ''));
    
    $form_container->end();
    
    // Event days section (simplified - would need JavaScript for dynamic adding)
    echo "<div class='form_container'>";
    echo "<h2>Event Days</h2>";
    echo "<p>Add multiple days for multi-day events. If no days are specified, the event will use the start/end dates.</p>";
    
    $day_count = max(count($existing_days), 1);
    for($i = 0; $i < $day_count; $i++)
    {
        $day = $existing_days[$i] ?? array();
        echo "<div style='margin-bottom: 10px;'>";
        echo "Date: " . $form->generate_text_box("event_days[{$i}][date]", $day['date'] ?? "", array("placeholder" => "YYYY-MM-DD"));
        echo " Start: " . $form->generate_text_box("event_days[{$i}][start_time]", $day['start_time'] ?? "", array("placeholder" => "HH:MM:SS"));
        echo " End: " . $form->generate_text_box("event_days[{$i}][end_time]", $day['end_time'] ?? "", array("placeholder" => "HH:MM:SS"));
        echo "</div>";
    }
    echo "</div>";
    
    // Exclusions section (simplified)
    echo "<div class='form_container'>";
    echo "<h2>Excluded Users</h2>";
    echo "<p>Users who can see the event but cannot RSVP (enter user IDs separated by commas):</p>";
    echo $form->generate_text_box("exclusions_text", implode(',', $existing_exclusions));
    echo "</div>";
    
    $buttons[] = $form->generate_submit_button($is_edit ? "Update Event" : "Create Event");
    $form->output_submit_wrapper($buttons);
    $form->end();
    
    $page->output_footer();
}

function events_admin_delete_event()
{
    global $mybb, $db;
    
    verify_post_check($mybb->input['my_post_key']);
    
    $event_id = (int)$mybb->input['id'];
    
    // Check permissions
    $query = $db->simple_select("event_plugin_events", "*", "id = " . $event_id);
    $event = $db->fetch_array($query);
    
    if(!$event)
    {
        flash_message("Event not found.", "error");
        admin_redirect("index.php?module=events");
    }
    
    if(!events_is_event_gec($event_id) && $mybb->usergroup['cancp'] != 1)
    {
        flash_message("You do not have permission to delete this event.", "error");
        admin_redirect("index.php?module=events");
    }
    
    // Delete related data
    $db->delete_query("event_plugin_event_days", "event_id = " . $event_id);
    $db->delete_query("event_plugin_event_exclusions", "event_id = " . $event_id);
    $db->delete_query("event_plugin_rsvps", "event_id = " . $event_id);
    $db->delete_query("event_plugin_troop_reports", "event_id = " . $event_id);
    $db->delete_query("event_plugin_events", "id = " . $event_id);
    
    flash_message("Event deleted successfully.", "success");
    admin_redirect("index.php?module=events");
}

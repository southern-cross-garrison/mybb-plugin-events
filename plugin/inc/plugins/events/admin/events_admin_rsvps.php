<?php
/**
 * MyBB Event Plugin - RSVP Management for GECs
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

function events_admin_rsvps()
{
    global $mybb, $db, $page, $lang;
    
    $page->output_nav_tabs($sub_tabs, 'rsvps');
    
    // Check permissions
    if(!events_is_gec() && $mybb->usergroup['cancp'] != 1)
    {
        flash_message("You do not have permission to access this page.", "error");
        admin_redirect("index.php");
    }
    
    $event_id = (int)$mybb->input['event_id'];
    
    // Get events for dropdown
    $events = array();
    $where = "1=1";
    if($mybb->usergroup['cancp'] != 1)
    {
        $where = "gec_user_id = " . (int)$mybb->user['uid'] . " OR created_by = " . (int)$mybb->user['uid'];
    }
    $query = $db->query("
        SELECT e.*
        FROM " . TABLE_PREFIX . "event_plugin_events e
        WHERE {$where}
        ORDER BY e.start_date DESC
    ");
    while($event = $db->fetch_array($query))
    {
        $events[$event['id']] = $event['title'] . " (" . events_format_date($event['start_date']) . ")";
    }
    
    if($event_id && isset($events[$event_id]))
    {
        // Get event details
        $query = $db->simple_select("event_plugin_events", "*", "id = " . $event_id);
        $event = $db->fetch_array($query);
        
        // Get event days
        $event_days = array();
        $query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . $event_id, array("order_by" => "date", "order_dir" => "ASC"));
        while($day = $db->fetch_array($query))
        {
            $event_days[$day['id']] = $day;
        }
        
        // Get RSVPs
        $filter_costume = $mybb->input['filter_costume'];
        $filter_day = (int)$mybb->input['filter_day'];
        
        $rsvp_query = "
            SELECT r.*, u.username, u.uid, uf.realname
            FROM " . TABLE_PREFIX . "event_plugin_rsvps r
            LEFT JOIN " . TABLE_PREFIX . "users u ON r.user_id = u.uid
            LEFT JOIN " . TABLE_PREFIX . "userfields uf ON u.uid = uf.ufid
            WHERE r.event_id = " . (int)$event_id . " AND r.status = 'attending'
        ";
        
        if($filter_costume)
        {
            $rsvp_query .= " AND r.id IN (SELECT rsvp_id FROM " . TABLE_PREFIX . "event_plugin_rsvp_costumes WHERE costume LIKE '%" . $db->escape_string($filter_costume) . "%')";
        }
        
        if($filter_day)
        {
            $rsvp_query .= " AND r.id IN (SELECT rsvp_id FROM " . TABLE_PREFIX . "event_plugin_rsvp_days WHERE event_day_id = " . (int)$filter_day . ")";
        }
        
        $rsvp_query .= " ORDER BY u.username ASC";
        
        $query = $db->query($rsvp_query);
        
        $table = new Table;
        $table->construct_header("User", array("width" => "20%"));
        $table->construct_header("Real Name", array("width" => "15%"));
        $table->construct_header("TK ID", array("width" => "10%"));
        $table->construct_header("Costumes", array("width" => "20%"));
        $table->construct_header("Days Attending", array("width" => "15%"));
        $table->construct_header("RSVP Date", array("width" => "10%"));
        $table->construct_header("Actions", array("width" => "10%", "class" => "align_center"));
        
        while($rsvp = $db->fetch_array($query))
        {
            // Get costumes
            $costumes = array();
            $costume_query = $db->simple_select("event_plugin_rsvp_costumes", "costume", "rsvp_id = " . (int)$rsvp['id']);
            while($costume = $db->fetch_array($costume_query))
            {
                $costumes[] = htmlspecialchars_uni($costume['costume']);
            }
            
            // Get days
            $days = array();
            $day_query = $db->query("
                SELECT ed.date
                FROM " . TABLE_PREFIX . "event_plugin_rsvp_days rd
                LEFT JOIN " . TABLE_PREFIX . "event_plugin_event_days ed ON rd.event_day_id = ed.id
                WHERE rd.rsvp_id = " . (int)$rsvp['id']
            );
            while($day = $db->fetch_array($day_query))
            {
                $days[] = date('M j', strtotime($day['date']));
            }
            
            // Get TK ID
            $tk_id = events_get_user_field($rsvp['uid'], 'tk_id');
            
            $table->construct_cell(htmlspecialchars_uni($rsvp['username']));
            $table->construct_cell(htmlspecialchars_uni($rsvp['realname'] ?? ''));
            $table->construct_cell(htmlspecialchars_uni($tk_id ?? ''));
            $table->construct_cell(implode(', ', $costumes));
            $table->construct_cell(implode(', ', $days));
            $table->construct_cell(events_format_date($rsvp['rsvp_date']));
            
            $popup = new PopupMenu("rsvp_" . $rsvp['id'], "Actions");
            $popup->add_item("View Attendance Sheet", $mybb->settings['bburl'] . "/events.php?action=attendance&id=" . $event_id);
            $table->construct_cell($popup->fetch(), array("class" => "align_center"));
            $table->construct_row();
        }
        
        if($table->num_rows() == 0)
        {
            $table->construct_cell("No RSVPs found.", array("colspan" => 7));
            $table->construct_row();
        }
        
        $table->output("RSVPs for: " . htmlspecialchars_uni($event['title']));
        
        // Filters
        echo "<div class='form_container'>";
        echo "<h2>Filters</h2>";
        
        $form = new Form("index.php?module=events&action=rsvps", "get");
        $form->output_hidden_field("module", "events");
        $form->output_hidden_field("action", "rsvps");
        $form->output_hidden_field("event_id", $event_id);
        
        echo "Event: " . $form->generate_select_box("event_id", $events, $event_id) . "<br /><br />";
        echo "Filter by Costume: " . $form->generate_text_box("filter_costume", $filter_costume) . "<br /><br />";
        echo "Filter by Day: " . $form->generate_select_box("filter_day", array('' => 'All Days') + array_map(function($d) { return date('M j, Y', strtotime($d['date'])); }, $event_days), $filter_day) . "<br /><br />";
        echo $form->generate_submit_button("Apply Filters");
        $form->end();
        echo "</div>";
        
        // Export buttons
        echo "<br />";
        echo "<a href='" . $mybb->settings['bburl'] . "/events.php?action=attendance&id=" . $event_id . "' class='button'>View Attendance Sheet</a>";
    }
    else
    {
        // Show event selector
        echo "<div class='form_container'>";
        echo "<h2>Select Event</h2>";
        
        $form = new Form("index.php?module=events&action=rsvps", "get");
        $form->output_hidden_field("module", "events");
        $form->output_hidden_field("action", "rsvps");
        
        echo "Event: " . $form->generate_select_box("event_id", array('' => 'Select an event...') + $events, $event_id) . "<br /><br />";
        echo $form->generate_submit_button("View RSVPs");
        $form->end();
        echo "</div>";
    }
    
    $page->output_footer();
}

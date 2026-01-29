<?php
/**
 * MyBB Event Plugin - Single Event View
 */

define("IN_MYBB", 1);
require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

// Check if user can view events
if($mybb->user['uid'] == 0)
{
    error_no_permission();
}

$event_id = (int)$mybb->input['id'];

if(!$event_id)
{
    error("Invalid event ID.");
}

// Get event
$query = $db->simple_select("event_plugin_events", "*", "id = " . $event_id);
$event = $db->fetch_array($query);

if(!$event)
{
    error("Event not found.");
}

// Check visibility
if($event['status'] == 'pending' && $mybb->usergroup['cancp'] != 1 && !events_is_event_gec($event_id))
{
    error_no_permission();
}

// Get event days
$event_days = array();
$query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . $event_id, array("order_by" => "date", "order_dir" => "ASC"));
while($day = $db->fetch_array($query))
{
    $event_days[] = $day;
}

// Check if user has RSVPed
$has_rsvped = events_has_rsvped($event_id);

// Check if user can RSVP
$can_rsvp = events_can_rsvp($event_id);

// Get RSVP count
$rsvp_count = $db->fetch_field(
    $db->simple_select("event_plugin_rsvps", "COUNT(*) as count", 
        "event_id = " . $event_id . " AND status = 'attending'"),
    "count"
);

// Check if user is GEC for this event
$is_gec = events_is_event_gec($event_id);

// Get RSVPs if GEC
$rsvps = array();
if($is_gec)
{
    $action = $mybb->input['action'] ?? '';
    
    if($action == 'rsvps' || $action == 'attendance')
    {
        // Get RSVPs for GEC view
        $filter_costume = $mybb->input['filter_costume'] ?? '';
        $filter_day = (int)($mybb->input['filter_day'] ?? 0);
        
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
        
        while($rsvp = $db->fetch_array($query))
        {
            // Get costumes
            $costumes = array();
            $costume_query = $db->simple_select("event_plugin_rsvp_costumes", "costume", "rsvp_id = " . (int)$rsvp['id']);
            while($costume = $db->fetch_array($costume_query))
            {
                $costumes[] = $costume['costume'];
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
            
            $rsvps[] = array(
                'username' => $rsvp['username'],
                'realname' => $rsvp['realname'] ?? '',
                'tk_id' => $tk_id ?? '',
                'costumes' => $costumes,
                'days' => $days,
                'rsvp_date' => $rsvp['rsvp_date']
            );
        }
    }
}

// Check if event has ended and user can create troop report
$can_create_troop_report = false;
if(strtotime($event['end_date']) < time() && events_has_rsvped($event_id))
{
    $query = $db->simple_select("event_plugin_troop_reports", "posted_at", "event_id = " . $event_id);
    $troop_report = $db->fetch_array($query);
    if(!$troop_report || !$troop_report['posted_at'])
    {
        $can_create_troop_report = true;
    }
}

// Add navigation
add_breadcrumb("Events", "events.php");
add_breadcrumb(htmlspecialchars_uni($event['title']), "event.php?id=" . $event_id);

// Prepare template variables
$event_title = htmlspecialchars_uni($event['title']);
$event_region = htmlspecialchars_uni($event['region']);
$event_start_date = events_format_date($event['start_date']);
$event_end_date = events_format_date($event['end_date']);
$event_signup_cutoff = $event['signup_cutoff'] ? events_format_date($event['signup_cutoff']) : '';
$event_requires_wwcc = $event['requires_wwcc'];
$event_description = $event['description'];
$event_thread_id = $event['thread_id'];

// Prepare event days for template
$event_days_list = '';
if(!empty($event_days))
{
    foreach($event_days as $day)
    {
        $day_display = events_format_date($day['date'], 'l, F j, Y');
        if($day['start_time'] && $day['end_time'])
        {
            $day_display .= ' (' . date('g:i A', strtotime($day['start_time'])) . ' - ' . date('g:i A', strtotime($day['end_time'])) . ')';
        }
        $event_days_list .= '<li>' . $day_display . '</li>';
    }
}

// Prepare RSVPs for template if GEC
$rsvps_list = '';
$filter_costume = $mybb->input['filter_costume'] ?? '';
$filter_day = (int)($mybb->input['filter_day'] ?? 0);
if($is_gec && ($action == 'rsvps' || $action == 'attendance'))
{
    foreach($rsvps as $rsvp)
    {
        $rsvps_list .= '<tr>';
        $rsvps_list .= '<td>' . htmlspecialchars_uni($rsvp['username']) . '</td>';
        $rsvps_list .= '<td>' . htmlspecialchars_uni($rsvp['realname']) . '</td>';
        $rsvps_list .= '<td>' . htmlspecialchars_uni($rsvp['tk_id']) . '</td>';
        $rsvps_list .= '<td>' . htmlspecialchars_uni(implode(', ', $rsvp['costumes'])) . '</td>';
        $rsvps_list .= '<td>' . htmlspecialchars_uni(implode(', ', $rsvp['days'])) . '</td>';
        $rsvps_list .= '<td>' . events_format_date($rsvp['rsvp_date']) . '</td>';
        $rsvps_list .= '</tr>';
    }
}

// If action is attendance, redirect to attendance page
if($action == 'attendance' && $is_gec)
{
    redirect("events.php?action=attendance&id=" . $event_id);
}

// Output page
eval("\$page = \"" . $templates->get("header") . "\";");
output_page($page);

eval("\$event_view = \"" . $templates->get("event_view") . "\";");
output_page($event_view);

eval("\$page = \"" . $templates->get("footer") . "\";");
output_page($page);

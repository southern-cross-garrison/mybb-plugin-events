<?php
/**
 * MyBB Event Plugin - Troop Report Generation
 */

define("IN_MYBB", 1);
require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

// Check if user is logged in
if($mybb->user['uid'] == 0)
{
    error_no_permission();
}

$event_id = (int)$mybb->input['id'];
$action = $mybb->input['action'] ?? 'create';

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

// Check if event has ended
if(strtotime($event['end_date']) > time())
{
    error("This event has not ended yet.");
}

// Check if user has RSVPed
if(!events_has_rsvped($event_id))
{
    error("You must have RSVPed to this event to create a troop report.");
}

// Check if troop report already exists
$query = $db->simple_select("event_plugin_troop_reports", "*", "event_id = " . $event_id);
$troop_report = $db->fetch_array($query);

if($troop_report && $troop_report['posted_at'])
{
    error("A troop report has already been posted for this event.");
}

if($mybb->request_method == "post" && $action == 'post')
{
    // Create forum post
    require_once MYBB_ROOT . "inc/datahandlers/post.php";
    
    $posthandler = new PostDataHandler("insert");
    $posthandler->action = "thread";
    
    $post_data = array(
        'fid' => (int)$mybb->settings['events_troop_report_forum'],
        'subject' => "Troop Report: " . $event['title'],
        'message' => $mybb->input['report_content'],
        'uid' => $mybb->user['uid'],
        'ipaddress' => get_ip()
    );
    
    $posthandler->set_data($post_data);
    
    if($posthandler->validate_thread())
    {
        $thread = $posthandler->insert_thread();
        
        if($thread['error'])
        {
            error($thread['error']);
        }
        
        $thread_id = $thread['tid'];
        
        // Update troop report
        if($troop_report)
        {
            $db->update_query("event_plugin_troop_reports", array(
                'thread_id' => $thread_id,
                'posted_at' => date('Y-m-d H:i:s')
            ), "id = " . (int)$troop_report['id']);
        }
        else
        {
            $db->insert_query("event_plugin_troop_reports", array(
                'event_id' => $event_id,
                'thread_id' => $thread_id,
                'created_by' => $mybb->user['uid'],
                'created_at' => date('Y-m-d H:i:s'),
                'posted_at' => date('Y-m-d H:i:s')
            ));
        }
        
        // Auto-comment on event thread if linked
        if($event['thread_id'])
        {
            require_once MYBB_ROOT . "inc/datahandlers/post.php";
            $posthandler = new PostDataHandler("insert");
            $posthandler->action = "post";
            
            $post_data = array(
                'tid' => $event['thread_id'],
                'message' => "Troop report has been posted: [url=" . $mybb->settings['bburl'] . "/showthread.php?tid=" . $thread_id . "]View Troop Report[/url]",
                'uid' => $mybb->user['uid'],
                'ipaddress' => get_ip()
            );
            
            $posthandler->set_data($post_data);
            if($posthandler->validate_post())
            {
                $posthandler->insert_post();
            }
        }
        
        // Archive event
        $db->update_query("event_plugin_events", array('status' => 'archived'), "id = " . $event_id);
        
        redirect("showthread.php?tid=" . $thread_id, "Troop report posted successfully!");
    }
    else
    {
        $errors = $posthandler->get_friendly_errors();
        error(implode("<br />", $errors));
    }
}

// Generate draft report
$rsvps = array();
$query = $db->query("
    SELECT r.*, u.username, u.uid, uf.realname
    FROM " . TABLE_PREFIX . "event_plugin_rsvps r
    LEFT JOIN " . TABLE_PREFIX . "users u ON r.user_id = u.uid
    LEFT JOIN " . TABLE_PREFIX . "userfields uf ON u.uid = uf.ufid
    WHERE r.event_id = " . (int)$event_id . " AND r.status = 'attending'
    ORDER BY u.username ASC
");

$attendees_by_club = array(
    '501st' => array(),
    'SCG' => array(),
    'Other' => array()
);

$scg_group = events_get_setting('scg_members_group');
$legion_group = events_get_setting('501st_members_group');

while($rsvp = $db->fetch_array($query))
{
    // Get costumes
    $costumes = array();
    $costume_query = $db->simple_select("event_plugin_rsvp_costumes", "costume", "rsvp_id = " . (int)$rsvp['id']);
    while($costume = $db->fetch_array($costume_query))
    {
        $costumes[] = $costume['costume'];
    }
    
    // Get TK ID
    $tk_id = events_get_user_field($rsvp['uid'], 'tk_id');
    
    // Determine club categorization
    $user_groups = explode(',', $rsvp['additionalgroups'] ?? '');
    $user_groups[] = $rsvp['usergroup'];
    
    $club = 'Others';
    if(in_array($scg_group, $user_groups))
    {
        $club = 'Southern Cross Garrison Members';
    }
    elseif(in_array($legion_group, $user_groups))
    {
        $club = 'Other 501st Members';
    }
    
    $attendees_by_club[$club][] = array(
        'username' => $rsvp['username'],
        'realname' => $rsvp['realname'] ?? '',
        'tk_id' => $tk_id ?? '',
        'costumes' => $costumes
    );
}

// Build draft content
$draft_content = "[b]Event:[/b] " . $event['title'] . "\n";
$draft_content .= "[b]Date:[/b] " . events_format_date($event['start_date']) . " - " . events_format_date($event['end_date']) . "\n";
$draft_content .= "[b]Region:[/b] " . $event['region'] . "\n\n";

foreach($attendees_by_club as $club => $attendees)
{
    if(empty($attendees))
    {
        continue;
    }
    
    $draft_content .= "[b]" . $club . " Attendees:[/b]\n";
    foreach($attendees as $attendee)
    {
        $draft_content .= "- " . $attendee['realname'] . " (" . $attendee['username'] . ")";
        if($attendee['tk_id'])
        {
            $draft_content .= " - TK ID: " . $attendee['tk_id'];
        }
        if(!empty($attendee['costumes']))
        {
            $draft_content .= " - Costumes: " . implode(', ', $attendee['costumes']);
        }
        $draft_content .= "\n";
    }
    $draft_content .= "\n";
}

// Add navigation
add_breadcrumb("Events", "events.php");
add_breadcrumb(htmlspecialchars_uni($event['title']), "event.php?id=" . $event_id);
add_breadcrumb("Troop Report", "troop_report.php?id=" . $event_id);

// Output page
eval("\$page = \"" . $templates->get("header") . "\";");
output_page($page);

eval("\$troop_report = \"" . $templates->get("troop_report_draft") . "\";");
output_page($troop_report);

eval("\$page = \"" . $templates->get("footer") . "\";");
output_page($page);

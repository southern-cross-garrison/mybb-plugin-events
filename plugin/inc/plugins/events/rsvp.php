<?php
/**
 * MyBB Event Plugin - RSVP Flow
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
$step = $mybb->input['step'] ?? 'prerequisites';

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

// Check if user can RSVP
if(!events_can_rsvp($event_id))
{
    error("You cannot RSVP to this event.");
}

// Check if already RSVPed
if(events_has_rsvped($event_id))
{
    error("You have already RSVPed to this event.");
}

// Add navigation
add_breadcrumb("Events", "events.php");
add_breadcrumb(htmlspecialchars_uni($event['title']), "event.php?id=" . $event_id);
add_breadcrumb("RSVP", "rsvp.php?id=" . $event_id);

if($mybb->request_method == "post")
{
    if($step == 'prerequisites')
    {
        // Save prerequisites
        $tk_id_field = events_get_setting('tk_id_field');
        $wwcc_field = events_get_setting('wwcc_field');
        $mobile_field = events_get_setting('mobile_field');
        $emergency_field = events_get_setting('emergency_contact_field');
        
        // Update user profile fields
        $update_fields = array();
        
        if($tk_id_field && isset($mybb->input['tk_id']))
        {
            $update_fields['fid' . (int)$tk_id_field] = $db->escape_string($mybb->input['tk_id']);
        }
        
        if($wwcc_field && isset($mybb->input['wwcc']))
        {
            $update_fields['fid' . (int)$wwcc_field] = $db->escape_string($mybb->input['wwcc']);
        }
        
        if($mobile_field && isset($mybb->input['mobile']))
        {
            $update_fields['fid' . (int)$mobile_field] = $db->escape_string($mybb->input['mobile']);
        }
        
        if($emergency_field && isset($mybb->input['emergency_contact']))
        {
            $update_fields['fid' . (int)$emergency_field] = $db->escape_string($mybb->input['emergency_contact']);
        }
        
        if(!empty($update_fields))
        {
            // Check if userfields record exists
            $check = $db->simple_select("userfields", "ufid", "ufid = " . (int)$mybb->user['uid']);
            if($db->num_rows($check) > 0)
            {
                $db->update_query("userfields", $update_fields, "ufid = " . (int)$mybb->user['uid']);
            }
            else
            {
                $update_fields['ufid'] = $mybb->user['uid'];
                $db->insert_query("userfields", $update_fields);
            }
        }
        
        // Move to next step
        redirect("rsvp.php?id=" . $event_id . "&step=costumes", "Prerequisites saved.");
    }
    elseif($step == 'costumes')
    {
        // Validate costumes
        if(empty($mybb->input['costumes']) || !is_array($mybb->input['costumes']))
        {
            error("Please select at least one costume.");
        }
        
        // Store in session or move to next step
        $mybb->input['selected_costumes'] = $mybb->input['costumes'];
        
        // Check if multi-day event
        $query = $db->simple_select("event_plugin_event_days", "id", "event_id = " . $event_id);
        if($db->num_rows($query) > 0)
        {
            redirect("rsvp.php?id=" . $event_id . "&step=days", "Costumes selected.");
        }
        else
        {
            redirect("rsvp.php?id=" . $event_id . "&step=confirm", "Costumes selected.");
        }
    }
    elseif($step == 'days')
    {
        // Validate days
        if(empty($mybb->input['days']) || !is_array($mybb->input['days']))
        {
            error("Please select at least one day.");
        }
        
        redirect("rsvp.php?id=" . $event_id . "&step=confirm", "Days selected.");
    }
    elseif($step == 'confirm')
    {
        // Create RSVP
        $rsvp_data = array(
            'event_id' => $event_id,
            'user_id' => $mybb->user['uid'],
            'rsvp_date' => date('Y-m-d H:i:s'),
            'status' => 'attending'
        );
        
        $rsvp_id = $db->insert_query("event_plugin_rsvps", $rsvp_data);
        
        // Add costumes
        if(isset($mybb->input['costumes']) && is_array($mybb->input['costumes']))
        {
            foreach($mybb->input['costumes'] as $costume)
            {
                $db->insert_query("event_plugin_rsvp_costumes", array(
                    'rsvp_id' => $rsvp_id,
                    'costume' => $db->escape_string($costume)
                ));
            }
        }
        
        // Add days
        if(isset($mybb->input['days']) && is_array($mybb->input['days']))
        {
            foreach($mybb->input['days'] as $day_id)
            {
                $db->insert_query("event_plugin_rsvp_days", array(
                    'rsvp_id' => $rsvp_id,
                    'event_day_id' => (int)$day_id
                ));
            }
        }
        else
        {
            // If no days selected and event has days, add all days
            $query = $db->simple_select("event_plugin_event_days", "id", "event_id = " . $event_id);
            while($day = $db->fetch_array($query))
            {
                $db->insert_query("event_plugin_rsvp_days", array(
                    'rsvp_id' => $rsvp_id,
                    'event_day_id' => $day['id']
                ));
            }
        }
        
        redirect("rsvp.php?id=" . $event_id . "&step=success", "RSVP confirmed!");
    }
}

// Check prerequisites
$missing_prerequisites = events_check_prerequisites($event_id);

// Get user's costumes
$costume_field = events_get_setting('costume_field');
$user_costumes = array();
if($costume_field)
{
    $query = $db->simple_select("userfields", "fid" . (int)$costume_field, "ufid = " . (int)$mybb->user['uid']);
    $field = $db->fetch_array($query);
    if($field && $field['fid' . (int)$costume_field])
    {
        // Parse costume field (could be comma-separated or other format)
        $costumes_raw = $field['fid' . (int)$costume_field];
        $user_costumes = array_map('trim', explode(',', $costumes_raw));
    }
}

// Get event days
$event_days = array();
$query = $db->simple_select("event_plugin_event_days", "*", "event_id = " . $event_id, array("order_by" => "date", "order_dir" => "ASC"));
while($day = $db->fetch_array($query))
{
    $event_days[] = $day;
}

// Output page
eval("\$page = \"" . $templates->get("header") . "\";");
output_page($page);

if($step == 'success')
{
    eval("\$rsvp_success = \"" . $templates->get("rsvp_confirm") . "\";");
    output_page($rsvp_success);
}
elseif(!empty($missing_prerequisites))
{
    eval("\$rsvp_prereq = \"" . $templates->get("rsvp_prerequisites") . "\";");
    output_page($rsvp_prereq);
}
elseif($step == 'costumes')
{
    eval("\$rsvp_costumes = \"" . $templates->get("rsvp_form") . "\";");
    output_page($rsvp_costumes);
}
elseif($step == 'days')
{
    eval("\$rsvp_days = \"" . $templates->get("rsvp_form") . "\";");
    output_page($rsvp_days);
}
elseif($step == 'confirm')
{
    eval("\$rsvp_confirm = \"" . $templates->get("rsvp_confirm") . "\";");
    output_page($rsvp_confirm);
}
else
{
    // Default to prerequisites check
    if(!empty($missing_prerequisites))
    {
        eval("\$rsvp_prereq = \"" . $templates->get("rsvp_prerequisites") . "\";");
        output_page($rsvp_prereq);
    }
    else
    {
        redirect("rsvp.php?id=" . $event_id . "&step=costumes");
    }
}

eval("\$page = \"" . $templates->get("footer") . "\";");
output_page($page);

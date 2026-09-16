<?php
/**
 * MyBB Event Plugin - RSVP wizard
 *
 * Steps: prerequisites -> costumes -> days (multi-day events only) -> confirm.
 * Each step POSTs the accumulated selections forward as hidden inputs, so nothing is
 * lost between steps and the flow survives a refresh or a back button.
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "rsvp.php");

$templatelist = "events_rsvp_form,events_rsvp_success";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

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

$lock_reason = events_rsvp_lock_reason($event);
if($lock_reason !== null)
{
    error(events_rsvp_lock_message($lock_reason));
}

$event_title = htmlspecialchars_uni($event['title']);
$event_days = events_get_event_days($event_id);
$has_days = !empty($event_days);
$valid_day_ids = array();
foreach($event_days as $day)
{
    $valid_day_ids[] = (int)$day['id'];
}

add_breadcrumb("Events", "events.php");
add_breadcrumb($event['title'], "event.php?id=" . $event_id);
add_breadcrumb("RSVP", "rsvp.php?id=" . $event_id);

$user_costumes = events_get_user_costumes($mybb->user['uid']);

// Selections carried forward between steps.
$selected_costumes = array();
foreach((array)$mybb->get_input('costumes', MyBB::INPUT_ARRAY) as $costume)
{
    $costume = trim($costume);
    if($costume !== '' && in_array($costume, $user_costumes, true))
    {
        $selected_costumes[] = $costume;
    }
}
$selected_costumes = array_values(array_unique($selected_costumes));

$selected_days = array();
foreach((array)$mybb->get_input('days', MyBB::INPUT_ARRAY) as $day_id)
{
    $day_id = (int)$day_id;
    if(in_array($day_id, $valid_day_ids, true))
    {
        $selected_days[] = $day_id;
    }
}
$selected_days = array_values(array_unique($selected_days));

$errors = array();
$render = 'prerequisites';
$missing = events_check_prerequisites($event);

if($mybb->request_method === 'post')
{
    verify_post_check($mybb->get_input('my_post_key'));

    $submitted = $mybb->get_input('step');

    if($submitted === 'prerequisites')
    {
        $values = array();
        foreach(array_keys(events_prerequisite_labels()) as $field)
        {
            if(isset($mybb->input[$field]))
            {
                $values[$field] = trim($mybb->get_input($field));
            }
        }

        events_save_user_fields($mybb->user['uid'], $values);

        $missing = events_check_prerequisites($event);
        if(!empty($missing))
        {
            $errors[] = 'Please complete every required field.';
            $render = 'prerequisites';
        }
        else
        {
            $render = 'costumes';
        }
    }
    elseif($submitted === 'costumes')
    {
        if(empty($selected_costumes))
        {
            $errors[] = 'Please select at least one costume.';
            $render = 'costumes';
        }
        else
        {
            $render = $has_days ? 'days' : 'confirm';
        }
    }
    elseif($submitted === 'days')
    {
        if(empty($selected_days))
        {
            $errors[] = 'Please select at least one day.';
            $render = 'days';
        }
        else
        {
            $render = 'confirm';
        }
    }
    elseif($submitted === 'confirm')
    {
        if(empty($selected_costumes))
        {
            $errors[] = 'Please select at least one costume.';
            $render = 'costumes';
        }
        elseif($has_days && empty($selected_days))
        {
            $errors[] = 'Please select at least one day.';
            $render = 'days';
        }
        else
        {
            $rsvp_id = (int)$db->insert_query("event_plugin_rsvps", array(
                'event_id'  => $event_id,
                'user_id'   => (int)$mybb->user['uid'],
                'rsvp_date' => $db->escape_string(date('Y-m-d H:i:s', TIME_NOW)),
                'status'    => 'attending',
            ));

            foreach($selected_costumes as $costume)
            {
                $db->insert_query("event_plugin_rsvp_costumes", array(
                    'rsvp_id' => $rsvp_id,
                    'costume' => $db->escape_string($costume),
                ));
            }

            foreach($selected_days as $day_id)
            {
                $db->insert_query("event_plugin_rsvp_days", array(
                    'rsvp_id'      => $rsvp_id,
                    'event_day_id' => $day_id,
                ));
            }

            $render = 'success';
        }
    }
}
elseif(empty($missing))
{
    $render = 'costumes';
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------
if($render === 'success')
{
    $summary_days = array();
    foreach($event_days as $day)
    {
        if(in_array((int)$day['id'], $selected_days, true))
        {
            $summary_days[] = events_day_label($day);
        }
    }

    $rsvp_summary = '<p id="rsvp_summary_costumes"><strong>Costumes:</strong> ' . htmlspecialchars_uni(implode(', ', $selected_costumes)) . '</p>';
    if(!empty($summary_days))
    {
        $rsvp_summary .= '<p id="rsvp_summary_days"><strong>Days:</strong> ' . htmlspecialchars_uni(implode(', ', $summary_days)) . '</p>';
    }

    eval("\$page = \"" . $templates->get("events_rsvp_success") . "\";");
    output_page($page);
    exit;
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------
$rsvp_step = $render;
$rsvp_intro = '';
$rsvp_body = '';
$rsvp_carried_state = '';
$rsvp_submit_label = 'Continue';
$rsvp_page_title = 'RSVP: ' . $event_title;

if(!empty($errors))
{
    $rsvp_intro .= '<div class="error" id="rsvp_errors"><ul>';
    foreach($errors as $error)
    {
        $rsvp_intro .= '<li>' . htmlspecialchars_uni($error) . '</li>';
    }
    $rsvp_intro .= '</ul></div>';
}

// Everything selected so far is re-posted with each step.
function events_hidden_inputs($name, array $values)
{
    $html = '';
    foreach($values as $value)
    {
        $html .= '<input type="hidden" name="' . $name . '[]" value="' . htmlspecialchars_uni($value) . '" />';
    }

    return $html;
}

if($rsvp_step === 'prerequisites')
{
    $rsvp_page_title = 'RSVP Prerequisites';
    $rsvp_intro .= '<p>Before you can RSVP to <strong>' . $event_title . '</strong> we need the following details. They are saved to your profile.</p>';

    $labels = events_prerequisite_labels();
    foreach($missing as $field => $unused)
    {
        $label = $labels[$field];
        $current = htmlspecialchars_uni($mybb->get_input($field));
        $rsvp_body .= '<div class="form_row"><label for="prereq_' . $field . '">' . $label['label'] . ' <span class="required">*</span></label> '
            . '<input type="text" id="prereq_' . $field . '" name="' . $field . '" value="' . $current . '" required="required" /> '
            . '<small>' . $label['hint'] . '</small></div>';
    }

    $rsvp_submit_label = 'Save and Continue';
}
elseif($rsvp_step === 'costumes')
{
    $rsvp_page_title = 'Select Costumes';
    $rsvp_intro .= '<p>Select the costume(s) you intend to wear at <strong>' . $event_title . '</strong>.</p>';

    if(empty($user_costumes))
    {
        $rsvp_body = '<p id="rsvp_no_costumes">No costumes are listed on your profile. '
            . '<a href="usercp.php?action=profile">Add your costumes</a> and then come back.</p>';
        $rsvp_submit_label = 'Continue';
    }
    else
    {
        foreach($user_costumes as $index => $costume)
        {
            $checked = in_array($costume, $selected_costumes, true) ? ' checked="checked"' : '';
            $rsvp_body .= '<label class="costume_option"><input type="checkbox" class="costume_checkbox" id="costume_' . $index . '" name="costumes[]" value="'
                . htmlspecialchars_uni($costume) . '"' . $checked . ' /> ' . htmlspecialchars_uni($costume) . '</label><br />';
        }
    }
}
elseif($rsvp_step === 'days')
{
    $rsvp_page_title = 'Select Days';
    $rsvp_intro .= '<p>Select the days you will attend.</p>';
    $rsvp_carried_state = events_hidden_inputs('costumes', $selected_costumes);

    foreach($event_days as $day)
    {
        // Default to attending every day the first time this step is shown.
        $checked = (empty($selected_days) || in_array((int)$day['id'], $selected_days, true)) ? ' checked="checked"' : '';
        $rsvp_body .= '<label class="day_option"><input type="checkbox" class="day_checkbox" id="day_' . (int)$day['id'] . '" name="days[]" value="'
            . (int)$day['id'] . '"' . $checked . ' /> ' . events_day_label($day) . '</label><br />';
    }
}
elseif($rsvp_step === 'confirm')
{
    $rsvp_page_title = 'Confirm RSVP';
    $rsvp_carried_state = events_hidden_inputs('costumes', $selected_costumes) . events_hidden_inputs('days', $selected_days);
    $rsvp_submit_label = 'Confirm RSVP';

    $summary_days = array();
    foreach($event_days as $day)
    {
        if(in_array((int)$day['id'], $selected_days, true))
        {
            $summary_days[] = events_day_label($day);
        }
    }

    $rsvp_body = '<p><strong>Event:</strong> <span id="confirm_event">' . $event_title . '</span></p>'
        . '<p><strong>Costumes:</strong> <span id="confirm_costumes">' . htmlspecialchars_uni(implode(', ', $selected_costumes)) . '</span></p>';

    if(!empty($summary_days))
    {
        $rsvp_body .= '<p><strong>Days:</strong> <span id="confirm_days">' . htmlspecialchars_uni(implode(', ', $summary_days)) . '</span></p>';
    }
}

eval("\$page = \"" . $templates->get("events_rsvp_form") . "\";");
output_page($page);

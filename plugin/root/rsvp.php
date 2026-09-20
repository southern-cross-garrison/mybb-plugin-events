<?php
/**
 * MyBB Event Plugin - Signup wizard
 *
 * One flow covers both ways of turning up. The member signs up to *attend*, and chooses
 * per day whether they are trooping (in costume) or wrangling (a non-costumed helper),
 * so a weekend event can be trooped on the Saturday and wrangled on the Sunday. Every
 * day defaults to trooping, which is the overwhelmingly common case; overriding a day is
 * one radio button.
 *
 * Steps: attendance -> prerequisites -> costumes -> confirm. Attendance comes first
 * because it decides the rest of the sequence: the TK ID is only a prerequisite once a
 * day is being trooped, and the costumes step does not exist for a signup that is
 * wrangling throughout. Each step POSTs the accumulated selections forward as hidden
 * inputs, so nothing is lost between steps and the flow survives a refresh or a back
 * button.
 *
 * The same wizard is the edit form. Re-opening it pre-selects whatever the member
 * already holds, and confirming rewrites it - which is how somebody adds wrangling to a
 * signup they made as a trooper, now that there is no separate wrangler button to press.
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

// Holding a signup is not a lock: the wizard doubles as the edit form.
$lock_reason = events_signup_lock_reason($event);
if($lock_reason !== null)
{
    error(events_signup_lock_message($lock_reason));
}

$event_title = htmlspecialchars_uni($event['title']);
$event_days = events_get_event_days($event_id);
$has_days = !empty($event_days);
$valid_day_ids = array();
foreach($event_days as $day)
{
    $valid_day_ids[] = (int)$day['id'];
}

$existing_signup = events_get_user_signup($event_id);
$is_update = !empty($existing_signup);
$signup_mode = $is_update ? 'update' : 'create';

add_breadcrumb("Events", "events.php");
add_breadcrumb($event['title'], "event.php?id=" . $event_id);
add_breadcrumb($is_update ? "Update Signup" : "Sign Up", "rsvp.php?id=" . $event_id);

$user_costumes = events_get_user_costumes($mybb->user['uid']);

// ---------------------------------------------------------------------------
// Selections carried between steps
//
// $day_roles is the whole intent for a multi-day event: day id => role, with days the
// member is not attending simply absent. An event with no configured days has one role
// for the whole thing instead, in $solo_role.
// ---------------------------------------------------------------------------
// rsvp.php?id=N&role=wrangler pre-selects wrangling rather than opening a separate flow -
// the old wrangler links, and the way out of the costumes step for a member with no
// costume on file. An explicitly requested role beats an existing signup's selections,
// because asking for that link is the member saying they want the other role.
$requested_role = $mybb->get_input('role');
$role_requested = in_array($requested_role, events_rsvp_roles(), true);
$preferred_role = $role_requested ? $requested_role : 'trooper';

$submitted_step = ($mybb->request_method === 'post') ? $mybb->get_input('step') : '';

$posted_day_roles = (array)$mybb->get_input('day_role', MyBB::INPUT_ARRAY);
$posted_solo_role = $mybb->get_input('signup_role');

// A radio group with nothing selected is simply absent from the POST, so the step the
// form came from is what proves the attendance answers were carried - not their presence.
$attendance_posted = !empty($posted_day_roles) || $posted_solo_role !== '' || $submitted_step === 'attendance';

$day_roles = array();
$solo_role = '';

if($attendance_posted)
{
    foreach($posted_day_roles as $day_id => $value)
    {
        $day_id = (int)$day_id;
        if(in_array($day_id, $valid_day_ids, true) && in_array($value, events_rsvp_roles(), true))
        {
            $day_roles[$day_id] = $value;
        }
    }

    $solo_role = in_array($posted_solo_role, events_rsvp_roles(), true) ? $posted_solo_role : '';
}
elseif($is_update && !$role_requested)
{
    foreach($existing_signup as $role => $held)
    {
        foreach($held['days'] as $day_id)
        {
            if(in_array((int)$day_id, $valid_day_ids, true))
            {
                $day_roles[(int)$day_id] = $role;
            }
        }

        $solo_role = $role;
    }

    // A signup made before the event gained days, or one whose days were deleted, has
    // nothing to pre-select. Fall back to the default rather than showing an empty form.
    if($has_days && empty($day_roles))
    {
        foreach($valid_day_ids as $day_id)
        {
            $day_roles[$day_id] = $solo_role !== '' ? $solo_role : $preferred_role;
        }
    }
}
else
{
    // The default is the whole event, trooping.
    foreach($valid_day_ids as $day_id)
    {
        $day_roles[$day_id] = $preferred_role;
    }

    $solo_role = $preferred_role;
}

// role => day ids. An event with no days still records the role, against no days.
$role_days = array();
if($has_days)
{
    foreach($day_roles as $day_id => $role)
    {
        $role_days[$role][] = $day_id;
    }
}
elseif($solo_role !== '')
{
    $role_days[$solo_role] = array();
}

$roles = array_keys($role_days);

$costumes_posted = isset($mybb->input['costumes']) || $submitted_step === 'costumes';
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

if(!$costumes_posted && isset($existing_signup['trooper']))
{
    $selected_costumes = array_values(array_intersect($existing_signup['trooper']['costumes'], $user_costumes));
}

if(!in_array('trooper', $roles, true))
{
    // Nothing is being trooped, so there is nothing to be in costume for. Dropping the
    // values here (rather than just skipping the step) is what stops a hand-crafted POST
    // writing rsvp_costumes rows for a wrangling-only signup.
    $selected_costumes = array();
}

$errors = array();
$render = 'attendance';
$missing = events_check_prerequisites($event, null, $roles);
$steps = events_signup_steps($roles, $missing);

if($mybb->request_method === 'post')
{
    verify_post_check($mybb->get_input('my_post_key'));

    $submitted = $submitted_step;

    // A step that does not apply to these selections (or junk input) restarts the flow.
    if(!in_array($submitted, $steps, true))
    {
        $submitted = 'attendance';
    }

    if($submitted === 'attendance')
    {
        if(empty($role_days))
        {
            $errors[] = $has_days ? 'Please choose at least one day to attend.' : 'Please choose how you will be attending.';
            $render = 'attendance';
        }
        else
        {
            $render = events_signup_next_step('attendance', $roles, $missing);
        }
    }
    elseif($submitted === 'prerequisites')
    {
        $values = array();
        foreach(array_keys($missing) as $field)
        {
            if(isset($mybb->input[$field]))
            {
                $values[$field] = trim($mybb->get_input($field));
            }
        }

        events_save_user_fields($mybb->user['uid'], $values);

        $missing = events_check_prerequisites($event, null, $roles);
        if(!empty($missing))
        {
            $errors[] = 'Please complete every required field.';
            $render = 'prerequisites';
        }
        else
        {
            // Saving the values is what removed this step from the sequence, so the
            // question is what follows attendance now, not what follows prerequisites.
            $render = events_signup_next_step('attendance', $roles, $missing);
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
            $render = events_signup_next_step('costumes', $roles, $missing);
        }
    }
    elseif($submitted === 'confirm')
    {
        // Confirm is reachable as the second page a member sees (nothing missing, a
        // wrangling-only signup), so this is the only server-side gate that every write
        // path is guaranteed to pass through. The checks run in wizard order, so a
        // skipped-ahead POST is sent back to the earliest step it failed rather than to
        // whichever one happened to be tested first.
        $missing = events_check_prerequisites($event, null, $roles);

        if(empty($role_days))
        {
            $errors[] = $has_days ? 'Please choose at least one day to attend.' : 'Please choose how you will be attending.';
            $render = 'attendance';
        }
        elseif(!empty($missing))
        {
            $errors[] = 'Please complete every required field.';
            $render = 'prerequisites';
        }
        elseif(in_array('trooper', $roles, true) && empty($selected_costumes))
        {
            $errors[] = 'Please select at least one costume.';
            $render = 'costumes';
        }
        else
        {
            events_save_signup($event_id, $mybb->user['uid'], $role_days, $selected_costumes);
            $render = 'success';
        }
    }

    $steps = events_signup_steps($roles, $missing);
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------
if($render === 'success')
{
    $rsvp_success_title = $is_update ? 'Signup Updated' : 'Signup Confirmed';
    $rsvp_success_message = $is_update
        ? 'Your signup for <strong>' . $event_title . '</strong> has been updated.'
        : 'You are signed up to attend <strong>' . $event_title . '</strong>.';

    $rsvp_summary = events_signup_summary_html($event_days, $role_days, 'rsvp_summary');

    if(!empty($selected_costumes))
    {
        $rsvp_summary .= '<p id="rsvp_summary_costumes"><strong>Costumes:</strong> ' . htmlspecialchars_uni(implode(', ', $selected_costumes)) . '</p>';
    }

    $events_print_header = events_print_header($rsvp_success_title, array($event['title']));

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
$rsvp_page_title = ($is_update ? 'Update Signup: ' : 'Sign Up: ') . $event_title;

if(!empty($errors))
{
    $rsvp_intro .= '<div class="error" id="rsvp_errors"><ul>';
    foreach($errors as $error)
    {
        $rsvp_intro .= '<li>' . htmlspecialchars_uni($error) . '</li>';
    }
    $rsvp_intro .= '</ul></div>';
}

/**
 * Everything selected so far is re-posted with each step.
 */
function events_hidden_inputs($name, array $values)
{
    $html = '';
    foreach($values as $value)
    {
        $html .= '<input type="hidden" name="' . $name . '[]" value="' . htmlspecialchars_uni($value) . '" />';
    }

    return $html;
}

/**
 * The same, for the day id => role map.
 */
function events_hidden_map($name, array $map)
{
    $html = '';
    foreach($map as $key => $value)
    {
        $html .= '<input type="hidden" name="' . $name . '[' . (int)$key . ']" value="' . htmlspecialchars_uni($value) . '" />';
    }

    return $html;
}

// Built in PHP rather than added to the template: events_install_templates() only writes
// the master template set, so a board with a theme-level override would never receive a
// new field and would silently drop the attendance answers, turning a mixed signup into
// the default one.
$attendance_state = $has_days
    ? events_hidden_map('day_role', $day_roles)
    : '<input type="hidden" name="signup_role" value="' . htmlspecialchars_uni($solo_role) . '" />';

if($rsvp_step === 'attendance')
{
    $rsvp_page_title = $is_update ? 'Update Your Signup' : 'Sign Up to Attend';

    $role_help = '<p class="signup_role_help">A <strong>trooper</strong> turns out in costume. A <strong>wrangler</strong> is a '
               . 'non-costumed helper - handling crowds, kit and queues - and does not need to be a full member.</p>';

    if($has_days)
    {
        $rsvp_intro .= '<p>You are signed up for every day of <strong>' . $event_title . '</strong> as a trooper unless you '
                     . 'say otherwise. Change any day you would rather wrangle, or mark it as one you cannot make.</p>' . $role_help;

        $choices = array('trooper' => 'Trooping', 'wrangler' => 'Wrangling', 'none' => 'Not attending');

        foreach($event_days as $day)
        {
            $day_id = (int)$day['id'];
            $current = isset($day_roles[$day_id]) ? $day_roles[$day_id] : 'none';

            // A div with role="radiogroup" rather than a fieldset: a <legend> is lifted out
            // of the fieldset's box by the browser and themes restyle it freely, so the
            // layout would be at the mercy of whichever theme the board runs.
            $rsvp_body .= '<div class="signup_day" role="radiogroup" aria-labelledby="day_' . $day_id . '_label" data-day-id="' . $day_id . '">';
            $rsvp_body .= '<span class="signup_day_label" id="day_' . $day_id . '_label">' . events_day_label($day) . '</span>';
            $rsvp_body .= '<span class="signup_choices">';

            foreach($choices as $choice => $label)
            {
                $checked = ($current === $choice) ? ' checked="checked"' : '';
                $rsvp_body .= '<label class="signup_choice"><input type="radio" class="day_role_radio" id="day_' . $day_id . '_' . $choice . '"'
                            . ' name="day_role[' . $day_id . ']" value="' . $choice . '"' . $checked . ' /> ' . $label . '</label>';
            }

            $rsvp_body .= '</span></div>';
        }
    }
    else
    {
        $rsvp_intro .= '<p>Choose how you will be attending <strong>' . $event_title . '</strong>.</p>' . $role_help;

        $rsvp_body .= '<div class="signup_day" role="radiogroup" aria-labelledby="signup_role_label" id="signup_role_choice">';
        $rsvp_body .= '<span class="signup_day_label" id="signup_role_label">How will you be attending?</span>';
        $rsvp_body .= '<span class="signup_choices">';

        foreach(array('trooper' => 'Trooping', 'wrangler' => 'Wrangling') as $choice => $label)
        {
            $checked = ($solo_role === $choice) ? ' checked="checked"' : '';
            $rsvp_body .= '<label class="signup_choice"><input type="radio" class="signup_role_radio" id="signup_role_' . $choice . '"'
                        . ' name="signup_role" value="' . $choice . '"' . $checked . ' /> ' . $label . '</label>';
        }

        $rsvp_body .= '</span></div>';
    }
}
elseif($rsvp_step === 'prerequisites')
{
    $rsvp_page_title = 'Signup Prerequisites';
    $rsvp_intro .= '<p>Before you can sign up to <strong>' . $event_title . '</strong> we need the following details. They are saved to your profile.</p>';
    $rsvp_carried_state .= $attendance_state;

    $labels = events_prerequisite_labels();
    foreach($missing as $field => $unused)
    {
        $label = $labels[$field];
        $current = htmlspecialchars_uni($mybb->get_input($field));

        // Label, control, hint - each on its own line. The asterisk is decoration for
        // sighted readers; the required attribute is what actually says so, which is why
        // it is hidden from assistive technology rather than read out as "star".
        $rsvp_body .= '<div class="events_field">'
            . '<label class="events_label" for="prereq_' . $field . '">' . $label['label']
            . '<span class="events_required" aria-hidden="true">*</span></label>'
            . '<input type="text" class="events_input" id="prereq_' . $field . '" name="' . $field . '" value="' . $current . '"'
            . ' required="required" aria-describedby="hint_' . $field . '" />'
            . '<span class="events_hint" id="hint_' . $field . '">' . $label['hint'] . '</span>'
            . '</div>';
    }

    $rsvp_submit_label = 'Save and Continue';
}
elseif($rsvp_step === 'costumes')
{
    $rsvp_page_title = 'Select Costumes';
    $rsvp_intro .= '<p>Select the costume(s) you intend to wear at <strong>' . $event_title . '</strong>.</p>';
    $rsvp_carried_state .= $attendance_state;

    if(empty($user_costumes))
    {
        // The way out of this dead end is to wrangle instead, which needs no costume, so
        // say so rather than leaving the member with nowhere to go.
        $rsvp_body = '<p id="rsvp_no_costumes">No costumes are listed on your profile. '
            . '<a href="usercp.php?action=profile">Add your costumes</a> and then come back, or '
            . '<a href="rsvp.php?id=' . $event_id . '&amp;role=wrangler" id="rsvp_wrangle_instead">sign up to wrangle instead</a>.</p>';
    }
    else
    {
        $rsvp_body .= '<div class="events_options">';
        foreach($user_costumes as $index => $costume)
        {
            $checked = in_array($costume, $selected_costumes, true) ? ' checked="checked"' : '';
            $rsvp_body .= '<label class="events_option costume_option"><input type="checkbox" class="costume_checkbox" id="costume_' . $index . '" name="costumes[]" value="'
                . htmlspecialchars_uni($costume) . '"' . $checked . ' /> ' . htmlspecialchars_uni($costume) . '</label>';
        }
        $rsvp_body .= '</div>';
    }
}
elseif($rsvp_step === 'confirm')
{
    $rsvp_page_title = $is_update ? 'Confirm Your Changes' : 'Confirm Signup';
    $rsvp_carried_state .= $attendance_state . events_hidden_inputs('costumes', $selected_costumes);
    $rsvp_submit_label = $is_update ? 'Save Changes' : 'Confirm Signup';

    $rsvp_body = '<p><strong>Event:</strong> <span id="confirm_event">' . $event_title . '</span></p>'
        . events_signup_summary_html($event_days, $role_days, 'confirm');

    if(!empty($selected_costumes))
    {
        $rsvp_body .= '<p><strong>Costumes:</strong> <span id="confirm_costumes">' . htmlspecialchars_uni(implode(', ', $selected_costumes)) . '</span></p>';
    }
}

$events_print_header = events_print_header($rsvp_page_title, array($event['title']));

eval("\$page = \"" . $templates->get("events_rsvp_form") . "\";");
output_page($page);

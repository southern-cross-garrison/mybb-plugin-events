<?php
/**
 * MyBB Event Plugin - Signup wizard
 *
 * One flow covers both ways of turning up. The member signs up to *attend*, and chooses
 * whether they are trooping (in costume) or wrangling (a non-costumed helper). That one
 * answer covers the whole event, because that is what almost every signup is; a per-day
 * grid behind a checkbox is what lets a weekend event be trooped on the Saturday and
 * wrangled on the Sunday, or be sat out on the Sunday altogether.
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

// Checked before the lock below, which would otherwise answer an excluded member with
// "you have been excluded from signing up to this event" - a sentence that tells them
// there is an event and that they were kept off it. The event is hidden from them, so
// the wizard answers the way it would for any page they cannot open.
if(!events_can_view_event($event))
{
    error_no_permission();
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

// The attendance step asks one question - trooping or wrangling - and applies the answer
// to the whole event, because all but a handful of signups are the same the whole way
// through. Three values hold that shape:
//
//   $signup_role  the leading answer, always one of the role tokens
//   $day_choices  one entry per configured day: a role, or 'none' for a day being
//                 skipped. This is the form's state, so it carries the skipped days
//                 that $day_roles below drops
//   $per_day      whether the member opened the per-day grid
//
// $per_day is what decides whether the grid is consulted at all. The grid is closed with
// CSS, so its radios keep posting whatever they last held - and a member who opened it,
// changed a day and closed it again would otherwise be signed up to something the page
// was no longer showing them.
$signup_role = $preferred_role;
$day_choices = array();
$per_day = false;
$day_roles = array();
$solo_role = '';

if($attendance_posted)
{
    $signup_role = events_rsvp_role($posted_solo_role);
    $per_day = $mybb->get_input('per_day', MyBB::INPUT_INT) === 1;

    foreach($valid_day_ids as $day_id)
    {
        if(!$per_day)
        {
            $day_choices[$day_id] = $signup_role;
            continue;
        }

        $value = isset($posted_day_roles[$day_id]) ? $posted_day_roles[$day_id] : '';

        if($value === 'none')
        {
            $day_choices[$day_id] = 'none';
        }
        elseif(in_array($value, events_rsvp_roles(), true))
        {
            $day_choices[$day_id] = $value;
        }
        else
        {
            // Every row in the grid holds a real answer, so this is a day that was never
            // drawn or one that came back mangled: it falls back to the leading answer.
            $day_choices[$day_id] = $signup_role;
        }
    }

    $solo_role = in_array($posted_solo_role, events_rsvp_roles(), true) ? $posted_solo_role : '';
}
elseif($is_update && !$role_requested)
{
    $held_days = array();

    foreach($existing_signup as $role => $held)
    {
        foreach($held['days'] as $day_id)
        {
            if(in_array((int)$day_id, $valid_day_ids, true))
            {
                $held_days[(int)$day_id] = $role;
            }
        }

        $solo_role = $role;
    }

    $signup_role = $solo_role !== '' ? $solo_role : $preferred_role;

    if($has_days && empty($held_days))
    {
        // A signup made before the event gained days, or one whose days were deleted, has
        // nothing to pre-select. Fall back to the default rather than showing an empty
        // form - or, worse, one with every day already marked as skipped.
        foreach($valid_day_ids as $day_id)
        {
            $day_choices[$day_id] = $signup_role;
        }
    }
    else
    {
        // A day the member is not attending is simply absent from their signup, so it
        // comes back as skipped rather than as nothing.
        foreach($valid_day_ids as $day_id)
        {
            $day_choices[$day_id] = isset($held_days[$day_id]) ? $held_days[$day_id] : 'none';
        }

        // A signup that is not the same the whole way through opens the grid, so the
        // member is shown the shape of what they hold rather than a leading answer that
        // quietly speaks for days it does not describe.
        $per_day = count(array_unique($day_choices)) > 1;
    }
}
else
{
    // The default is the whole event, trooping.
    foreach($valid_day_ids as $day_id)
    {
        $day_choices[$day_id] = $preferred_role;
    }

    $solo_role = $preferred_role;
    $signup_role = $preferred_role;
}

// The leading question and the grid are two views of one answer, so they are kept in
// step rather than layered: with the grid open, what the days agree on *is* the leading
// answer, and days that disagree leave it unanswered, because no single chip up there
// describes them. (The script that does this live on the page is only mirroring what the
// next render would show anyway, which is what keeps the two honest with each other.)
$day_values = array_values($day_choices);
$uniform_choice = (count($day_values) > 0 && count(array_unique($day_values)) === 1) ? $day_values[0] : '';
$primary_choice = $per_day
    ? (in_array($uniform_choice, events_rsvp_roles(), true) ? $uniform_choice : '')
    : $solo_role;

// Closing the grid makes the leading answer the only one on the page, so a member who
// cleared it by setting the days apart has to answer it again rather than be signed up
// to the fallback that resolves the days above.
$primary_missing = $attendance_posted && $has_days && !$per_day && $solo_role === '';

// The grid holds every day; the signup only holds the ones being attended.
foreach($day_choices as $day_id => $choice)
{
    if($choice !== 'none')
    {
        $day_roles[$day_id] = $choice;
    }
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
        if($primary_missing)
        {
            $errors[] = 'Please choose how you will be attending.';
            $render = 'attendance';
        }
        elseif(empty($role_days))
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

        if($primary_missing)
        {
            $errors[] = 'Please choose how you will be attending.';
            $render = 'attendance';
        }
        elseif(empty($role_days))
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

$rsvp_intro .= events_form_errors($errors, 'rsvp_errors');

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
//
// The grid is carried as every day's choice, skipped days included, alongside the answer
// they were resolved against - a later step re-posts the lot, and a day that came back
// absent would read as one following the leading answer rather than one being sat out.
$attendance_state = $has_days
    ? '<input type="hidden" name="signup_role" value="' . htmlspecialchars_uni($signup_role) . '" />'
      . ($per_day ? '<input type="hidden" name="per_day" value="1" />' : '')
      . events_hidden_map('day_role', $day_choices)
    : '<input type="hidden" name="signup_role" value="' . htmlspecialchars_uni($solo_role) . '" />';

if($rsvp_step === 'attendance')
{
    $rsvp_page_title = $is_update ? 'Update Your Signup' : 'Sign Up to Attend';
    $day_count = count($event_days);

    // The single-day sentence names when it is, because a member arriving from a link or
    // a reminder is often answering "can I make that?" and should not have to go back to
    // the event page to find out. The multi-day one deliberately does not: it is already
    // naming a span of days, and one start time out of several would read as the answer
    // to a question it is not being asked.
    $event_when = events_format_when($event['start_date']);

    $rsvp_intro .= $day_count > 1
        ? '<p>You are signing up for all <strong>' . $day_count . ' days</strong> of <strong>' . $event_title . '</strong>.</p>'
        : '<p>You are signing up to <strong>' . $event_title . '</strong>'
          . ($event_when === '' ? '' : ' - ' . $event_when) . '.</p>';

    // The leading question, and for all but a handful of signups the only one. A div with
    // role="radiogroup" rather than a fieldset: a <legend> is lifted out of the fieldset's
    // box by the browser and themes restyle it freely, so the layout would be at the mercy
    // of whichever theme the board runs.
    $rsvp_body .= '<div class="signup_primary" role="radiogroup" aria-labelledby="signup_role_label">'
                . '<span class="signup_primary_label" id="signup_role_label">How are you attending?</span>'
                . events_signup_choices(
                    'signup_role',
                    array('trooper' => 'Trooping', 'wrangler' => 'Wrangling'),
                    $primary_choice,
                    'signup_role',
                    'signup_role_radio'
                )
                . '</div>';

    // One day, or none configured at all, and the answer above is the whole answer. The
    // grid only exists to say that one day differs from another.
    if($day_count > 1)
    {
        // The checkbox is the disclosure: the stylesheet opens the grid off its :checked
        // state, so it works with no JavaScript on the page, and its value is also what
        // tells the POST handler to read the grid rather than the answer above.
        $rsvp_body .= '<input type="checkbox" class="signup_per_day" id="signup_per_day" name="per_day" value="1"'
                    . ($per_day ? ' checked="checked"' : '') . ' aria-controls="signup_days" />'
                    . '<label class="signup_per_day_label" for="signup_per_day">I am not doing the same thing every day</label>';

        $rsvp_body .= '<div class="signup_days" id="signup_days">'
                    . '<p class="signup_days_hint">Set how you are attending on each day.</p>';

        // Every row says what that day is, rather than offering a "same as above" that
        // defers to the question above: two controls for one answer is what made the step
        // hard to read, because the chip above and the chips below could each be showing
        // something the other contradicted.
        $choices = array(
            'trooper'  => 'Trooping',
            'wrangler' => 'Wrangling',
            'none'     => 'Not attending',
        );

        foreach($event_days as $day)
        {
            $day_id = (int)$day['id'];
            $current = isset($day_choices[$day_id]) ? $day_choices[$day_id] : $signup_role;

            $rsvp_body .= '<div class="signup_day" role="radiogroup" aria-labelledby="day_' . $day_id . '_label" data-day-id="' . $day_id . '">'
                        . '<span class="signup_day_label" id="day_' . $day_id . '_label">' . events_day_label($day) . '</span>'
                        . events_signup_choices('day_role[' . $day_id . ']', $choices, $current, 'day_' . $day_id, 'day_role_radio')
                        . '</div>';
        }

        $rsvp_body .= '</div>' . events_signup_days_script();
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

<?php
/**
 * MyBB Event Plugin - Create and edit an event from the front end
 *
 * Coordinators run events but are not administrators, so requiring the Admin CP to create
 * one meant every event had to go through somebody with board admin rights. This is the
 * same form as the Admin CP module's, rendered in the board's own furniture and gated on
 * the plugin's own coordinator check rather than on MyBB's `cancp`.
 *
 * Reading, validating and writing the event all live in events_form.php so the two forms
 * cannot drift apart; this page only decides who may open it and renders the controls.
 *
 * With no id it creates; with one it edits. Deleting an event stays in the Admin CP.
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "manage_event.php");

// codebuttons is MyBB's own: build_mycode_inserter() renders it for the description box.
$templatelist = "events_event_form,codebuttons";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_form.php";

if(!$mybb->user['uid'])
{
    error_no_permission();
}

$event_id = $mybb->get_input('id', MyBB::INPUT_INT);
$is_edit = $event_id > 0;
$event = array();

if($is_edit)
{
    $event = events_get_event($event_id);

    if(!$event)
    {
        error("Event not found.");
    }

    // events_is_event_gec() is true for the event's own coordinator and for every general
    // coordinator, which is the same gate the Admin CP module applies.
    if(!events_is_event_gec($event_id))
    {
        error_no_permission();
    }
}
elseif(!events_is_gec())
{
    error_no_permission();
}

$errors = array();
$values = events_event_form_values($event);
$manage_preview = '';

if($mybb->request_method === 'post')
{
    verify_post_check($mybb->get_input('my_post_key'));

    $values = events_event_form_input();

    // Preview posts the form and comes straight back with it, the way MyBB's own Preview
    // Post does. Nothing is validated, because nothing is being saved and a form half
    // filled in is the normal state to preview a description from - reporting a missing
    // start date to somebody checking their formatting answers a question they did not ask.
    if(events_is_description_preview())
    {
        $manage_preview = events_description_preview($values['description']);
    }
    else
    {
        $errors = events_validate_event_input($values, $event);

        if(empty($errors))
        {
            $thread_error = null;
            $saved_id = events_save_event($is_edit ? $event_id : 0, $values, $mybb->user['uid'], $thread_error);

            // The event is saved either way; a thread that could not be written is
            // reported rather than swallowed, because nothing else on the page would
            // show it.
            $message = $is_edit ? "The event has been updated." : "The event has been created.";
            if($thread_error !== null)
            {
                $message .= " " . $thread_error;
            }

            redirect("event.php?id=" . $saved_id, $message);
        }
    }
}

$manage_mode = $is_edit ? 'edit' : 'create';
$manage_page_title = $is_edit ? 'Edit Event: ' . htmlspecialchars_uni($event['title']) : 'Create Event';
$manage_submit_label = $is_edit ? 'Save Changes' : 'Create Event';
$manage_cancel_url = $is_edit ? 'event.php?id=' . $event_id : 'events.php';

add_breadcrumb("Events", "events.php");
if($is_edit)
{
    add_breadcrumb($event['title'], "event.php?id=" . $event_id);
    add_breadcrumb("Edit Event", "manage_event.php?id=" . $event_id);
}
else
{
    add_breadcrumb("Create Event", "manage_event.php");
}

$manage_errors = events_form_errors($errors, 'manage_event_errors');

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------
// The event's stored coordinator rather than the posted one: a forged uid that failed
// validation should not earn itself a place on the list when the form comes back.
$coordinators = events_coordinator_choices(array(
    $mybb->user['uid'],
    isset($event['gec_user_id']) ? $event['gec_user_id'] : 0,
));

$manage_details = events_form_field(
    'event_form_title',
    'Title',
    events_form_text('title', 'event_form_title', $values['title'], array('required' => 'required', 'maxlength' => 255)),
    '',
    true
);

// The editor markup goes inside the field, right after the box it binds to, which is
// where MyBB puts {$codebuttons} in its own posting templates.
$manage_details .= events_form_field(
    'event_form_description',
    'Description',
    '<textarea class="events_input" name="description" id="event_form_description" rows="8"'
        . ' aria-describedby="hint_event_form_description">' . htmlspecialchars_uni((string)$values['description']) . '</textarea>'
        . events_description_editor('event_form_description'),
    'Shown on the event page and in the announcement thread. BBCode and smilies work here'
        . ' the same way they do in a post.'
);

$manage_details .= events_form_field(
    'event_form_status',
    'Status',
    events_form_select('status', 'event_form_status', events_event_statuses(), $values['status'], true),
    'Pending events are only visible to coordinators. Setting an event live posts its announcement thread and opens signups.',
    true
);

$manage_details .= events_form_field(
    'event_form_region',
    'Region',
    events_form_select('region', 'event_form_region', array_combine(events_regions(), events_regions()), $values['region'], true),
    'Used by the region filter on the events listing.',
    true
);

$manage_details .= events_form_field(
    'event_form_address',
    'Address',
    events_form_text('address', 'event_form_address', $values['address'], array('maxlength' => 255), true),
    'Optional. Where the event happens - shown as a Google Maps link on the event page, the'
        . ' events listing and the announcement thread.'
);

$manage_details .= events_form_field(
    'event_form_start_date',
    'Start Date',
    events_datetime_field('start_date', 'event_form_start_date', $values['start_date'], array(
        'required' => true, 'described' => true, 'label' => 'Start',
    )),
    'When the event itself begins. Pick a date from the calendar, or type it as YYYY-MM-DD.',
    true
);

$manage_details .= events_form_field(
    'event_form_end_date',
    'End Date',
    events_datetime_field('end_date', 'event_form_end_date', $values['end_date'], array(
        'required' => true, 'described' => true, 'label' => 'End',
    )),
    'When it finishes. Signups close here when no cutoff is set below.',
    true
);

$manage_details .= events_form_field(
    'event_form_signup_cutoff',
    'Signup Cutoff',
    events_datetime_field('signup_cutoff', 'event_form_signup_cutoff', $values['signup_cutoff'], array(
        'described' => true, 'label' => 'Signup cutoff',
    )),
    'Optional. Signups close at this time; leave it blank to keep them open until the event ends.'
);

$manage_details .= '<div class="events_field">'
    . '<span class="events_label">Requirements</span>'
    . '<div class="events_options">'
    . '<label class="events_option"><input type="checkbox" name="requires_wwcc" id="event_form_requires_wwcc" value="1"'
    . (!empty($values['requires_wwcc']) ? ' checked="checked"' : '') . ' /> '
    . 'Attendees must have a WWCC number on file</label>'
    . '</div></div>';

$manage_details .= events_form_field(
    'event_form_gec_user_id',
    'Coordinator',
    events_form_select('gec_user_id', 'event_form_gec_user_id', $coordinators, $values['gec_user_id'], true),
    'The member who manages this event.',
    true
);

$manage_details .= events_form_field(
    'event_form_poc_user_id',
    'Point of Contact',
    events_form_select('poc_user_id', 'event_form_poc_user_id', events_poc_options($event), $values['poc_user_id'], true),
    'Optional. Who attendees should contact about the event - yourself, or anybody signed up to it.'
        . ' Shown on the event page.'
);

// ---------------------------------------------------------------------------
// Event days
//
// One row per day the event covers, worked out from its start and end dates rather than
// typed - so the grid cannot disagree with the dates above it. A single-day event has no
// days to split up, so the whole section stays out of the way; the plugin already reads an
// event with no day rows as a one-day event.
//
// The rows are drawn from $values, so a failed submit keeps the times just entered.
// ---------------------------------------------------------------------------
$days_grid = events_event_days_grid($values, array(
    'container_id' => 'event_form_days',
    'start_input'  => 'event_form_start_date',
    'end_input'    => 'event_form_end_date',
    'id_prefix'    => 'event_form_day_',
));

// The section is two template rows - its heading and its body - so it is built here as
// markup rather than as a variable dropped into a fixed pair of rows: MyBB templates have
// no conditionals, and there is nothing to show for a single-day event.
$days_hidden = $days_grid['rows'] ? '' : ' style="display: none;"';
$manage_days = '<tr data-events-day-section="1"' . $days_hidden . '><td class="tcat"><strong>Event Days</strong></td></tr>'
    . '<tr data-events-day-section="1"' . $days_hidden . '><td class="trow2">'
    . '<p class="events_hint" id="event_form_days_hint">A row for each day between the start and end dates above.'
    . ' Times default to the whole day.</p>'
    . $days_grid['html']
    . '</td></tr>';

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------
$manage_exclusions = events_form_field(
    'event_form_exclusions',
    'Usernames',
    events_exclusions_field($values['exclusions'], array(
        'id'         => 'event_form_exclusions',
        'search_url' => 'xmlhttp.php?action=get_users&search_type=2',
        'described'  => true,
    )),
    'Start typing a username and pick from the list. These members can see the event but cannot sign up.'
);

// The calendar's stylesheet and library, and the tag field's and the preview's
// stylesheets, loaded relative to the web root this page is served from. events.css
// cannot carry any of them: it is installed as a theme stylesheet, and the Admin CP form
// has neither the theme nor a stylesheet of its own, but needs the same controls to look
// the same way. The editor brings its own - see events_description_editor().
$manage_assets = events_datepicker_assets('jscripts/events/')
               . events_tag_field_assets('jscripts/events/')
               . events_preview_assets('jscripts/events/');

$manage_days_script = events_datepicker_script() . events_event_days_script() . events_tag_field_script();

$events_print_header = events_print_header($is_edit ? $event['title'] : 'Create Event', array(), $is_edit ? 'Event Settings' : '');

eval("\$page = \"" . $templates->get("events_event_form") . "\";");
output_page($page);

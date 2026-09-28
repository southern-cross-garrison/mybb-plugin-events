<?php
/**
 * MyBB Event Plugin - Troop report drafting and posting
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "troop_report.php");

// codebuttons is MyBB's own: build_mycode_inserter() renders it for the report box.
$templatelist = "events_troop_report,codebuttons";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
// events_description_editor() lives here; the report is BBCode written into the same
// editor an ordinary post is.
require_once MYBB_ROOT . "inc/plugins/events/inc/events_form.php";
// Posting the report and drafting it.
require_once MYBB_ROOT . "inc/plugins/events/inc/events_troop_report.php";

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

// A member excluded from an event cannot write its report: this form is built from the
// event, and the event is not one they can see. (Excluding a member also withdraws any
// signup they held, so they are not on its attendance list either.) Reading the report once it is posted is another matter - it is
// an ordinary thread in the troop report forum and is left alone.
if(!events_can_view_event($event))
{
    error_no_permission();
}

if(!events_has_ended($event))
{
    error("This event has not ended yet.");
}

if(!events_has_rsvped($event_id, null, 'trooper'))
{
    error("You must have attended this event as a trooper to write its troop report.");
}

$report = events_get_troop_report($event_id);
if($report && !empty($report['posted_at']))
{
    events_troop_report_posted_error($report);
}

$event_title = htmlspecialchars_uni($event['title']);

add_breadcrumb("Events", "events.php");
add_breadcrumb(htmlspecialchars_uni($event['title']), "event.php?id=" . $event_id);
add_breadcrumb("Troop Report", "troop_report.php?id=" . $event_id);

// ---------------------------------------------------------------------------
// Post the report
// ---------------------------------------------------------------------------
if($mybb->request_method === 'post' && $mybb->get_input('action') === 'post')
{
    verify_post_check($mybb->get_input('my_post_key'));

    $thread_id = events_post_troop_report($event, $mybb->user, $mybb->get_input('report_content'), $post_error);
    if(!$thread_id)
    {
        // Somebody else's submit - or this member's own second click - got there first.
        $report = events_get_troop_report($event_id);
        if($report && !empty($report['posted_at']))
        {
            events_troop_report_posted_error($report);
        }

        error($post_error);
    }

    redirect("showthread.php?tid=" . $thread_id, "Troop report posted successfully.");
}

/**
 * Stop: this event's report is already posted. Links to it where its thread still
 * exists, since whoever lands here was about to write the same report.
 *
 * @param array $report
 * @return void
 */
function events_troop_report_posted_error(array $report)
{
    $message = "A troop report has already been posted for this event.";

    $thread = !empty($report['thread_id']) ? get_thread((int)$report['thread_id']) : null;
    if($thread)
    {
        $message .= ' <a href="' . get_thread_link((int)$thread['tid']) . '" id="troop_report_existing">View the troop report</a>.';
    }

    error($message);
}

// ---------------------------------------------------------------------------
// Build the draft
// ---------------------------------------------------------------------------
$draft_content = events_troop_report_draft($event);

// Deliberately not htmlspecialchars_uni(): that preserves &#91;, which the browser would
// decode back to "[" as the textarea's value and undo the draft's events_escape_bbcode().
$draft_content = htmlspecialchars($draft_content, ENT_QUOTES, 'UTF-8');

// The editor markup goes after the box it binds to, which is where MyBB puts
// {$codebuttons} in its own posting templates. Empty when the board has the BBCode
// inserter off or the member has turned it off in their options, which leaves the plain
// textarea the form has always posted - the report is BBCode either way.
$report_editor = events_description_editor('troop_report_content');

$events_print_header = events_print_header('Troop Report', array($event['title']));

eval("\$page = \"" . $templates->get("events_troop_report") . "\";");
output_page($page);

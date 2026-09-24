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
$troopers = events_get_attendees($event_id, array('role' => 'trooper'));
$wranglers = events_get_attendees($event_id, array('role' => 'wrangler'));

add_breadcrumb("Events", "events.php");
add_breadcrumb(htmlspecialchars_uni($event['title']), "event.php?id=" . $event_id);
add_breadcrumb("Troop Report", "troop_report.php?id=" . $event_id);

// ---------------------------------------------------------------------------
// Post the report
// ---------------------------------------------------------------------------
if($mybb->request_method === 'post' && $mybb->get_input('action') === 'post')
{
    verify_post_check($mybb->get_input('my_post_key'));

    $forum_id = (int)events_get_setting('troop_report_forum');
    if(!$forum_id)
    {
        error("No troop report forum has been configured. Ask an administrator to set one in Admin CP -> Event Management -> Settings.");
    }

    // A double-clicked submit is two of these at once, and both passed the posted_at
    // check above before either had written anything - which filed two reports. The
    // lock makes the second wait for the first, and the report is re-read once it is
    // held, so the second finds the report the first posted and is pointed at it.
    // Released when the request ends, error() included.
    if(!events_acquire_lock('troop_report:' . $event_id))
    {
        error("This troop report is still being posted. Please try again in a moment.");
    }

    $report = events_get_troop_report($event_id);
    if($report && !empty($report['posted_at']))
    {
        events_troop_report_posted_error($report);
    }

    require_once MYBB_ROOT . "inc/datahandlers/post.php";

    $posthandler = new PostDataHandler("insert");
    $posthandler->action = "thread";
    $posthandler->set_data(array(
        'fid'       => $forum_id,
        'subject'   => "Troop Report: " . $event['title'],
        'message'   => $mybb->get_input('report_content'),
        'uid'       => (int)$mybb->user['uid'],
        'username'  => $mybb->user['username'],
        'ipaddress' => get_ip(),
        'dateline'  => TIME_NOW,
        'savedraft' => 0,
        'options'   => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
    ));

    if(!$posthandler->validate_thread())
    {
        error(implode("<br />", $posthandler->get_friendly_errors()));
    }

    $thread = $posthandler->insert_thread();
    $thread_id = (int)$thread['tid'];

    $now = events_date('Y-m-d H:i:s');
    if($report)
    {
        $db->update_query("event_plugin_troop_reports", array(
            'thread_id'  => $thread_id,
            'created_by' => (int)$mybb->user['uid'],
            'posted_at'  => $db->escape_string($now),
        ), "id = " . (int)$report['id']);
    }
    else
    {
        $db->insert_query("event_plugin_troop_reports", array(
            'event_id'   => $event_id,
            'thread_id'  => $thread_id,
            'created_by' => (int)$mybb->user['uid'],
            'created_at' => $db->escape_string($now),
            'posted_at'  => $db->escape_string($now),
        ));
    }

    // Leave a pointer on the event's discussion thread, if it has one.
    if(!empty($event['thread_id']))
    {
        $replyhandler = new PostDataHandler("insert");
        $replyhandler->action = "post";
        $replyhandler->set_data(array(
            'tid'       => (int)$event['thread_id'],
            'message'   => "Troop report has been posted: [url=" . $mybb->settings['bburl'] . "/showthread.php?tid=" . $thread_id . "]View Troop Report[/url]",
            'uid'       => (int)$mybb->user['uid'],
            'username'  => $mybb->user['username'],
            'ipaddress' => get_ip(),
            'dateline'  => TIME_NOW,
            'savedraft' => 0,
            'options'   => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
        ));

        if($replyhandler->validate_post())
        {
            $replyhandler->insert_post();
        }
    }

    // Posting the report closes the event out.
    $db->update_query("event_plugin_events", array('status' => 'archived'), "id = " . $event_id);

    events_release_lock('troop_report:' . $event_id);

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
$garrison_group = (int)events_get_setting('garrison_members_group');
$legion_group = (int)events_get_setting('501st_members_group');

$buckets = array(
    'garrison' => array('title' => 'Garrison Members', 'attendees' => array()),
    'legion'   => array('title' => 'Other 501st Members', 'attendees' => array()),
    'other'    => array('title' => 'Others', 'attendees' => array()),
);

foreach($troopers as $attendee)
{
    $groups = events_user_group_ids($attendee);

    if($garrison_group && in_array($garrison_group, $groups, true))
    {
        $buckets['garrison']['attendees'][] = $attendee;
    }
    elseif($legion_group && in_array($legion_group, $groups, true))
    {
        $buckets['legion']['attendees'][] = $attendee;
    }
    else
    {
        $buckets['other']['attendees'][] = $attendee;
    }
}

$draft_content = "[b]Event:[/b] " . events_escape_bbcode($event['title']) . "\n";
$draft_content .= "[b]Date:[/b] " . events_format_date($event['start_date']) . " - " . events_format_date($event['end_date']) . "\n";
$draft_content .= "[b]Region:[/b] " . $event['region'] . "\n\n";

foreach($buckets as $bucket)
{
    if(empty($bucket['attendees']))
    {
        continue;
    }

    // A real [list] rather than hyphens: the report is BBCode posted into a forum, so the
    // roster should come out as a list in the thread - and in the editor, which renders
    // what it is given rather than showing the markup.
    $draft_content .= "[b]" . $bucket['title'] . ":[/b]\n[list]\n";
    foreach($bucket['attendees'] as $attendee)
    {
        $line = "[*]" . events_escape_bbcode($attendee['username']);
        if($attendee['tk_id'] !== '')
        {
            $line .= " (" . events_escape_bbcode($attendee['tk_id']) . ")";
        }
        if(!empty($attendee['costumes']))
        {
            $line .= " - " . events_escape_bbcode(implode(', ', $attendee['costumes']));
        }
        $draft_content .= $line . "\n";
    }
    $draft_content .= "[/list]\n\n";
}

// Wranglers are not costumed and hold no Legion ID, so they get their own section
// rather than being folded into the membership buckets above.
if(!empty($wranglers))
{
    $draft_content .= "[b]Wranglers:[/b]\n[list]\n";
    foreach($wranglers as $wrangler)
    {
        $draft_content .= "[*]" . events_escape_bbcode($wrangler['username']) . "\n";
    }
    $draft_content .= "[/list]\n\n";
}

$draft_content .= "[b]Total attendees:[/b] " . count($troopers) . "\n";
if(!empty($wranglers))
{
    $draft_content .= "[b]Total wranglers:[/b] " . count($wranglers) . "\n";
}

// Deliberately not htmlspecialchars_uni(): that preserves &#91;, which the browser would
// decode back to "[" as the textarea's value and undo events_escape_bbcode() above.
$draft_content = htmlspecialchars($draft_content, ENT_QUOTES, 'UTF-8');

// The editor markup goes after the box it binds to, which is where MyBB puts
// {$codebuttons} in its own posting templates. Empty when the board has the BBCode
// inserter off or the member has turned it off in their options, which leaves the plain
// textarea the form has always posted - the report is BBCode either way.
$report_editor = events_description_editor('troop_report_content');

$events_print_header = events_print_header('Troop Report', array($event['title']));

eval("\$page = \"" . $templates->get("events_troop_report") . "\";");
output_page($page);

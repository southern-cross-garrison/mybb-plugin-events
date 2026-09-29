<?php
/**
 * MyBB Event Plugin - Troop reports: the generated draft and posting one.
 *
 * troop_report.php is the form; this is what it does, so the demo seed posts a report by
 * exactly the steps a member's does - attendance included.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_thread.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_attendance.php";

/**
 * Post an event's troop report: the thread in the troop report forum, the report row
 * marked posted, a pointer on the announcement thread, the event archived, and the
 * attendance the report records.
 *
 * A double-clicked submit is two of these at once, and both passed the caller's
 * posted_at check before either had written anything - which filed two reports. The lock
 * makes the second wait for the first, and the report is re-read once it is held, so the
 * second finds the report the first posted and is refused.
 *
 * @param array $event
 * @param array $author users row: uid and username
 * @param string $content BBCode
 * @param string $error Set to why nothing was posted
 * @return int The report's thread id, 0 if nothing was posted
 */
function events_post_troop_report(array $event, array $author, $content, &$error)
{
    global $db, $mybb;

    $error = '';
    $event_id = (int)$event['id'];

    if(events_is_social($event))
    {
        $error = "Social events do not have troop reports.";
        return 0;
    }

    $forum_id = (int)events_get_setting('troop_report_forum');
    if(!$forum_id)
    {
        $error = "No troop report forum has been configured. Ask an administrator to set one in Admin CP -> Event Management -> Settings.";
        return 0;
    }

    $lock = events_troop_report_lock($event_id);
    if(!events_acquire_lock($lock))
    {
        $error = "This troop report is still being posted. Please try again in a moment.";
        return 0;
    }

    $report = events_get_troop_report($event_id);
    if($report && !empty($report['posted_at']))
    {
        events_release_lock($lock);
        $error = "A troop report has already been posted for this event.";
        return 0;
    }

    require_once MYBB_ROOT . "inc/datahandlers/post.php";

    // The demo seed posts from the command line, where there is no request to take an
    // address from.
    $ip = isset($_SERVER['REMOTE_ADDR']) ? get_ip() : '127.0.0.1';

    // Past MyBB's post flood check, which is all admin_override does to a post. Without it
    // a trooper who posted anything in the last postfloodsecs is refused their report, and
    // the pointer below - always posted within the same second as the report - never is.
    $posthandler = new PostDataHandler("insert");
    $posthandler->action = "thread";
    $posthandler->admin_override = true;
    $posthandler->set_data(array(
        'fid'       => $forum_id,
        'subject'   => "Troop Report: " . $event['title'],
        'message'   => (string)$content,
        'uid'       => (int)$author['uid'],
        'username'  => $author['username'],
        'ipaddress' => $ip,
        'dateline'  => TIME_NOW,
        'savedraft' => 0,
        'options'   => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
    ));

    if(!$posthandler->validate_thread())
    {
        events_release_lock($lock);
        $error = implode("<br />", $posthandler->get_friendly_errors());
        return 0;
    }

    $thread = $posthandler->insert_thread();
    $thread_id = (int)$thread['tid'];

    $now = events_date('Y-m-d H:i:s');
    if($report)
    {
        $db->update_query("event_plugin_troop_reports", array(
            'thread_id'  => $thread_id,
            'created_by' => (int)$author['uid'],
            'posted_at'  => $db->escape_string($now),
        ), "id = " . (int)$report['id']);
    }
    else
    {
        $db->insert_query("event_plugin_troop_reports", array(
            'event_id'   => $event_id,
            'thread_id'  => $thread_id,
            'created_by' => (int)$author['uid'],
            'created_at' => $db->escape_string($now),
            'posted_at'  => $db->escape_string($now),
        ));
    }

    // Leave a pointer on the event's discussion thread, if it has one.
    if(!empty($event['thread_id']))
    {
        $replyhandler = new PostDataHandler("insert");
        $replyhandler->action = "post";
        $replyhandler->admin_override = true;
        $replyhandler->set_data(array(
            'tid'       => (int)$event['thread_id'],
            'message'   => "Troop report has been posted: [url=" . $mybb->settings['bburl'] . "/showthread.php?tid=" . $thread_id . "]View Troop Report[/url]",
            'uid'       => (int)$author['uid'],
            'username'  => $author['username'],
            'ipaddress' => $ip,
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

    // The announcement's first post is generated from the event, and guests, excluded
    // members and Tapatalk read that post rather than the card - so without this it goes
    // on reading as an open call for troopers. The report is already up, so a thread that
    // cannot be rewritten is not a reason to stop here.
    events_sync_event_thread($event_id);

    // Still under the report lock, which is the one attendance is counted under.
    events_write_troop_attendance($event_id);

    events_release_lock($lock);

    return $thread_id;
}

/**
 * The report a member is handed to fill in: the event's details and a roll call of
 * everyone attending it, grouped the way the garrison files its reports.
 *
 * Every line names the member by username, and a trooper by Legion ID as well, which is
 * what events_attendance_matches() looks for - so a report posted as drafted counts
 * everyone it lists.
 *
 * @param array $event
 * @return string BBCode
 */
function events_troop_report_draft(array $event)
{
    $event_id = (int)$event['id'];
    $troopers = events_get_attendees($event_id, array('role' => 'trooper'));
    $wranglers = events_get_attendees($event_id, array('role' => 'wrangler'));

    $garrison_group = (int)events_get_setting('garrison_members_group');
    $legion_group = (int)events_get_setting('501st_members_group');

    $buckets = array(
        'garrison' => array('title' => 'Garrison Troopers', 'attendees' => array()),
        'legion'   => array('title' => 'Other 501st Troopers', 'attendees' => array()),
        'other'    => array('title' => 'Other Troopers', 'attendees' => array()),
    );

    // Roll-call order: each line leads with the name the member goes by.
    usort($troopers, 'events_compare_by_preferred_name');
    usort($wranglers, 'events_compare_by_preferred_name');

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

    $location = trim((string)$event['address']) !== '' ? $event['address'] : $event['region'];

    $draft = "[b]Troop Report[/b]\n\n";
    $draft .= "[b]Location:[/b] " . events_escape_bbcode($location) . "\n";
    $draft .= "[b]Weather:[/b] \n";
    $draft .= "[b]Date/ Time:[/b] " . events_troop_report_when($event) . "\n\n";

    foreach($buckets as $bucket)
    {
        if(empty($bucket['attendees']))
        {
            continue;
        }

        $draft .= "[b]" . $bucket['title'] . ":[/b]\n";
        foreach($bucket['attendees'] as $attendee)
        {
            $draft .= events_troop_report_roster_line($attendee) . "\n";
        }
        $draft .= "\n";
    }

    // Wranglers are not costumed and hold no Legion ID, so they get their own section
    // rather than being folded into the membership buckets above.
    if(!empty($wranglers))
    {
        $draft .= "[b]Wranglers:[/b]\n";
        foreach($wranglers as $wrangler)
        {
            $draft .= events_troop_report_roster_line($wrangler, false) . "\n";
        }
        $draft .= "\n";
    }

    $draft .= "[b]Mission Report:[/b]\n\n\n\n";
    $draft .= "[b]Mission Status:[/b] \n\n";
    $draft .= "[b]Photos by:[/b]\nIf permission is not granted, say so... (for use by PR team)\n";

    return $draft;
}

/**
 * "Paul - roguemm - TK-25775": the name a member goes by, their username and their Legion
 * ID, leaving out whichever of the first and last they have not filled in.
 *
 * @param array $attendee from events_get_attendees()
 * @param bool $with_id
 * @return string BBCode
 */
function events_troop_report_roster_line(array $attendee, $with_id = true)
{
    $parts = array();

    if(trim($attendee['preferred_name']) !== '')
    {
        $parts[] = trim($attendee['preferred_name']);
    }

    $parts[] = $attendee['username'];

    if($with_id && trim($attendee['tk_id']) !== '')
    {
        $parts[] = trim($attendee['tk_id']);
    }

    return events_escape_bbcode(implode(' - ', $parts));
}

/**
 * "4th of October from 2pm" - when the event ran, written the way a report says it. An
 * event that ran past its first day adds the day it ended ("to 5th of October"), and the
 * year is written only when it is not the current one.
 *
 * @param array $event
 * @return string
 */
function events_troop_report_when(array $event)
{
    $start = events_strtotime($event['start_date']);
    $end = events_strtotime($event['end_date']);

    $day = function($timestamp)
    {
        $text = events_date('jS \o\f F', $timestamp);
        if(events_date('Y', $timestamp) !== events_date('Y', TIME_NOW))
        {
            $text .= ' ' . events_date('Y', $timestamp);
        }
        return $text;
    };

    $when = $day($start) . ' from ' . events_date((int)events_date('i', $start) === 0 ? 'ga' : 'g:ia', $start);

    if($end !== false && events_date('Y-m-d', $end) !== events_date('Y-m-d', $start))
    {
        $when .= ' to ' . $day($end);
    }

    return $when;
}

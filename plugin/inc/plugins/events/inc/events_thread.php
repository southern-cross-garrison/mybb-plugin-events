<?php
/**
 * MyBB Event Plugin - Event announcement threads
 *
 * Every live event gets a thread in the forums, posted by the plugin rather than chosen
 * by hand. The board's members follow the forums, not the events listing, so an event
 * that is not announced is an event most of them never hear about - and leaving the
 * announcement to whoever created the event produced threads that each said something
 * different and went stale the moment a date moved.
 *
 * The thread is therefore generated from the event row and regenerated whenever the
 * event is saved, so the post is always what the event currently says. `thread_id` on
 * the event is the link between the two; it is no longer something a coordinator picks.
 *
 * Which forum an event is announced in depends on its region: a garrison spread across
 * several states runs a forum per region, and a Hunter event posted into the Sydney
 * forum is noise to everyone reading it. events_event_forum_id() resolves a region to a
 * forum, falling back to the board-wide default when a region has no forum of its own.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

/**
 * The configured region => forum id map.
 *
 * Stored as one setting ("Sydney=2,Hunter=5") rather than one setting per region,
 * because the region list is the board's to edit and a region added in the Admin CP
 * cannot bring a matching setting row with it. Regions that are not on the current list
 * are kept on parse rather than dropped: the settings form is what prunes them, and it
 * does that deliberately, having first moved that region's events somewhere else.
 *
 * @return array region => int forum id
 */
function events_region_forums()
{
    $forums = array();

    foreach(explode(',', (string)events_get_setting('event_forums')) as $pair)
    {
        $pair = trim($pair);
        if($pair === '' || strpos($pair, '=') === false)
        {
            continue;
        }

        list($region, $forum_id) = explode('=', $pair, 2);
        $region = trim($region);
        $forum_id = (int)trim($forum_id);

        if($region !== '' && $forum_id > 0)
        {
            $forums[$region] = $forum_id;
        }
    }

    return $forums;
}

/**
 * Turn a region => forum id map back into the setting's stored form.
 *
 * @param array $forums region => forum id
 * @return string
 */
function events_build_region_forums_setting(array $forums)
{
    $pairs = array();

    foreach($forums as $region => $forum_id)
    {
        // The value is a comma separated list of name=id pairs, so a region carrying
        // either character would corrupt the ones after it.
        $region = trim(str_replace(array(',', '='), '', (string)$region));
        $forum_id = (int)$forum_id;

        if($region !== '' && $forum_id > 0)
        {
            $pairs[] = $region . '=' . $forum_id;
        }
    }

    return implode(',', $pairs);
}

/**
 * The forum an event in this region is announced in.
 *
 * @param string $region
 * @return int forum id, 0 when nothing is configured
 */
function events_event_forum_id($region)
{
    $forums = events_region_forums();

    if(isset($forums[$region]))
    {
        return (int)$forums[$region];
    }

    return (int)events_get_setting('event_forum');
}

/**
 * Every forum the plugin announces events into.
 *
 * Used to tell a thread that is still where the plugin put it from one a moderator has
 * since filed somewhere of their own choosing.
 *
 * @return array of int forum id
 */
function events_announcement_forum_ids()
{
    $ids = array_map('intval', array_values(events_region_forums()));

    $default = (int)events_get_setting('event_forum');
    if($default)
    {
        $ids[] = $default;
    }

    return array_values(array_unique(array_filter($ids)));
}

/**
 * The BBCode body of an event's announcement post.
 *
 * The values the plugin interpolates - the region, the address, the coordinator's name -
 * go through events_escape_bbcode(): none of them is markup anybody wrote on purpose, and
 * a username containing "[/b]" would otherwise rewrite the rest of the post.
 *
 * The description is the exception, and deliberately so. It is written in the board's own
 * editor, in the board's own BBCode, and rendered as BBCode on the event page - so it is
 * carried into the announcement as written. That is the same trust a coordinator already
 * has when they post the thread by hand, and neutralising it here would mean a
 * description that reads one way on the event page and another in the thread.
 *
 * @param array $event Event row
 * @return string
 */
function events_event_post_content(array $event)
{
    global $mybb;

    $event_id = (int)$event['id'];
    $coordinator = events_get_user($event['gec_user_id']);

    // An announcement only ever goes up for a live event, but the event can be pulled or
    // closed out afterwards and the thread stays. Saying so at the top beats a thread that
    // still reads as an open call for troopers.
    $content = '';
    if($event['status'] === 'archived')
    {
        $content .= "[b]This event is over and signups are closed.[/b]\n\n";
    }
    elseif($event['status'] !== 'live')
    {
        $content .= "[b]This event has been taken off the schedule and is not open for signups.[/b]\n\n";
    }

    $content .= "[b]When:[/b] " . events_format_date($event['start_date']);
    $end = events_format_date($event['end_date']);
    if($end !== '')
    {
        $content .= " to " . $end;
    }
    $content .= "\n";

    // The region links back to the listing filtered to it: the reader of a Canberra
    // thread is the reader most likely to want the rest of the Canberra schedule.
    $content .= "[b]Region:[/b] [url=" . $mybb->settings['bburl'] . "/events.php?region="
              . urlencode($event['region']) . "]" . events_escape_bbcode($event['region']) . "[/url]\n";

    // The address is a link to the map rather than a line of text to copy out: the thread
    // is what most members read the event from, and "where is it" is the question they are
    // most likely to be asking their phone. The label is neutralised like everything else
    // here - the url= half is the encoded URL, so it carries no brackets of its own.
    $address = isset($event['address']) ? trim((string)$event['address']) : '';
    if($address !== '')
    {
        $content .= "[b]Where:[/b] [url=" . events_map_url($address) . "]"
                  . events_escape_bbcode($address) . "[/url]\n";
    }

    if(!empty($coordinator['username']))
    {
        $content .= "[b]Coordinator:[/b] " . events_escape_bbcode($coordinator['username']) . "\n";
    }

    $cutoff = events_format_date($event['signup_cutoff']);
    if($cutoff !== '')
    {
        $content .= "[b]Signups close:[/b] " . $cutoff . "\n";
    }

    // The maximums are part of what the event is: a reader deciding whether to bother
    // signing up wants to know there are only ten places.
    $capacity = events_capacity_text($event, !empty(events_get_event_days($event_id)));
    if($capacity !== '')
    {
        $content .= "[b]Places:[/b] " . $capacity . "\n";
    }

    if(!empty($event['requires_wwcc']))
    {
        $content .= "[b]Requirement:[/b] attendees must have a current WWCC number on file.\n";
    }

    // Days are what splits a multi-day event up for signups, so they are worth spelling
    // out. A single-day event has none, and the When line above already says it all.
    $days = events_get_event_days($event_id);
    if(!empty($days))
    {
        $content .= "\n[b]Schedule:[/b]\n[list]\n";
        foreach($days as $day)
        {
            $content .= "[*]" . events_format_date($day['date'], $mybb->settings['dateformat'])
                      . ": " . events_format_date($day['date'] . ' ' . $day['start_time'], $mybb->settings['timeformat'])
                      . " - " . events_format_date($day['date'] . ' ' . $day['end_time'], $mybb->settings['timeformat'])
                      . "\n";
        }
        $content .= "[/list]\n";
    }

    // The description as written, BBCode and all.
    $description = trim((string)$event['description']);
    if($description !== '')
    {
        $content .= "\n" . $description . "\n";
    }

    $content .= "\n[url=" . $mybb->settings['bburl'] . "/event.php?id=" . $event_id . "]"
              . "View this event and sign up[/url]\n";

    return $content;
}

/**
 * Create or refresh an event's announcement thread.
 *
 * Called from events_save_event() and from anything else that changes an event's status,
 * so the post follows the event rather than only its creation.
 *
 * Pending events are deliberately not announced: they are only visible to coordinators,
 * so a thread would link members to a page they cannot open. The announcement appears
 * when the event goes live. An event that already has a thread keeps it - including when
 * it is archived, where deleting or hiding the thread would take the discussion with it.
 *
 * @param int $event_id
 * @param string|null $error Set to why nothing was posted, for a caller that can say so
 * @param array $former_forum_ids Forums the plugin announced into until the change that
 *        prompted this sync. Deleting a region takes its forum out of the region map, so
 *        a thread still sitting there would otherwise read as one a moderator filed by
 *        hand and never follow its event to the region it was moved to.
 * @return int the thread id, or 0 when the event has no thread
 */
function events_sync_event_thread($event_id, &$error = null, array $former_forum_ids = array())
{
    global $db, $mybb, $lang;

    $error = null;

    $event = events_get_event($event_id);
    if(!$event)
    {
        return 0;
    }

    $thread = null;
    if((int)$event['thread_id'] > 0)
    {
        // A thread that has since been deleted leaves the event pointing at nothing. The
        // event is re-announced rather than left silently unannounced, which is also what
        // makes deleting the thread the way to force a fresh one.
        $thread = $db->fetch_array($db->simple_select("threads", "tid, fid, firstpost", "tid = " . (int)$event['thread_id']));
        if(!$thread)
        {
            $db->write_query("UPDATE " . TABLE_PREFIX . "event_plugin_events SET thread_id = NULL WHERE id = " . (int)$event['id']);
            $event['thread_id'] = null;
        }
    }

    if(!$thread && $event['status'] !== 'live')
    {
        return 0;
    }

    require_once MYBB_ROOT . "inc/datahandlers/post.php";

    $content = events_event_post_content($event);

    if($thread)
    {
        $post = $db->fetch_array($db->simple_select("posts", "pid, uid", "pid = " . (int)$thread['firstpost']));
        if(!$post)
        {
            $error = "The event's announcement thread has no first post to update.";
            return (int)$thread['tid'];
        }

        // A region corrected after the fact should take the announcement with it -
        // leaving it where it was is exactly the cross-region noise a forum per region
        // exists to avoid. But only while the thread is still in a forum the plugin
        // announces into: a moderator who filed it somewhere else meant it, and dragging
        // a discussion back out of the forum it has been living in is not a correction.
        // "move" rather than MyBB's default "redirect": a redirect leaves a "Moved:" stub
        // behind in the old forum, and nothing about that stub marks it as the event's
        // thread, so the exclusion hooks would show its title to excluded members.
        $forum_id = events_event_forum_id($event['region']);
        $managed = array_merge(events_announcement_forum_ids(), array_map('intval', $former_forum_ids));
        if($forum_id && (int)$thread['fid'] !== $forum_id && in_array((int)$thread['fid'], $managed, true))
        {
            require_once MYBB_ROOT . "inc/class_moderation.php";

            $moderation = new Moderation;
            $moderation->move_thread((int)$thread['tid'], $forum_id, "move");
        }

        $handler = new PostDataHandler("update");
        $handler->admin_override = true;
        $handler->set_data(array(
            'pid'      => (int)$post['pid'],
            'uid'      => (int)$post['uid'],
            'subject'  => $event['title'],
            'message'  => $content,
            'edit_uid' => (int)$mybb->user['uid'],
        ));

        if(!$handler->validate_post())
        {
            $error = implode(' ', $handler->get_friendly_errors());
            return (int)$thread['tid'];
        }

        $handler->update_post();

        return (int)$thread['tid'];
    }

    $forum_id = events_event_forum_id($event['region']);
    if(!$forum_id)
    {
        $error = "No forum is configured for " . htmlspecialchars_uni($event['region']) . " events, so nothing was posted."
               . " An administrator can set one in Admin CP -> Event Management -> Settings.";
        return 0;
    }

    // The coordinator owns the event, so the announcement is posted as them rather than
    // as whichever admin happened to save it.
    $author = events_get_user($event['gec_user_id']);
    if(empty($author['uid']))
    {
        $author = $mybb->user;
    }

    $handler = new PostDataHandler("insert");
    $handler->action = "thread";
    // The post is generated, not typed: holding it back because the coordinator posted a
    // minute ago would only lose the announcement.
    $handler->admin_override = true;
    $handler->set_data(array(
        'fid'       => $forum_id,
        'subject'   => $event['title'],
        'message'   => $content,
        'uid'       => (int)$author['uid'],
        'username'  => $author['username'],
        'ipaddress' => get_ip(),
        'dateline'  => TIME_NOW,
        'savedraft' => 0,
        'options'   => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
    ));

    if(!$handler->validate_thread())
    {
        $error = implode(' ', $handler->get_friendly_errors());
        return 0;
    }

    // insert_thread() mails everybody subscribed to the forum the new thread's subject and
    // an excerpt of its first post, and offers no hook inside that loop - so the mail it
    // queued for members the event is hidden from is taken back out of the queue after it.
    // The queue is only ever sent by the mail queue task, never by the request that filled
    // it, so nothing has gone out yet.
    $queued_before = (int)$db->fetch_field($db->simple_select("mailqueue", "MAX(mid) AS mid"), "mid");

    // That notice is worded from the front end's messages language file, which global.php
    // loads on every page and the Admin CP never does - so an event announced from the
    // Admin CP queued every subscriber an email with an empty body. It is loaded for the
    // insert, and anything it overwrote put back straight after, since the Admin CP's own
    // strings can share its keys.
    $lang_before = null;
    if(empty($lang->email_forumsubscription))
    {
        $lang_before = get_object_vars($lang);
        $lang->load('messages', true, true);
    }

    $thread = $handler->insert_thread();

    if($lang_before !== null)
    {
        foreach(array_keys(get_object_vars($lang)) as $key)
        {
            if(array_key_exists($key, $lang_before))
            {
                $lang->$key = $lang_before[$key];
            }
            else
            {
                unset($lang->$key);
            }
        }
    }
    $thread_id = (int)$thread['tid'];

    $db->update_query("event_plugin_events", array('thread_id' => $thread_id), "id = " . (int)$event['id']);

    events_unqueue_hidden_forum_notices($event['id'], $queued_before);

    return $thread_id;
}

/**
 * Take the new-thread notices an announcement queued for the members it is hidden from
 * back out of the mail queue.
 *
 * @param int $event_id
 * @param int $queued_before The newest mail queue id before the thread was posted
 * @return void
 */
function events_unqueue_hidden_forum_notices($event_id, $queued_before)
{
    global $db, $cache;

    $uids = events_event_hidden_uids($event_id);
    if(empty($uids))
    {
        return;
    }

    $emails = array();
    $query = $db->simple_select("users", "email", "uid IN (" . implode(',', $uids) . ") AND email != ''");
    while($row = $db->fetch_array($query))
    {
        $emails[] = "'" . $db->escape_string($row['email']) . "'";
    }

    if(empty($emails))
    {
        return;
    }

    $db->delete_query("mailqueue", "mid > " . (int)$queued_before . " AND mailto IN (" . implode(',', $emails) . ")");
    $cache->update_mailqueue();
}

/**
 * Unsubscribe the members an event is hidden from from its announcement thread.
 *
 * A subscription made before the exclusion would otherwise go on emailing or PMing them
 * the subject and an excerpt of every reply, and list the thread in their User CP - where
 * the link to unsubscribe names the thread, so events_block_hidden_thread() refuses it
 * and they could not get rid of it themselves. They cannot subscribe again: that link
 * names the thread too.
 *
 * @param int $event_id
 * @return void
 */
function events_drop_hidden_thread_subscriptions($event_id)
{
    global $db;

    $event = events_get_event($event_id);
    if(!$event || (int)$event['thread_id'] <= 0)
    {
        return;
    }

    $uids = events_event_hidden_uids($event_id);
    if(empty($uids))
    {
        return;
    }

    $db->delete_query("threadsubscriptions", "tid = " . (int)$event['thread_id'] . " AND uid IN (" . implode(',', $uids) . ")");
}

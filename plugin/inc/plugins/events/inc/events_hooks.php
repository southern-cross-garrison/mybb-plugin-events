<?php
/**
 * MyBB Event Plugin - Hooks
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Register the plugin's front-end hooks.
 *
 * Called from inc/plugins/events.php on every request (MyBB includes active plugin
 * files on each page load); registering inside _activate() would only ever run once.
 */
function events_register_hooks()
{
    global $plugins;

    global $templatelist;

    $plugins->add_hook("pre_output_page", "events_nav_menu");

    // An event is read in its announcement thread, with the event card standing in for the
    // thread's first post - see events_thread_postbit().
    $plugins->add_hook("showthread_start", "events_thread_display");
    $plugins->add_hook("postbit", "events_thread_postbit");
    $plugins->add_hook("showthread_linear", "events_restore_postbit_templates");
    $plugins->add_hook("showthread_threaded", "events_restore_postbit_templates");

    // This runs while global.php is including plugins, which is before it caches the
    // page's templates - so the card's templates can join showthread's own batch rather
    // than costing a query each on every event thread.
    if(defined('THIS_SCRIPT') && THIS_SCRIPT === 'showthread.php' && isset($templatelist))
    {
        $templatelist .= ',events_postbit,events_event_card,events_rsvp_list';
    }

    // Opening an event thread from a listing goes to the top of it, where the event is,
    // rather than to the first unread reply. Priority 20 so it runs after Smart Thread
    // Link, whose value it overrides.
    $plugins->add_hook("forumdisplay_thread_end", "events_thread_link_to_start", 20);
    $plugins->add_hook("search_results_thread", "events_thread_link_to_start", 20);
    $plugins->add_hook("usercp_thread_subscriptions_thread", "events_thread_link_to_start", 20);
    $plugins->add_hook("usercp_latest_threads_thread", "events_thread_link_to_start", 20);

    // Keeping an event's announcement thread away from a member excluded from that event.
    // MyBB has no per-thread permission, so there is no single place to say "not for you"
    // - every surface that can name a thread has to be told separately. See
    // events_hidden_thread_ids() for what is hidden and why the troop report is not.
    $plugins->add_hook("global_intermediate", "events_block_hidden_thread");
    $plugins->add_hook("xmlhttp", "events_block_hidden_thread");
    $plugins->add_hook("archive_start", "events_block_hidden_thread");
    $plugins->add_hook("forumdisplay_get_threads", "events_hide_threads_in_forum");
    $plugins->add_hook("build_forumbits_forum", "events_hide_thread_in_forumbit");
    $plugins->add_hook("search_do_search_process", "events_hide_threads_in_search");
    $plugins->add_hook("search_results_start", "events_hide_threads_in_saved_search");
    $plugins->add_hook("syndication_get_posts", "events_hide_threads_in_feed");
}

/**
 * The threads this request's member may not read, or an empty list.
 *
 * Every hook below opens with this, so it is written to cost nothing for the member it
 * does not apply to: guests hold no exclusions, and for everybody else the lookup is one
 * query for the whole request.
 *
 * @return array of int thread id
 */
function events_request_hidden_threads()
{
    global $mybb;

    if(empty($mybb->user['uid']))
    {
        return array();
    }

    // Only events_hooks.php is loaded on every request (see inc/plugins/events.php), so
    // the helper has to be pulled in here rather than assumed.
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    return events_hidden_thread_ids();
}

/**
 * Turn away any request that names a hidden announcement thread.
 *
 * One gate for every page that renders a thread or one of its posts, rather than a hook
 * per script: showthread, printthread, newreply, editpost, showpost, sendthread,
 * ratethread, polls, report, moderation and attachment all identify their thread the same
 * three ways, and a page added by a later MyBB is covered the day it ships.
 *
 * Hooks: global_intermediate (every board page, once the theme is up and error_no_permission()
 * can render), xmlhttp and archive_start (neither of which loads global.php's furniture).
 */
function events_block_hidden_thread()
{
    global $mybb, $db, $lang;

    // Read first: most page views carry none of these, and this runs on all of them.
    $thread_id = $mybb->get_input('tid', MyBB::INPUT_INT);
    $post_id = $mybb->get_input('pid', MyBB::INPUT_INT);
    $attachment_id = $mybb->get_input('aid', MyBB::INPUT_INT);

    // The archive names its thread in the URL *path* - archive/index.php?thread-12.html -
    // and archive/global.php parses that into its own $action and $id before archive_start
    // runs. Nothing ever reaches $mybb->input, so reading tid the way every other entry
    // point is read finds nothing and this hook waves the request through: registering it
    // on archive_start is not enough on its own. $id is a fid when the action is 'forum',
    // so the action has to be checked with it.
    if(defined('IN_ARCHIVE') && $thread_id <= 0)
    {
        global $action, $id;

        if(isset($action) && $action === 'thread')
        {
            $thread_id = (int)$id;
        }
    }

    if($thread_id <= 0 && $post_id <= 0 && $attachment_id <= 0)
    {
        return;
    }

    $hidden = events_request_hidden_threads();
    if(empty($hidden))
    {
        return;
    }

    // A post or an attachment names a thread as surely as a tid does, and a thread handed
    // back one post at a time is not hidden.
    if($thread_id <= 0 && $attachment_id > 0)
    {
        $attachment = $db->fetch_array($db->simple_select("attachments", "pid", "aid = " . $attachment_id));
        if(!empty($attachment['pid']))
        {
            $post_id = (int)$attachment['pid'];
        }
    }

    if($thread_id <= 0 && $post_id > 0)
    {
        $post = $db->fetch_array($db->simple_select("posts", "tid", "pid = " . $post_id));
        $thread_id = empty($post['tid']) ? 0 : (int)$post['tid'];
    }

    if($thread_id <= 0 || !in_array($thread_id, $hidden, true))
    {
        return;
    }

    // Each entry point says no its own way. The archive renders its own furniture, and
    // xmlhttp.php answers JSON having loaded no theme at all, so neither can be handed
    // the board's error page.
    if(defined('IN_ARCHIVE'))
    {
        archive_error_no_permission();
    }

    if(defined('THIS_SCRIPT') && THIS_SCRIPT === 'xmlhttp.php')
    {
        xmlhttp_error($lang->thread_doesnt_exist);
    }

    error_no_permission();
}

/**
 * Keep hidden threads out of a forum's thread list.
 *
 * Appended to the listing query's own visibility clause, so a hidden thread is gone
 * before the page's LIMIT is applied and the page stays as full as it would have been.
 *
 * MyBB counts the forum's threads further up the page than any hook it offers, so the
 * count behind the page links - and the running totals on the board index, which are
 * cached columns on the forum - still count a thread this member cannot see. That is a
 * number, not a subject, and correcting it would mean re-running the count after the
 * page links had already been built.
 *
 * Hooks: forumdisplay_get_threads
 */
function events_hide_threads_in_forum()
{
    global $tvisibleonly;

    $hidden = events_request_hidden_threads();
    if(empty($hidden))
    {
        return;
    }

    $tvisibleonly .= " AND t.tid NOT IN (" . implode(',', $hidden) . ")";
}

/**
 * Keep a hidden thread out of the "last post" a forum row advertises.
 *
 * The board index names each forum's newest thread by subject, so an announcement that
 * happens to be the newest one would be published there whatever forumdisplay does. The
 * newest thread this member may actually read takes its place rather than the row being
 * blanked, so a busy forum does not read as an empty one.
 *
 * Hooks: build_forumbits_forum
 *
 * @param array $forum
 * @return array
 */
function events_hide_thread_in_forumbit($forum)
{
    global $db;

    if(empty($forum['lastposttid']))
    {
        return $forum;
    }

    $hidden = events_request_hidden_threads();
    if(empty($hidden) || !in_array((int)$forum['lastposttid'], $hidden, true))
    {
        return $forum;
    }

    $thread = $db->fetch_array($db->simple_select(
        "threads",
        "tid, subject, lastpost, lastposter, lastposteruid",
        "fid = " . (int)$forum['fid'] . " AND visible = 1 AND closed NOT LIKE 'moved|%'"
            . " AND tid NOT IN (" . implode(',', $hidden) . ")",
        array('order_by' => 'lastpost', 'order_dir' => 'desc', 'limit' => 1)
    ));

    if(empty($thread))
    {
        $forum['lastpost'] = 0;
        $forum['lastposttid'] = 0;
        $forum['lastpostsubject'] = '';
        $forum['lastposter'] = '';
        $forum['lastposteruid'] = 0;

        return $forum;
    }

    $forum['lastpost'] = (int)$thread['lastpost'];
    $forum['lastposttid'] = (int)$thread['tid'];
    $forum['lastpostsubject'] = $thread['subject'];
    $forum['lastposter'] = $thread['lastposter'];
    $forum['lastposteruid'] = (int)$thread['lastposteruid'];

    return $forum;
}

/**
 * Keep hidden threads out of a search.
 *
 * The search log is the list of hits the results page then renders, so the thread and its
 * posts are dropped on the way in. Filtering the results page instead would leave the
 * thread in the log for every "search within these results" that followed.
 *
 * Hooks: search_do_search_process
 */
function events_hide_threads_in_search()
{
    global $db, $lang, $searcharray;

    if(empty($searcharray))
    {
        return;
    }

    $hidden = events_request_hidden_threads();
    if(empty($hidden))
    {
        return;
    }

    $before = array(
        'threads' => (string)$searcharray['threads'],
        'posts' => (string)$searcharray['posts'],
    );

    if(!empty($searcharray['threads']))
    {
        $searcharray['threads'] = implode(',', array_diff(events_id_list($searcharray['threads']), $hidden));
    }

    if(!empty($searcharray['posts']))
    {
        $hidden_posts = array();
        $query = $db->simple_select("posts", "pid", "tid IN (" . implode(',', $hidden) . ")");
        while($row = $db->fetch_array($query))
        {
            $hidden_posts[] = (int)$row['pid'];
        }

        $searcharray['posts'] = implode(',', array_diff(events_id_list($searcharray['posts']), $hidden_posts));
    }

    // A search whose only hits were hidden has to be answered the way MyBB answers one that
    // found nothing. Its search functions refuse to file an empty list, and the results page
    // relies on that: it drops the thread list straight into "t.tid IN (...)", so an empty
    // one is an SQL error. A search with a querycache is exempt - its results page re-runs
    // the clause, never reads the list, and handles finding nothing itself.
    $list = $searcharray['resulttype'] == 'posts' ? 'posts' : 'threads';
    if(empty($searcharray['querycache']) && $searcharray[$list] === '' && $before[$list] !== '')
    {
        error($lang->error_nosearchresults);
    }
}

/**
 * Keep hidden threads out of a search that is re-run every time its results are shown.
 *
 * View New Posts, Today's Posts and "Find threads by user" file a WHERE clause in the
 * search log's querycache as well as a list of hits, and the results page runs that
 * clause again and ignores the list - so events_hide_threads_in_search() trims a list
 * nothing reads. The clause is narrowed here, as the page loads it, rather than when it
 * is filed: it is re-run on every page of the results, and an announcement posted after
 * the member clicked the link would match it.
 *
 * Hooks: search_results_start
 */
function events_hide_threads_in_saved_search()
{
    global $search;

    if(empty($search['querycache']) || $search['resulttype'] != 'threads')
    {
        return;
    }

    $hidden = events_request_hidden_threads();
    if(empty($hidden))
    {
        return;
    }

    // The saved clause is written against the threads table unqualified, and the results
    // page runs it as "threads t", so a bare tid reads the same either way.
    $search['querycache'] = "(" . $search['querycache'] . ") AND tid NOT IN (" . implode(',', array_map('intval', $hidden)) . ")";
}

/**
 * Keep hidden threads out of the board's RSS feeds.
 *
 * syndication.php has already built its item list by the time it offers a hook, so the
 * hidden threads are lifted back out of it - along with the posts fetched to fill in each
 * item's body, or the feed would carry the announcement with no title attached to it.
 *
 * Hooks: syndication_get_posts
 */
function events_hide_threads_in_feed()
{
    global $db, $items, $firstposts;

    if(empty($items))
    {
        return;
    }

    $hidden = events_request_hidden_threads();
    $hidden = array_intersect($hidden, array_map('intval', array_keys($items)));
    if(empty($hidden))
    {
        return;
    }

    $hidden_posts = array();
    $query = $db->simple_select("threads", "firstpost", "tid IN (" . implode(',', $hidden) . ")");
    while($row = $db->fetch_array($query))
    {
        $hidden_posts[] = (int)$row['firstpost'];
    }

    foreach($hidden as $thread_id)
    {
        unset($items[$thread_id]);
    }

    if(!empty($firstposts) && !empty($hidden_posts))
    {
        $firstposts = array_values(array_diff(array_map('intval', $firstposts), $hidden_posts));
    }
}

/**
 * A comma separated list of ids as ints.
 *
 * MyBB keeps a search's hits as "12,48,93" and hands the same string straight back to the
 * query that renders them, so the list has to go out the way it came in.
 *
 * @param string $list
 * @return array of int
 */
function events_id_list($list)
{
    $ids = array();

    foreach(explode(',', (string)$list) as $id)
    {
        $id = (int)trim($id);
        if($id > 0)
        {
            $ids[] = $id;
        }
    }

    return $ids;
}

/**
 * Swap the board's Calendar navigation item for an "Events" one.
 *
 * MyBB's header template has no plugin-facing placeholder, so this works on the rendered
 * page. The board's own calendar is unused - events live in this plugin - so its menu item
 * is taken over rather than sat beside, and the replacement reuses the markup the active
 * theme put there so it stays styled like its neighbours. That matters because themes
 * rewrite the header wholesale - a Bootstrap-based theme, for instance, replaces MyBB's
 * <ul class="menu top_links"> with a navbar.
 *
 * The Calendar item goes whoever is looking; the Events item only appears for users who
 * could actually open events.php.
 *
 * @param string $page
 * @return string
 */
function events_nav_menu(&$page)
{
    global $mybb;

    // Only events_hooks.php is loaded on every request (see inc/plugins/events.php), so the
    // permission helper has to be pulled in here rather than assumed.
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    if(strpos($page, 'id="nav_events"') !== false)
    {
        return $page;
    }

    $show_events = events_can_view_events_page();
    $url = $mybb->settings['bburl'] . '/events.php';

    // Themes that leave MyBB's template HTML comments on wrap the item in them, so those
    // are swallowed too - otherwise removing the item would leave an empty pair behind.
    $calendar_item = '#(?:<!--\s*start:\s*header_menu_calendar\s*-->\s*)?'
        . '(<li\b[^>]*>)\s*(<a\b[^>]*\bhref="[^"]*calendar\.php[^"]*"[^>]*>)(.*?)</a>\s*</li>'
        . '(?:\s*<!--\s*end:\s*header_menu_calendar\s*-->)?#is';

    if(preg_match($calendar_item, $page, $match, PREG_OFFSET_CAPTURE))
    {
        list($item, $offset) = $match[0];
        $replacement = '';

        if($show_events)
        {
            // Carry the theme's own anchor classes across, minus "calendar" - that one is
            // how MyBB's default theme names the item's sprite icon, not a shared style.
            $classes = array('events');
            if(preg_match('#\bclass="([^"]*)"#i', $match[2][0], $class_match))
            {
                $classes = array_merge($classes, array_diff(preg_split('#\s+#', trim($class_match[1]), -1, PREG_SPLIT_NO_EMPTY), array('calendar')));
            }

            // A theme's menu items carry their icon inside the anchor - the garrison's uses
            // a Font Awesome <i> element with the row's colour on it - so replacing the
            // whole anchor threw the icon away and left Events as the one item in the row
            // without one. The leading icon element rides across with the classes, and
            // whatever the theme used for Calendar is what Events gets: matching the row it
            // sits in matters more than the glyph, and naming one here would only hold for
            // a theme that happened to use the same icon set. A Calendar item that had no
            // icon still yields none.
            $icon = '';
            if(preg_match('#^\s*(<(i|span|svg)\b[^>]*>.*?</\2>\s*(?:&nbsp;|&\#160;|\s)*)#is', $match[3][0], $icon_match))
            {
                $icon = $icon_match[1];
            }

            $replacement = $match[1][0] . '<a href="' . $url . '" id="nav_events" class="' . implode(' ', $classes) . '">' . $icon . 'Events</a></li>';
        }

        $page = substr_replace($page, $replacement, $offset, strlen($item));

        return $page;
    }

    // Boards with the calendar switched off still have MyBB's default menu container.
    $marker = '<ul class="menu top_links">';
    if($show_events && ($offset = strpos($page, $marker)) !== false)
    {
        $item = '<li><a href="' . $url . '" id="nav_events" class="events">Events</a></li>';
        $page = substr_replace($page, $item, $offset + strlen($marker), 0);
    }

    return $page;
}

/**
 * Find the event a thread announces, when this member may see it.
 *
 * $event_info stays exposed for templates, as it always has been. The event card is only
 * rendered for a member who could open the event itself: a guest, or anybody else
 * events_can_view_event() turns away, reads the thread's own first post - the generated
 * announcement - which says the same things in BBCode. That post is also what Tapatalk
 * and the other clients that read posts rather than pages keep showing, which is why it
 * is still written and kept up to date.
 *
 * Hooks: showthread_start
 */
function events_thread_display()
{
    global $tid, $db, $event_info;

    $event_info = $db->fetch_array($db->simple_select("event_plugin_events", "*", "thread_id = " . (int)$tid));

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    events_thread_event(!empty($event_info) && events_can_view_event($event_info) ? $event_info : null);
}

/**
 * The event whose card replaces this thread's first post, if any.
 *
 * @param array|null $event Set by events_thread_display(); omitted to read it back
 * @return array|null
 */
function events_thread_event($event = false)
{
    static $current = null;

    if($event !== false)
    {
        $current = $event;
    }

    return $current;
}

/**
 * Render an event thread's first post as the event card.
 *
 * MyBB builds each post from the postbit template (or postbit_classic) after this hook
 * has run, and gives a plugin no way to replace what comes out. So for the one post that
 * is the announcement, the two postbit templates are swapped for events_postbit - which
 * is the card and the post's #pid anchor, and none of the post furniture around it - and
 * swapped back before the next post is built. Everything else about the thread is MyBB's
 * own: the replies, the paging (the card counts as the first post, the way the
 * announcement it stands in for does), quick reply and the thread tools.
 *
 * Only in showthread.php, and only for the post that is the thread's first. A first post
 * that is unapproved or soft-deleted keeps MyBB's own treatment, so a moderator still
 * sees it for what it is.
 *
 * Hooks: postbit
 *
 * @param array $post
 * @return array
 */
function events_thread_postbit(&$post)
{
    global $thread, $templates;

    events_restore_postbit_templates();

    $event = events_thread_event();
    if(empty($event) || !defined('THIS_SCRIPT') || THIS_SCRIPT !== 'showthread.php' || empty($thread['firstpost']))
    {
        return $post;
    }

    if((int)$post['pid'] !== (int)$thread['firstpost'] || (isset($post['visible']) && (int)$post['visible'] !== 1))
    {
        return $post;
    }

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_event_card.php";

    $post['events_card'] = events_render_event_card($event, (int)$thread['tid']);

    // get() fills the cache as a side effect; the cache holds the raw template, which is
    // what get() reads back for postbit below.
    $templates->get('events_postbit');
    events_swap_postbit_templates($templates->cache['events_postbit']);

    return $post;
}

/**
 * Stand a template in for postbit and postbit_classic, remembering what was there.
 *
 * @param string $template Raw template body
 */
function events_swap_postbit_templates($template)
{
    global $templates, $events_postbit_saved;

    $events_postbit_saved = array();
    foreach(array('postbit', 'postbit_classic') as $title)
    {
        $events_postbit_saved[$title] = isset($templates->cache[$title]) ? $templates->cache[$title] : null;
        $templates->cache[$title] = $template;
    }
}

/**
 * Put postbit and postbit_classic back after events_swap_postbit_templates().
 *
 * A template that had not been cached before the swap is dropped rather than set, so the
 * next get() fetches the real one.
 *
 * Hooks: showthread_linear, showthread_threaded (and called from events_thread_postbit())
 */
function events_restore_postbit_templates()
{
    global $templates, $events_postbit_saved;

    if(empty($events_postbit_saved))
    {
        return;
    }

    foreach($events_postbit_saved as $title => $template)
    {
        if($template === null)
        {
            unset($templates->cache[$title]);
        }
        else
        {
            $templates->cache[$title] = $template;
        }
    }

    $events_postbit_saved = null;
}

/**
 * Link an event thread to its start rather than to the first unread post.
 *
 * The event is the thread's first post, so that is what a member opening the thread
 * from a listing is after - somebody checking who is going or signing up should not land
 * three pages in on the latest reply. The garrison theme links threads through Smart
 * Thread Link's {$thread['smartlink']}, which is the value this overrides.
 *
 * Hooks: forumdisplay_thread_end, search_results_thread,
 *        usercp_thread_subscriptions_thread, usercp_latest_threads_thread
 */
function events_thread_link_to_start()
{
    global $thread;

    if(empty($thread['tid']))
    {
        return;
    }

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    if(in_array((int)$thread['tid'], events_announcement_thread_ids(), true))
    {
        $thread['smartlink'] = get_thread_link((int)$thread['tid']);
    }
}

/**
 * Drop a deleted member's signups, exclusions and preferences.
 *
 * Hook: datahandler_user_delete_end, by which point $handler->delete_uids is the
 * comma-separated list of the members actually deleted.
 *
 * @param UserDataHandler $handler
 */
function events_user_deleted($handler)
{
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    events_delete_member_data(explode(',', (string)$handler->delete_uids));
}

/**
 * PM every attendee of a finished event that still has no posted troop report.
 *
 * Reminders are re-sent at most once a week per event. All time comparisons are done
 * in PHP rather than with SQL NOW() so the behaviour follows the application clock -
 * and the wall clocks they are compared against are the event timezone's, which is the
 * zone the dates in those columns were written in.
 *
 * @return int number of events reminded about
 */
function events_send_reminders()
{
    global $db, $mybb;

    require_once MYBB_ROOT . "inc/datahandlers/pm.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    $reminder_interval = 7 * 24 * 60 * 60;
    $now = events_date('Y-m-d H:i:s');
    $resend_before = events_date('Y-m-d H:i:s', TIME_NOW - $reminder_interval);

    $query = $db->query("
        SELECT e.id, e.title, tr.id AS report_id, tr.last_reminder_sent
        FROM " . TABLE_PREFIX . "event_plugin_events e
        LEFT JOIN " . TABLE_PREFIX . "event_plugin_troop_reports tr ON e.id = tr.event_id
        WHERE e.status = 'live'
          AND e.end_date < '" . $db->escape_string($now) . "'
          AND (tr.id IS NULL OR tr.posted_at IS NULL)
          AND (tr.last_reminder_sent IS NULL OR tr.last_reminder_sent < '" . $db->escape_string($resend_before) . "')
    ");

    $events = array();
    while($row = $db->fetch_array($query))
    {
        $events[] = $row;
    }

    $reminded = 0;
    foreach($events as $event)
    {
        // Excluding somebody does not cancel a signup they already held, so an attendee
        // can end up excluded from an event they turned out to. The event is hidden from
        // them now, and a PM naming it - with a link to a form that refuses them - would
        // be the one place it was still announced.
        $excluded = array();
        $exclusion_query = $db->simple_select("event_plugin_event_exclusions", "user_id",
            "event_id = " . (int)$event['id']);
        while($row = $db->fetch_array($exclusion_query))
        {
            $excluded[] = (int)$row['user_id'];
        }

        $user_ids = array();
        // Troopers only: wranglers cannot author a troop report, so nagging them about a
        // missing one is noise. It also keeps somebody who both trooped and wrangled from
        // landing in $user_ids twice and being PMed twice.
        //
        // Joined to users because this is one PM to every recipient, and MyBB refuses the
        // whole PM if any one of them does not exist. Deleting a member drops their
        // signups (events_user_deleted()), but a single stray row would otherwise stop
        // this event's reminder for everybody, silently and permanently.
        $rsvp_query = $db->query("
            SELECT r.user_id
            FROM " . TABLE_PREFIX . "event_plugin_rsvps r
            INNER JOIN " . TABLE_PREFIX . "users u ON u.uid = r.user_id
            WHERE r.event_id = " . (int)$event['id'] . "
              AND r.role = 'trooper'
              AND r.status = 'attending'
        ");
        while($rsvp = $db->fetch_array($rsvp_query))
        {
            if(in_array((int)$rsvp['user_id'], $excluded, true))
            {
                continue;
            }

            $user_ids[] = (int)$rsvp['user_id'];
        }

        if(empty($user_ids))
        {
            continue;
        }

        $pmhandler = new PMDataHandler();
        $pmhandler->admin_override = true;
        $pmhandler->set_data(array(
            'subject' => "Troop Report Needed: " . $event['title'],
            'message' => "The event '" . $event['title'] . "' has finished, but no troop report has been posted yet.\n\n" .
                         "Please create one here: " . $mybb->settings['bburl'] . "/troop_report.php?id=" . $event['id'],
            'fromid'  => 0,
            'toid'    => $user_ids,
            'ipaddress' => '127.0.0.1',
        ));

        if(!$pmhandler->validate_pm())
        {
            continue;
        }

        $pmhandler->insert_pm();
        $reminded++;

        // Re-read under troop_report.php's lock: a report posted since the query above
        // has inserted the row this would otherwise insert again, into a unique key.
        $locked = events_acquire_lock('troop_report:' . (int)$event['id']);
        $report = events_get_troop_report($event['id']);

        if($report)
        {
            $db->update_query("event_plugin_troop_reports",
                array('last_reminder_sent' => $db->escape_string($now)),
                "id = " . (int)$report['id']);
        }
        else
        {
            $db->insert_query("event_plugin_troop_reports", array(
                'event_id'           => (int)$event['id'],
                'created_by'         => 0,
                'created_at'         => $db->escape_string($now),
                'last_reminder_sent' => $db->escape_string($now),
            ));
        }

        if($locked)
        {
            events_release_lock('troop_report:' . (int)$event['id']);
        }
    }

    return $reminded;
}

/**
 * Keep the profile-field dropdowns on the plugin's settings page in step with the
 * board's custom profile fields.
 *
 * Hooks: admin_config_profile_fields_{add,edit,delete}_commit
 */
function events_rebuild_profile_field_dropdowns()
{
    global $db;

    require_once MYBB_ROOT . "inc/plugins/events.php";

    $optionscode = events_build_profile_field_optionscode();

    foreach(events_profile_field_settings() as $setting_name)
    {
        $db->update_query("settings",
            array("optionscode" => $db->escape_string($optionscode)),
            "name = '" . $db->escape_string($setting_name) . "'");
    }

    rebuild_settings();
}

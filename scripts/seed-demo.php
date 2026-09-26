<?php
/**
 * Seed a demonstration board: one event for every state the plugin can put an event in,
 * with rosters big enough to show the coordinator pages doing real work.
 *
 * This is for showing the plugin off and for poking at it by hand. The Playwright suite
 * builds its own fixtures and does not read anything here; scripts/db-restore.sh wipes
 * the board back to the provisioned baseline, which has users and settings but no events,
 * and this fills that baseline in. Run it with:
 *
 *   docker compose exec -T web php /dev/stdin < scripts/seed-demo.php
 *
 * Idempotent: events are matched by title and rewritten in place, members by username, so
 * re-running updates the demo rather than duplicating it. Everything is dated relative to
 * the clock at the moment it runs, so re-running is also how the demo is moved forward
 * once "next week" has become last week.
 *
 * Events are written through the plugin's own events_save_event() and events_save_signup()
 * rather than by inserting rows, so what the demo contains is exactly what the forms would
 * have produced - including the generated announcement threads, which is half of what
 * there is to show.
 *
 * Do not run scripts/db-snapshot.sh after seeding. The snapshot is a plain dump, so it
 * would bake eighteen demo events, eighteen demo members and their announcement threads
 * into the baseline that every later e2e run starts from - where they are not fixtures the
 * suite knows about, but rows its assertions have to compete with. Run
 * scripts/db-restore.sh first if a snapshot is needed.
 */

define('IN_MYBB', 1);
define('MYBB_ROOT', '/var/www/html/');
define('THIS_SCRIPT', 'seed-demo.php');
define('NO_ONLINE', 1);

require_once MYBB_ROOT . 'inc/init.php';

// Surface the failing query rather than a blank "SQL error" if something goes wrong.
$mybb->dev_mode = 1;

require_once MYBB_ROOT . 'inc/functions_user.php';
require_once MYBB_ROOT . 'inc/datahandlers/user.php';
require_once MYBB_ROOT . 'inc/datahandlers/post.php';

// events_hooks.php is the only plugin include loaded on every request; the writers this
// script drives live in the other two.
require_once MYBB_ROOT . 'inc/plugins/events/inc/events_functions.php';
require_once MYBB_ROOT . 'inc/plugins/events/inc/events_form.php';
require_once MYBB_ROOT . 'inc/plugins/events/inc/events_thread.php';

/** @var DB_MySQLi $db */
/** @var MyBB $mybb */
/** @var datacache $cache */

function out($msg) { echo "    " . $msg . "\n"; }
function fail($msg) { fwrite(STDERR, "SEED ERROR: " . $msg . "\n"); exit(1); }

if(!function_exists('events_save_event'))
{
    fail('the Events plugin is not active on this board - run scripts/provision.php first.');
}

// ---------------------------------------------------------------------------
// Dates
//
// Every date the plugin stores is a wall clock in the board's event timezone, so the
// offsets below are counted in that zone's calendar days rather than in multiples of
// 86400 - which would drift by an hour across a daylight saving boundary and, twice a
// year, put an event on the wrong day.
// ---------------------------------------------------------------------------

/**
 * @param int $offset_days Days from today, in the board's event timezone
 * @return string Y-m-d
 */
function demo_date($offset_days)
{
    static $today = null;

    if($today === null)
    {
        $today = new DateTime('@' . TIME_NOW);
        $today->setTimezone(events_timezone());
        $today->setTime(0, 0, 0);
    }

    $date = clone $today;
    $date->modify(sprintf('%+d days', (int)$offset_days));

    return $date->format('Y-m-d');
}

/**
 * @param int $offset_days
 * @param string $time HH:MM:SS
 * @return string Y-m-d H:i:s
 */
function demo_at($offset_days, $time)
{
    return demo_date($offset_days) . ' ' . $time;
}

/**
 * The day rows a form would have built for a date range - one per calendar day, which is
 * what makes an event multi-day as far as the signup wizard and the attendance sheet are
 * concerned.
 *
 * @param int $from_offset
 * @param int $to_offset
 * @param string $start_time
 * @param string $end_time
 * @return array
 */
function demo_days($from_offset, $to_offset, $start_time = '09:00:00', $end_time = '17:00:00')
{
    $days = array();

    for($offset = $from_offset; $offset <= $to_offset; $offset++)
    {
        $days[] = array(
            'date'       => demo_date($offset),
            'start_time' => $start_time,
            'end_time'   => $end_time,
        );
    }

    return $days;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

$DEMO_PASSWORD = 'testpass123';

/**
 * The costumes the demo members own.
 *
 * This used to be read out of the mapped profile field, back when that field was a
 * multiselect and "the costumes a member can pick" was a real list the board held. It is
 * free text now - one costume per line, as on the real board - so there is no list to
 * read: these are simply the costumes the demo hands out, and they are written to members'
 * profiles like any other free-text value.
 *
 * @return array
 */
function demo_costume_options()
{
    return array(
        'TK - Stormtrooper',
        'TD - Sandtrooper',
        'TB - Biker Scout',
        'TI - TIE Pilot',
        'DZ - Death Star Trooper',
    );
}

/**
 * @param string $title
 * @return int gid, 0 when the board has no such group
 */
function demo_group($title)
{
    global $db;

    static $groups = array();

    if(!isset($groups[$title]))
    {
        $row = $db->fetch_array($db->simple_select('usergroups', 'gid', "title = '" . $db->escape_string($title) . "'"));
        $groups[$title] = $row ? (int)$row['gid'] : 0;
    }

    return $groups[$title];
}

/**
 * Find or create a demo member, and keep their profile fields and groups in step.
 *
 * Mirrors scripts/provision.php: the user goes in through MyBB's own datahandler, and the
 * custom profile fields the plugin is configured to read go straight into userfields.
 *
 * @param string $username
 * @param array $spec groups (array of group title), fields (keyed by plugin field name)
 * @return int uid
 */
function demo_member($username, array $spec)
{
    global $db, $DEMO_PASSWORD;

    $existing = $db->fetch_array($db->simple_select('users', 'uid', "username = '" . $db->escape_string($username) . "'"));

    if($existing)
    {
        $uid = (int)$existing['uid'];
    }
    else
    {
        $handler = new UserDataHandler('insert');
        $handler->set_data(array(
            'username'  => $username,
            'password'  => $DEMO_PASSWORD,
            'password2' => $DEMO_PASSWORD,
            'email'     => strtolower($username) . '@example.test',
            'email2'    => strtolower($username) . '@example.test',
            'usergroup' => 2,
            'regip'     => '127.0.0.1',
            'lastip'    => '127.0.0.1',
            'language'  => '',
            'regdate'   => TIME_NOW,
        ));

        if(!$handler->validate_user())
        {
            fail("could not create member {$username}: " . implode('; ', $handler->get_friendly_errors()));
        }

        $info = $handler->insert_user();
        $uid = (int)$info['uid'];
    }

    $additional = array();
    foreach(isset($spec['groups']) ? $spec['groups'] : array() as $title)
    {
        $gid = demo_group($title);
        if($gid)
        {
            $additional[] = $gid;
        }
    }

    $db->update_query('users', array(
        'usergroup'        => 2,
        'additionalgroups' => implode(',', $additional),
    ), 'uid = ' . $uid);

    // The plugin reads each of these through a setting naming the profile field, so the
    // demo writes them by the same names rather than by field id.
    $field_map = array(
        'costume'           => (int)events_get_setting('costume_field'),
        'tk_id'             => (int)events_get_setting('tk_id_field'),
        'wwcc'              => (int)events_get_setting('wwcc_field'),
        'mobile'            => (int)events_get_setting('mobile_field'),
        'emergency_contact' => (int)events_get_setting('emergency_contact_field'),
        'preferred_name'    => (int)events_get_setting('preferred_name_field'),
    );

    $values = array();
    foreach(isset($spec['fields']) ? $spec['fields'] : array() as $key => $value)
    {
        if(empty($field_map[$key]))
        {
            continue;
        }

        // A multiselect is stored newline separated, which is how MyBB's own datahandler
        // writes it and how events_get_user_field() reads it back.
        $values['fid' . $field_map[$key]] = $db->escape_string(is_array($value) ? implode("\n", $value) : (string)$value);
    }

    if($values)
    {
        if($db->num_rows($db->simple_select('userfields', 'ufid', 'ufid = ' . $uid)) > 0)
        {
            $db->update_query('userfields', $values, 'ufid = ' . $uid);
        }
        else
        {
            $values['ufid'] = $uid;
            $db->insert_query('userfields', $values);
        }
    }

    return $uid;
}

/**
 * @param string $username
 * @return int uid
 */
function demo_uid($username)
{
    global $uids;

    if(!isset($uids[$username]))
    {
        fail("no such demo member: {$username}");
    }

    return $uids[$username];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Write one demo event through the plugin's own saver.
 *
 * events_save_event() is what both real forms call, so the event, its days, its
 * exclusions and its generated announcement thread all come out exactly as they would
 * have from the Admin CP - including the announcement landing in the forum configured
 * for the event's region, and pending events staying unannounced.
 *
 * @param array $spec
 * @return int event id
 */
function demo_event(array $spec)
{
    global $db;

    $existing = $db->fetch_array($db->simple_select(
        'event_plugin_events', 'id', "title = '" . $db->escape_string($spec['title']) . "'"));

    $input = array_merge(array(
        'description'   => '',
        'status'        => 'live',
        'region'        => 'Sydney',
        'address'       => '',
        'signup_cutoff' => '',
        'requires_wwcc' => 0,
        // 0 is no limit, which is what every event without a waitlist to show wants.
        'max_troopers'  => 0,
        'max_wranglers' => 0,
        'gec_user_id'   => demo_uid('gec'),
        'days'          => array(),
        'exclusions'    => '',
    ), $spec);

    $event_id = $existing ? (int)$existing['id'] : 0;

    // The plugin only ever writes an announcement for a live event, so an archived one
    // saved as archived in a single step would have no thread to link to - while a real
    // archived event was live once and kept the thread it had, which is the state worth
    // demonstrating. So it goes live first and is then archived, by the path a real one
    // took.
    if($input['status'] === 'archived')
    {
        $ignored = null;
        $event_id = events_save_event($event_id, array_merge($input, array('status' => 'live')), demo_uid('gec'), $ignored);
    }

    $thread_error = null;
    $event_id = events_save_event($event_id, $input, demo_uid('gec'), $thread_error);

    if($thread_error)
    {
        out("  ! announcement not written for '{$spec['title']}': " . $thread_error);
    }

    // Rosters are declared in full below, so anybody the demo no longer lists is cleared
    // out rather than left over from an earlier run under a different catalogue.
    $rsvps = $db->simple_select('event_plugin_rsvps', 'id', 'event_id = ' . (int)$event_id);
    while($rsvp = $db->fetch_array($rsvps))
    {
        $db->delete_query('event_plugin_rsvp_days', 'rsvp_id = ' . (int)$rsvp['id']);
        $db->delete_query('event_plugin_rsvp_costumes', 'rsvp_id = ' . (int)$rsvp['id']);
    }
    $db->delete_query('event_plugin_rsvps', 'event_id = ' . (int)$event_id);

    return (int)$event_id;
}

/**
 * The event's day row ids, in date order.
 *
 * @param int $event_id
 * @return array of int
 */
function demo_event_day_ids($event_id)
{
    global $db;

    $ids = array();
    $query = $db->simple_select('event_plugin_event_days', 'id', 'event_id = ' . (int)$event_id, array('order_by' => 'date'));
    while($row = $db->fetch_array($query))
    {
        $ids[] = (int)$row['id'];
    }

    return $ids;
}

/**
 * Sign a member up, through the same writer the wizard's final step uses.
 *
 * @param int $event_id
 * @param string $username
 * @param array $opts roles (array of role), days (array of 0-based day indexes; all days
 *                    when absent), costumes (array; the member's own when absent)
 * @return void
 */
function demo_signup($event_id, $username, array $opts = array())
{
    $uid = demo_uid($username);
    $all_days = demo_event_day_ids($event_id);

    if(isset($opts['days']))
    {
        $days = array();
        foreach($opts['days'] as $index)
        {
            if(isset($all_days[$index]))
            {
                $days[] = $all_days[$index];
            }
        }
    }
    else
    {
        $days = $all_days;
    }

    $role_days = array();
    foreach(isset($opts['roles']) ? $opts['roles'] : array('trooper') as $role)
    {
        $role_days[$role] = $days;
    }

    if(isset($opts['costumes']))
    {
        $costumes = $opts['costumes'];
    }
    else
    {
        // Whatever they own, which is what the wizard offers them.
        $owned = events_get_user_field($uid, 'costume');
        $costumes = array_values(array_filter(array_map('trim', preg_split('/\r\n|\r|\n/', (string)$owned)), 'strlen'));
        $costumes = $costumes ? array_slice($costumes, 0, 1) : array();
    }

    events_save_signup($event_id, $uid, $role_days, $costumes);
}

/**
 * Post a troop report for an event, the way troop_report.php does: a thread in the
 * configured forum, the report row marked posted, and a pointer left on the event's own
 * announcement thread.
 *
 * @param array $event
 * @param string $username Author; must have trooped the event
 * @param string $content BBCode
 * @return void
 */
function demo_troop_report(array $event, $username, $content)
{
    global $db;

    $existing = events_get_troop_report($event['id']);
    if($existing && !empty($existing['posted_at']))
    {
        // Re-posting would leave a second thread behind on every run.
        return;
    }

    $forum_id = (int)events_get_setting('troop_report_forum');
    if(!$forum_id)
    {
        out("  ! no troop report forum configured, skipping the report for '{$event['title']}'");
        return;
    }

    $author = events_get_user(demo_uid($username));

    $handler = new PostDataHandler('insert');
    $handler->action = 'thread';
    $handler->admin_override = true;
    $handler->set_data(array(
        'fid'       => $forum_id,
        'subject'   => 'Troop Report: ' . $event['title'],
        'message'   => $content,
        'uid'       => (int)$author['uid'],
        'username'  => $author['username'],
        'ipaddress' => '127.0.0.1',
        'dateline'  => TIME_NOW,
        'savedraft' => 0,
        'options'   => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
    ));

    if(!$handler->validate_thread())
    {
        out("  ! troop report for '{$event['title']}' not posted: " . implode(' ', $handler->get_friendly_errors()));
        return;
    }

    $thread = $handler->insert_thread();
    $thread_id = (int)$thread['tid'];
    $now = events_date('Y-m-d H:i:s');

    if($existing)
    {
        $db->update_query('event_plugin_troop_reports', array(
            'thread_id'  => $thread_id,
            'created_by' => (int)$author['uid'],
            'posted_at'  => $db->escape_string($now),
        ), 'id = ' . (int)$existing['id']);
    }
    else
    {
        $db->insert_query('event_plugin_troop_reports', array(
            'event_id'   => (int)$event['id'],
            'thread_id'  => $thread_id,
            'created_by' => (int)$author['uid'],
            'created_at' => $db->escape_string($now),
            'posted_at'  => $db->escape_string($now),
        ));
    }

    if(!empty($event['thread_id']))
    {
        $reply = new PostDataHandler('insert');
        $reply->action = 'post';
        $reply->admin_override = true;
        $reply->set_data(array(
            'tid'       => (int)$event['thread_id'],
            'message'   => 'Troop report has been posted: [url=' . $GLOBALS['mybb']->settings['bburl']
                           . '/showthread.php?tid=' . $thread_id . ']View Troop Report[/url]',
            'uid'       => (int)$author['uid'],
            'username'  => $author['username'],
            'ipaddress' => '127.0.0.1',
            'dateline'  => TIME_NOW,
            'savedraft' => 0,
            'options'   => array('signature' => 0, 'subscriptionmethod' => '', 'disablesmilies' => 0),
        ));

        if($reply->validate_post())
        {
            $reply->insert_post();
        }
    }
}

// ---------------------------------------------------------------------------
// The demo garrison
//
// Enough members to fill a large roster and still leave people unsigned, so the signup
// pages have somebody to sign up as. Two of them deliberately have no WWCC, which is what
// makes the WWCC-required event show its gate rather than just its checkbox.
// ---------------------------------------------------------------------------

$costumes = demo_costume_options();

$TROOPERS = array(
    'AlexVoss', 'BriannaKade', 'CarloRen', 'DanaOkoye', 'EliTanaka', 'FreyaLind',
    'GusHolloway', 'HanaMorrow', 'IvanPetrov', 'JadeNkemdi', 'KaiWhitfield', 'LenaBauer',
    'MarcusHale', 'NadiaFarrow', 'OscarBright', 'PiaSolano',
);

// Non-costumed helpers: contactable, but no Legion ID, no WWCC and no costumes.
$WRANGLERS = array('RaySutton', 'TeganMoss');

$NO_WWCC = array('MarcusHale', 'NadiaFarrow');

// What each of them answers to at a staging area, which is the whole point of the column
// the attendance sheet gives it: a username is a forum handle, and a coordinator calling
// the roll needs the name the person turns around for.
//
// Deliberately not all the first half of the username. A demo where every preferred name
// could be read straight off the handle beside it makes the column look like duplication,
// so some here are shortenings and a couple are nicknames that share nothing with it -
// which is what the real board's field is mostly full of.
$PREFERRED_NAMES = array(
    'AlexVoss'     => 'Alex',
    'BriannaKade'  => 'Bri',
    'CarloRen'     => 'Carlo',
    'DanaOkoye'    => 'Dana',
    'EliTanaka'    => 'Eli',
    'FreyaLind'    => 'Freya',
    'GusHolloway'  => 'Gus',
    'HanaMorrow'   => 'Hana',
    'IvanPetrov'   => 'Vanya',
    'JadeNkemdi'   => 'Jade',
    'KaiWhitfield' => 'Kai',
    'LenaBauer'    => 'Lena',
    'MarcusHale'   => 'Marc',
    'NadiaFarrow'  => 'Nads',
    'OscarBright'  => 'Oz',
    'PiaSolano'    => 'Pia',
    'RaySutton'    => 'Ray',
    'TeganMoss'    => 'Teegs',
);

$uids = array();

foreach($TROOPERS as $index => $username)
{
    $fields = array(
        'tk_id'             => sprintf('TK-%05d', 31000 + $index),
        'preferred_name'    => $PREFERRED_NAMES[$username],
        'mobile'            => sprintf('0400 %03d %03d', 200 + $index, 400 + $index),
        'emergency_contact' => 'Kin ' . $username . sprintf(' 0400 %03d %03d', 900 + $index, 100 + $index),
        // Every third member owns a second costume, so the wizard's costume step and the
        // attendance sheet both have multi-costume rows to show.
        'costume'           => $index % 3 === 0
            ? array($costumes[$index % count($costumes)], $costumes[($index + 2) % count($costumes)])
            : array($costumes[$index % count($costumes)]),
    );

    if(!in_array($username, $NO_WWCC, true))
    {
        $fields['wwcc'] = sprintf('WWCC-%04d', 3100 + $index);
    }

    $uids[$username] = demo_member($username, array(
        'groups' => array('Garrison Members'),
        'fields' => $fields,
    ));
}

foreach($WRANGLERS as $index => $username)
{
    $uids[$username] = demo_member($username, array(
        'groups' => array(),
        'fields' => array(
            'preferred_name'    => $PREFERRED_NAMES[$username],
            'mobile'            => sprintf('0400 %03d %03d', 700 + $index, 700 + $index),
            'emergency_contact' => 'Kin ' . $username . sprintf(' 0400 %03d %03d', 800 + $index, 800 + $index),
        ),
    ));
}

out('demo members: ' . count($uids));

// The fixture users provisioning already created. They carry the interesting edge cases -
// no prerequisites at all, prerequisites but no WWCC, the member the exclusion demo
// excludes - so the demo leans on them rather than duplicating them.
foreach(array('gec', 'trooper1', 'trooper2', 'newbie', 'nowwcc', 'wrangler', 'excluded') as $username)
{
    $row = $db->fetch_array($db->simple_select('users', 'uid', "username = '" . $db->escape_string($username) . "'"));
    if(!$row)
    {
        fail("fixture user '{$username}' is missing - run scripts/provision.php first.");
    }

    $uids[$username] = (int)$row['uid'];
}

// The board administrator, created by MyBB's installer rather than by provisioning. Looked
// up rather than passed through demo_member(), which rewrites usergroup and
// additionalgroups and would therefore demote the one account that can reach the Admin CP.
$admin = $db->fetch_array($db->simple_select('users', 'uid, username', 'usergroup = 4', array('order_by' => 'uid', 'limit' => 1)));

if($admin)
{
    $uids[$admin['username']] = (int)$admin['uid'];
    $ADMIN_USERNAME = $admin['username'];

    // They are rostered onto the finished event below, so they appear on an attendance
    // sheet and would otherwise be the one row on it with the preferred name column
    // empty. Through the plugin's own writer rather than demo_member(), for two reasons:
    // demo_member() rewrites usergroup and additionalgroups and would demote the only
    // account that can reach the Admin CP, and the installer's account is the one that
    // has no userfields row at all, which events_save_user_fields() knows to insert
    // rather than update.
    events_save_user_fields((int)$admin['uid'], array('preferred_name' => 'Admin'));
}
else
{
    // Not fatal: everything else in the demo stands up without an administrator on it.
    $ADMIN_USERNAME = null;
    out('! no administrator account found, so nobody will be rostered to write the demo troop report');
}

// The announcement thread is posted as the event's coordinator, but an edit records who
// made it. Nothing has logged in on a CLI run, so the coordinator stands in.
$mybb->user = events_get_user($uids['gec']);

// ---------------------------------------------------------------------------
// Region announcement forums
//
// An event's announcement landing in the forum configured for its region rather than in
// the default one is a feature worth showing, and it is a setting rather than anything
// the plugin can derive - the region list and that map are edited separately. On a board
// where nothing has set it (or where the regions spec has put the list back the way it
// found it) the Hunter event would announce into the default forum and the feature would
// simply not appear in the demo, with nothing to say it had not.
//
// Only ever filled in when the region has no forum of its own: a board that has mapped it
// somewhere deliberately keeps that.
// ---------------------------------------------------------------------------

$region_forums = events_region_forums();

if(!isset($region_forums['Hunter']))
{
    $forum = $db->fetch_array($db->simple_select('forums', 'fid', "type = 'f' AND name = 'Hunter Event Announcements'"));

    if($forum)
    {
        $region_forums['Hunter'] = (int)$forum['fid'];

        $db->update_query('settings', array(
            'value' => $db->escape_string(events_build_region_forums_setting($region_forums)),
        ), "name = 'events_event_forums'");

        // MyBB serves $mybb->settings from the generated inc/settings.php rather than
        // from the table, so a setting written with SQL is invisible to every page - and
        // to the rest of this script - until this runs.
        rebuild_settings();

        out('mapped the Hunter region to its own announcement forum');
    }
    else
    {
        out('! this board has no Hunter announcement forum, so that event will use the default one');
    }
}

// ---------------------------------------------------------------------------
// The catalogue
//
// Dates are relative to the run, so re-running is how the demo is moved forward when
// "next week" has quietly become last week.
// ---------------------------------------------------------------------------

$seeded = array();

/**
 * @param string $label What this event is in the demo for
 * @param int $id
 */
function note($label, $id)
{
    global $seeded, $db;

    $event = events_get_event($id);
    $seeded[] = array(
        'id'     => $id,
        'title'  => $event['title'],
        'label'  => $label,
        'status' => $event['status'],
        'start'  => $event['start_date'],
        'thread' => (int)$event['thread_id'],
    );

    out(sprintf('  #%-3d %-44s %s', $id, substr($event['title'], 0, 44), $label));
}

// 1. Nobody signed up: the empty roster, and the call to action that goes with it.
$id = demo_event(array(
    'title'       => 'Westfield Parramatta Charity Walk',
    'region'      => 'Sydney',
    'address'     => '159-175 Church St, Parramatta NSW 2150',
    'description' => <<<'TXT'
A slow lap of all four levels of Westfield Parramatta, collecting for the Sydney Children's Hospitals Foundation. The centre has given us the run of the malls for the morning and the foundation's volunteers will walk with us carrying the buckets - we stop for photos, they do the asking.

[b]Schedule[/b]
[list]
[*]09:15 - Arrive at the loading dock off Marsden St and kit up in the staff room
[*]10:00 - Walk steps off from the Church St entrance
[*]12:00 - Twenty minute break back in the staff room
[*]13:30 - Final lap and group photo in the Level 3 dining precinct
[*]14:00 - Finish and de-kit
[/list]

[b]Bring[/b]
[list]
[*]Full kit - helmets stay on inside the centre
[*]Water; the atrium gets warm by midday
[*]Civvies for the debrief at the food court afterwards
[/list]

[b]Parking[/b]
Park on Level 5 of the Marsden St car park and give your plate to the coordinator on arrival - the centre validates it for the day.

Handlers will meet us at the loading dock. The route is flat, with lifts between levels, so it suits anybody still breaking in new boots.
TXT
    ,
    'start_date'  => demo_at(21, '10:00:00'),
    'end_date'    => demo_at(21, '14:00:00'),
    'days'        => demo_days(21, 21, '10:00:00', '14:00:00'),
));
note('nobody signed up yet', $id);

// 2. The big one: a three day convention, 15 troopers and 2 wranglers, and a roster where
//    people have picked different days - which is what the attendance sheet's day filter
//    and the per-day counts exist for.
$id = demo_event(array(
    'title'       => 'Supanova Sydney',
    'region'      => 'Sydney',
    'address'     => 'Sydney Showground, 1 Showground Rd, Sydney Olympic Park NSW 2127',
    'description' => <<<'TXT'
Our largest deployment of the year: three days on the Supanova floor in the Dome and Exhibition Halls, with a garrison booth, a photo backdrop and a charity collection for the Starlight Children's Foundation running all weekend.

[b]What we are doing[/b]
[list]
[*]Garrison booth in Hall 4 - photos with the public for a gold coin donation to Starlight
[*]Two floor patrols each hour, in groups of at least three plus a handler
[*]The Saturday 2pm costume parade on the main stage
[*]Sunday afternoon kids' "trooper training" session beside the booth
[/list]

[b]Shift pattern[/b]
Two hours on, one hour off. The cooling room is behind the main stage, with water, fans and somewhere to sit down out of your armour. The roster for each day goes up on the booth wall at 08:30.

[b]Arrival and passes[/b]
Exhibitor wristbands are collected from the Gate 3 loading dock between 07:30 and 08:30. Your name has to be on the list the organisers receive, which is built from this signup - if you are not signed up for a day, there is no wristband for you that day.

[b]Parking[/b]
The P1 car park beside the Dome. The garrison's parking passes are handed out with the wristbands.

Pick only the days you can actually make - the roster is built from what you select here.
TXT
    ,
    'start_date'  => demo_at(35, '09:00:00'),
    'end_date'    => demo_at(37, '17:00:00'),
    'days'        => demo_days(35, 37, '09:00:00', '17:00:00'),
));

$big_roster = array_merge(array_slice($TROOPERS, 0, 13), array('trooper1', 'trooper2'));
foreach($big_roster as $index => $username)
{
    // A spread of full-weekend, two-day and single-day attendance.
    $days = array(0, 1, 2);
    if($index % 4 === 1)
    {
        $days = array(0);
    }
    elseif($index % 4 === 2)
    {
        $days = array(1, 2);
    }

    demo_signup($id, $username, array('days' => $days));
}

demo_signup($id, 'RaySutton', array('roles' => array('wrangler')));
demo_signup($id, 'wrangler', array('roles' => array('wrangler'), 'days' => array(0, 1)));

note('15 troopers + 2 wranglers, mixed days', $id);

// 3. WWCC required: the roster is all WWCC holders, and the two members without one are
//    left off so the gate has somebody to turn away.
$id = demo_event(array(
    'title'         => "Children's Hospital Ward Visit",
    'region'        => 'Sydney',
    'address'       => 'Cnr Hainsworth St & Hawkesbury Rd, Westmead NSW 2145',
    'description'   => <<<'TXT'
An afternoon visit to the long-stay wards at the Children's Hospital at Westmead, arranged with the hospital's Starlight Express Room. We visit the Express Room first, then go ward to ward in small groups with a play therapist.

[b]A current WWCC is required[/b] - the hospital checks every name before the day, and anybody without one on their profile will not be let past reception.

[b]On the wards[/b]
[list]
[*]Quiet voices and no blasters drawn indoors
[*]Follow the play therapist's lead - some kids want a high five, some want to be left alone
[*]Hand sanitiser on the way into every room, gloves and all
[*]No photos of patients unless a parent asks you to take one on their phone
[/list]

[b]Arrival[/b]
Meet at the main entrance on Hawkesbury Rd at 12:30. The hospital has given us a meeting room on Level 1 to kit up in. Park in the multi-storey car park; the Starlight team will hand out exit passes.

Please do not sign up if you have been unwell in the last 48 hours. The hospital would rather we were one short than bring anything onto the wards.
TXT
    ,
    'start_date'    => demo_at(14, '13:00:00'),
    'end_date'      => demo_at(14, '16:00:00'),
    'requires_wwcc' => 1,
    'days'          => demo_days(14, 14, '13:00:00', '16:00:00'),
));
foreach(array('AlexVoss', 'BriannaKade', 'DanaOkoye', 'FreyaLind', 'trooper1') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'TeganMoss', array('roles' => array('wrangler')));
note('WWCC required (nowwcc is turned away)', $id);

// 4. A region with an announcement forum of its own, so the demo can show the thread
//    landing somewhere other than the default.
$id = demo_event(array(
    'title'       => 'Hunter Valley Toy Run',
    'region'      => 'Hunter',
    'address'     => 'Maitland Park, Maitland NSW 2320',
    'description' => <<<'TXT'
Riding with the Hunter motorcycle clubs on their annual toy run, which delivers donated toys to the children's wards at John Hunter and Maitland hospitals and to the Salvation Army's Christmas appeal.

[b]How it works[/b]
We travel in the support vehicles at the back of the convoy rather than on bikes. At each stop we get out, carry the toys in with the riders and spend twenty minutes on photos before moving on.

[b]Schedule[/b]
[list]
[*]08:30 - Meet at the Maitland Park rotunda, kit up in the scout hall
[*]09:00 - Convoy departs
[*]10:30 - Maitland Hospital
[*]12:30 - Lunch at the Kurri Kurri clubhouse (supplied by the clubs)
[*]14:00 - John Hunter Hospital, then back to Maitland Park
[/list]

[b]Bring[/b]
[list]
[*]An unwrapped toy for the collection
[*]Sunscreen and water - there is a lot of standing about in the sun between stops
[*]A change of clothes; we travel between stops out of armour
[/list]

The clubs have asked for a final headcount the Wednesday before, so please sign up by then.
TXT
    ,
    'start_date'  => demo_at(28, '08:30:00'),
    'end_date'    => demo_at(28, '15:00:00'),
    'days'        => demo_days(28, 28, '08:30:00', '15:00:00'),
));
foreach(array('GusHolloway', 'HanaMorrow', 'IvanPetrov', 'JadeNkemdi', 'KaiWhitfield', 'LenaBauer') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'RaySutton', array('roles' => array('wrangler')));
note('Hunter region - own announcement forum', $id);

// 5. Two days, with signups still open but closing well before the event.
$id = demo_event(array(
    'title'         => 'Canberra Comic Con',
    'region'        => 'Canberra',
    'address'       => 'Exhibition Park, 1 Flemington Rd, Mitchell ACT 2911',
    'description'   => <<<'TXT'
Two days on the convention floor at Exhibition Park, sharing a booth with the interstate garrisons and the Rebel Legion. The con is donating a share of its photo-op takings to Canberra Hospital Foundation, and our booth photos go into the same pot.

[b]Numbers close early[/b] - the venue needs the crew list a fortnight out to print passes, and nobody can be added after that.

[b]What we are doing[/b]
[list]
[*]Shared booth in the main pavilion, photos with the public all day
[*]A combined 501st/Rebel Legion walk through the hall at 11:00 and 15:00 each day
[*]The Saturday evening cosplay competition - we are guests on the judging panel
[/list]

[b]Travel and accommodation[/b]
It is a three hour drive from Sydney. Car pools are organised in the thread below; the garrison has a group rate at the motel across Flemington Rd - mention the 501st when you book.

[b]Arrival[/b]
Crew passes are collected from the Coorong Pavilion office from 08:00. Park in the exhibitor car park behind the pavilion.
TXT
    ,
    'start_date'    => demo_at(60, '09:00:00'),
    'end_date'      => demo_at(61, '18:00:00'),
    'signup_cutoff' => demo_at(50, '23:59:00'),
    'days'          => demo_days(60, 61, '09:00:00', '18:00:00'),
));
demo_signup($id, 'MarcusHale');
demo_signup($id, 'NadiaFarrow', array('days' => array(0)));
demo_signup($id, 'OscarBright', array('days' => array(1)));
demo_signup($id, 'PiaSolano');
demo_signup($id, 'trooper2', array('roles' => array('trooper', 'wrangler')));
note('cutoff still open, closes before the event', $id);

// 6. Cutoff already passed: signups are locked, but the roster that made it in is intact.
$id = demo_event(array(
    'title'         => 'Blacktown Relay For Life',
    'region'        => 'Sydney',
    'address'       => 'Blacktown International Sportspark, Eastern Rd, Rooty Hill NSW 2766',
    'description'   => <<<'TXT'
Joining the opening of Cancer Council's Relay For Life at Blacktown. We lead the Survivors' and Carers' Lap after the opening ceremony, then walk the first hour of the relay with the teams before handing over to the garrison's own relay team, who carry on through the night.

[b]Signups have closed[/b] - Cancer Council needed the names for the opening ceremony run sheet.

[b]Schedule[/b]
[list]
[*]09:15 - Meet at the athletics centre change rooms
[*]10:00 - Opening ceremony
[*]10:20 - Survivors' and Carers' Lap - walk at their pace, not ours
[*]10:45 - Relay laps and photos at the team tents
[*]12:00 - Finish
[/list]

[b]Donations[/b]
The garrison's relay team page is linked in the thread below. Anything raised on the day goes to cancer research, prevention and support services.

Parking is free in the Eastern Rd car park. The track is fully exposed, so bring water and sunscreen for your handler.
TXT
    ,
    'start_date'    => demo_at(10, '10:00:00'),
    'end_date'      => demo_at(10, '12:00:00'),
    'signup_cutoff' => demo_at(-1, '17:00:00'),
    'days'          => demo_days(10, 10, '10:00:00', '12:00:00'),
));
foreach(array('AlexVoss', 'EliTanaka', 'HanaMorrow') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'TeganMoss', array('roles' => array('wrangler')));
note('signups locked - cutoff has passed', $id);

// 7. Exclusions: three members cannot see this event, its pages, its feed or its
//    announcement thread.
$id = demo_event(array(
    'title'       => 'Starlight Foundation Charity Gala',
    'region'      => 'Other',
    'address'     => 'Doltone House, 48 Pirrama Rd, Pyrmont NSW 2009',
    'description' => <<<'TXT'
The Starlight Children's Foundation's annual fundraising gala. We line the arrival walk, stand in for photos at the step-and-repeat, and escort the auction's headline lot - a signed helmet donated by the garrison - onto the stage.

[b]This one is invitation-only.[/b] Numbers are fixed by the foundation and security has the guest list, so it is not open to the whole garrison. If you can see this event you are on the list.

[b]Schedule[/b]
[list]
[*]17:15 - Arrive at the Pirrama Rd service entrance and kit up in the green room
[*]18:00 - Guest arrivals
[*]19:30 - Auction; the helmet lot is around 20:15
[*]20:45 - Photos with the table sponsors
[*]21:30 - Released; stay for dinner in the green room if you like
[/list]

[b]Handlers[/b]
Black tie. The venue will not admit handlers in anything less.

[b]Parking[/b]
The foundation has reserved spaces in the Star car park on Pirrama Rd. Your coordinator will PM the code.
TXT
    ,
    'start_date'  => demo_at(18, '18:00:00'),
    'end_date'    => demo_at(18, '23:00:00'),
    'exclusions'  => 'excluded,MarcusHale,PiaSolano',
    'days'        => demo_days(18, 18, '18:00:00', '23:00:00'),
));
foreach(array('BriannaKade', 'CarloRen', 'DanaOkoye') as $username)
{
    demo_signup($id, $username);
}
note('3 members excluded (region "Other" - default forum)', $id);

// 8. Pending: coordinators only, and deliberately unannounced.
$id = demo_event(array(
    'title'       => 'SMASH! Sydney Anime Convention (draft)',
    'region'      => 'Sydney',
    'status'      => 'pending',
    'address'     => 'To be confirmed',
    'description' => <<<'TXT'
Draft - the organisers have invited us back, but the hall and the date are not confirmed yet.

[b]Still to settle[/b]
[list]
[*]Which hall - they are choosing between two venues
[*]Whether we get a booth or only floor walks
[*]Whether their charity partner will take a garrison collection at the booth
[/list]

[b]Plan if it goes ahead[/b]
One evening session on the Saturday: floor walks in pairs, the cosplay parade at 20:00, and photos at the booth. Anime crossover costumes are welcome if the organisers agree.

Members cannot see this one until it goes live.
TXT
    ,
    'start_date'  => demo_at(45, '19:00:00'),
    'end_date'    => demo_at(45, '21:00:00'),
    'days'        => demo_days(45, 45, '19:00:00', '21:00:00'),
));
note('pending - coordinators only, no announcement', $id);

// 9. Over, trooped, and the troop report still owing.
$id = demo_event(array(
    'title'       => 'Make-A-Wish Charity Screening',
    'region'      => 'Sydney',
    'address'     => 'Event Cinemas, 505-525 George St, Sydney NSW 2000',
    'description' => <<<'TXT'
A fundraising screening of the Star Wars saga for Make-A-Wish Australia, with every ticket sold going towards granting wishes. Before the film we line the red carpet in the George St foyer, pose for photos with ticket holders and the wish kids and their families, and escort the evening's wish kid into the cinema.

[b]Schedule[/b]
[list]
[*]16:30 - Meet at the Bathurst St staff entrance, kit up in the function room
[*]17:00 - Red carpet opens
[*]18:45 - Escort into Cinema 1 and a short welcome on stage
[*]19:00 - Film starts - you are free to de-kit and stay
[/list]

[b]Bring[/b]
[list]
[*]Full kit, with a spare set of gloves - the foyer lights show every mark
[*]Something warm for afterwards; the cinema is cold
[/list]

Anybody staying for the film has a ticket held under their name at the box office, courtesy of Make-A-Wish.
TXT
    ,
    'start_date'  => demo_at(-7, '17:00:00'),
    'end_date'    => demo_at(-7, '22:00:00'),
    'days'        => demo_days(-7, -7, '17:00:00', '22:00:00'),
));
foreach(array('AlexVoss', 'CarloRen', 'EliTanaka', 'GusHolloway', 'IvanPetrov', 'KaiWhitfield', 'trooper1', 'trooper2') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'RaySutton', array('roles' => array('wrangler')));

// The administrator troops this one as well, so the report can be written from the account
// the plugin is being demonstrated from - events_can_create_troop_report() asks for a
// trooper signup on a finished event, and an administrator has no other way to get one.
// The costume is recorded against the signup rather than on their profile, which is where
// events_save_signup() puts costumes anyway, so nothing about the account is touched.
//
// They are in neither the garrison nor the 501st group, so they also land in the draft's
// third bucket - the one no other demo roster fills.
if($ADMIN_USERNAME !== null)
{
    demo_signup($id, $ADMIN_USERNAME, array('costumes' => array($costumes[0])));
}

note('finished - troop report owing, admin rostered to write it', $id);

// 10. The full cycle: over, trooped, reported.
$id = demo_event(array(
    'title'       => 'Centennial Park Charity Fun Run',
    'region'      => 'Sydney',
    'address'     => 'Centennial Park, Grand Dr, Centennial Park NSW 2021',
    'description' => <<<'TXT'
A 5km fun run around Grand Drive raising money for Ronald McDonald House Charities, which houses families from the country while their children are in Sydney hospitals. We do not run it in armour - we hold the start line, cheer on the course and hand out medals at the finish.

[b]Where we stand[/b]
[list]
[*]Start line - photos with runners in the start chute, then the countdown from the stage
[*]Halfway point at the Busby's Pond turn - the cheer squad
[*]Finish line - medals and the photo backdrop
[/list]

[b]Schedule[/b]
[list]
[*]07:15 - Meet at the Paddington Gates, kit up in the marquee behind the stage
[*]08:00 - Start
[*]08:15 - Split into start, halfway and finish groups
[*]10:30 - Presentations, then photos until the crowd thins out
[/list]

[b]Bring[/b]
Water, sunscreen and a hat for your handler. There is almost no shade at the finish.

Want to actually run it? Register under the garrison's team name and the fee goes to the charity too.
TXT
    ,
    'start_date'  => demo_at(-30, '08:00:00'),
    'end_date'    => demo_at(-30, '13:00:00'),
    'days'        => demo_days(-30, -30, '08:00:00', '13:00:00'),
));
foreach(array('AlexVoss', 'BriannaKade', 'DanaOkoye', 'FreyaLind', 'HanaMorrow',
              'JadeNkemdi', 'LenaBauer', 'NadiaFarrow', 'OscarBright', 'trooper1') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'wrangler', array('roles' => array('wrangler')));
demo_troop_report(events_get_event($id), 'AlexVoss',
    "Ten of us turned out for the fun run, plus one wrangler keeping the water coming.\n\n"
  . "[b]Attendance:[/b] 10 troopers, 1 wrangler\n"
  . "[b]Charity:[/b] Ronald McDonald House Charities\n\n"
  . "Around 1,200 runners this year. We split three ways as planned - start line, Busby's Pond and the"
  . " finish - and the medal table at the finish was the busiest photo spot of the morning. No kit"
  . " failures and no heat casualties. The organisers told us the run raised a record amount and have"
  . " already asked us back next year. Photos are with the media team.");
note('finished - troop report posted', $id);

// 11. Archived: hidden from the listing until the filter asks for it.
$id = demo_event(array(
    'title'       => 'Comic-Gong',
    'region'      => 'Sydney',
    'status'      => 'archived',
    'address'     => 'WIN Entertainment Centre, Wollongong NSW 2500',
    'description' => <<<'TXT'
Two days at Wollongong's pop culture convention, with a photo booth collecting for the Illawarra Children's Hospital appeal and a guest spot in the Sunday cosplay parade.

[b]Arrival[/b]
Crew entry is through the Crown St loading dock from 08:00. Parking is in the WIN Stadium car park next door.

[b]Getting there[/b]
The train from Central takes about ninety minutes and stops a short walk from the venue. Car pools are organised in the thread below.

Kept for the record now the weekend is over.
TXT
    ,
    'start_date'  => demo_at(-120, '09:00:00'),
    'end_date'    => demo_at(-119, '17:00:00'),
    'days'        => demo_days(-120, -119, '09:00:00', '17:00:00'),
));
foreach(array('AlexVoss', 'FreyaLind', 'PiaSolano') as $username)
{
    demo_signup($id, $username);
}
note('archived - hidden unless the filter asks', $id);

// 12. Happening right now: the listing and calendar both mark it, and signups are still
//     open because the event has not ended.
$id = demo_event(array(
    'title'       => "Kids' Cancer Project Collection Day",
    'region'      => 'Sydney',
    'address'     => 'Tumbalong Park, Darling Harbour, Sydney NSW 2000',
    'description' => <<<'TXT'
A full day on the Darling Harbour boardwalk collecting for The Kids' Cancer Project, which funds research into childhood cancer. We pose for photos, the charity's volunteers carry the buckets, and the passing school holiday crowd does the rest.

[b]Shifts[/b]
Come for as much of the day as you can. It runs in three-hour blocks - 09:00, 12:00, 15:00 and 18:00 - and the evening block covers the fireworks crowd, which is when the buckets fill fastest.

[b]Base[/b]
The charity's marquee on the Tumbalong Park lawn, with a screened-off area to kit up and cool down in. Water and snacks provided.

[b]Getting there[/b]
Light rail to Exhibition Centre, or park in the Harbourside car park and ask the coordinator for a validation sticker.

It is in progress now - if you can come down for a block this afternoon, sign up and let the coordinator know you are on your way.
TXT
    ,
    'start_date'  => demo_at(0, '09:00:00'),
    'end_date'    => demo_at(0, '21:00:00'),
    'days'        => demo_days(0, 0, '09:00:00', '21:00:00'),
));
foreach(array('BriannaKade', 'GusHolloway', 'LenaBauer') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'TeganMoss', array('roles' => array('wrangler')));
note('happening today', $id);

// 13. Tomorrow, so the listing has something imminent above the fold.
$id = demo_event(array(
    'title'       => 'Macquarie Centre Legacy Badge Day',
    'region'      => 'Sydney',
    'address'     => 'Cnr Herring & Waterloo Rds, North Ryde NSW 2113',
    'description' => <<<'TXT'
Standing with the Legacy badge sellers at Macquarie Centre for Legacy Badge Day. Legacy supports the families of veterans who died or were injured in service, and a trooper beside the table reliably doubles the number of people who stop.

[b]Arrival[/b]
Meet at the food court entrance on Level 3 at 10:30. Centre management will walk us to a storeroom to kit up in.

[b]On the day[/b]
[list]
[*]Two stations - the Level 1 entrance by the ice rink, and the Level 3 food court
[*]Swap stations at 13:00
[*]Short breaks back in the storeroom whenever you need one
[/list]

[b]Parking[/b]
Any of the centre's car parks - the first three hours are free, and the centre will validate the rest.
TXT
    ,
    'start_date'  => demo_at(1, '11:00:00'),
    'end_date'    => demo_at(1, '15:00:00'),
    'days'        => demo_days(1, 1, '11:00:00', '15:00:00'),
));
foreach(array('IvanPetrov', 'JadeNkemdi', 'OscarBright') as $username)
{
    demo_signup($id, $username);
}
note('tomorrow', $id);

// 14. Wranglers only: no troopers at all, which is the other end of the role split.
$id = demo_event(array(
    'title'       => 'Toy Drive Wrapping Day',
    'region'      => 'Sydney',
    'address'     => 'Unit 4, 12 Carrington Rd, Marrickville NSW 2204',
    'description' => <<<'TXT'
Sorting, wrapping and labelling everything donated to the garrison's Christmas toy drive, ready for the Salvation Army to collect. Last year it came to over four hundred gifts and took two full days, so every pair of hands makes a difference.

[b]No kit required[/b] - this one is for handlers, helpers, family and anybody still building their armour.

[b]What happens[/b]
[list]
[*]Morning - sort the donations by age group and check nothing is broken or missing batteries
[*]Lunch - pizza, on the garrison
[*]Afternoon - wrap, label by age and gender, and box up for the Salvos' truck at 16:00
[/list]

[b]Bring[/b]
Scissors and sticky tape if you have them. Wrapping paper and tags are provided, courtesy of the donations.

The workshop has street parking out front and is a ten minute walk from Sydenham station.
TXT
    ,
    'start_date'  => demo_at(25, '10:00:00'),
    'end_date'    => demo_at(25, '16:00:00'),
    'days'        => demo_days(25, 25, '10:00:00', '16:00:00'),
));
foreach(array('RaySutton', 'TeganMoss', 'wrangler') as $username)
{
    demo_signup($id, $username, array('roles' => array('wrangler')));
}
note('wranglers only, no troopers', $id);

// 15. A second WWCC event, so the gate is not something the demo shows only once - and
//     this one is open for signups now, where the ward visit is close enough to its date
//     that it reads as already settled.
$id = demo_event(array(
    'title'         => 'Camp Quality Family Fun Day',
    'region'        => 'Sydney',
    'address'       => 'Bella Vista Farm Park, Norwest Blvd, Baulkham Hills NSW 2153',
    'description'   => <<<'TXT'
Camp Quality's family day for children living with cancer and their brothers and sisters: a morning of rides, face painting and a sausage sizzle, and this year a visit from the Empire. We parade in at the start, then spend the morning on photos and games with the kids.

[b]A current WWCC is required[/b] - Camp Quality collects numbers from everybody attending before the day.

[b]Schedule[/b]
[list]
[*]08:30 - Meet at the woolshed, kit up behind the stage
[*]09:00 - March in with the Camp Quality mascots
[*]09:30 - Photos, trooper training and a tug-of-war the kids are allowed to win
[*]12:30 - Finish
[/list]

[b]Please note[/b]
[list]
[*]Some of the children are immunosuppressed - do not come if you are unwell
[*]Helmets off if a child is frightened; a face usually settles them
[*]No photos of the families on personal phones - Camp Quality's photographer covers the day
[/list]

The park is on grass and gravel, so expect some dust on your boots.
TXT
    ,
    'start_date'    => demo_at(20, '09:00:00'),
    'end_date'      => demo_at(20, '12:30:00'),
    'requires_wwcc' => 1,
    'days'          => demo_days(20, 20, '09:00:00', '12:30:00'),
));
foreach(array('CarloRen', 'EliTanaka', 'JadeNkemdi') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'RaySutton', array('roles' => array('wrangler')));
note('WWCC required, signups open now', $id);

// 16. Supanova's shape at a tenth of the size: multi-day, mixed day selection, a wrangler -
//     but a roster small enough that the attendance sheet and the per-day counts can be
//     read at a glance rather than scrolled through.
$id = demo_event(array(
    'title'       => 'Penrith Pop Culture Fair',
    'region'      => 'Sydney',
    'address'     => 'Penrith Panthers, 123 Mulgoa Rd, Penrith NSW 2750',
    'description' => <<<'TXT'
A two day suburban con - one hall, one photo backdrop, and a much quieter weekend than Supanova. The organisers are giving the gate takings from the first hour of each day to the Nepean Hospital children's ward, and we are the photo opportunity they are advertising it with.

[b]What we are doing[/b]
[list]
[*]Photo backdrop by the entrance, gold coin donation per photo
[*]One walk through the traders' hall each hour
[*]Judging the kids' costume competition at 14:00 on the Sunday
[/list]

[b]Shift pattern[/b]
Two hours on, one hour off, same as always. The Panthers have given us a function room upstairs to change and cool down in.

[b]Parking[/b]
Free in the Panthers car park. Use the rear entrance off Ransley St to reach the function room lift.

Pick only the days you can actually make - the roster is built from what you select here.
TXT
    ,
    'start_date'  => demo_at(42, '10:00:00'),
    'end_date'    => demo_at(43, '16:00:00'),
    'days'        => demo_days(42, 43, '10:00:00', '16:00:00'),
));
demo_signup($id, 'GusHolloway');
demo_signup($id, 'LenaBauer', array('days' => array(0)));
demo_signup($id, 'MarcusHale', array('days' => array(1)));
demo_signup($id, 'NadiaFarrow');
demo_signup($id, 'OscarBright', array('days' => array(0)));
demo_signup($id, 'PiaSolano', array('days' => array(1)));
demo_signup($id, 'TeganMoss', array('roles' => array('wrangler')));
note('6 troopers + 1 wrangler, mixed days', $id);

// 17. Full, with a waitlist already forming. Places go in signup order, so the first four
//     troopers here are attending and the fifth is waitlisted. The single wrangler place
//     is taken as well, so anybody signing up in either role joins the back of a queue.
//     trooper1 and trooper2 are deliberately left off, so either can sign in and see it.
$id = demo_event(array(
    'title'         => 'Castle Hill Rotary Charity Fair',
    'region'        => 'Sydney',
    'address'       => 'Castle Hill Showground, Doran Dr, Castle Hill NSW 2154',
    'description'   => <<<'TXT'
The Castle Hill Rotary Club's spring fair, with rides, market stalls and a dog show, and everything raised going to the Rotary club's local youth and mental health projects. We have a photo tent next to the main arena.

[b]The organisers can only fit four of us[/b] in the photo tent, plus one handler. If you are on the waitlist and a place opens up, you will be moved up automatically and sent a PM.

[b]Schedule[/b]
[list]
[*]09:30 - Meet at the pavilion behind the photo tent, kit up
[*]10:00 - Photo tent opens, gold coin donation per photo
[*]12:00 - A lap of the main arena before the dog show
[*]14:00 - Finish
[/list]

Parking is free inside the showground - tell the gate you are with the photo tent and they will wave you through to the pavilion.
TXT
    ,
    'start_date'    => demo_at(12, '10:00:00'),
    'end_date'      => demo_at(12, '14:00:00'),
    'days'          => demo_days(12, 12, '10:00:00', '14:00:00'),
    'max_troopers'  => 4,
    'max_wranglers' => 1,
));
foreach(array('DanaOkoye', 'FreyaLind', 'HanaMorrow', 'KaiWhitfield', 'OscarBright') as $username)
{
    demo_signup($id, $username);
}
demo_signup($id, 'TeganMoss', array('roles' => array('wrangler')));
note('full - 4/4 troopers + 1 waitlisted, 1/1 wranglers', $id);

// 18. One place left: the next trooper to sign up takes it, and the one after that is
//     waitlisted - which is how the waitlist is shown happening rather than already there.
//     Sign in as trooper1 to take the last place, then as trooper2 to be waitlisted behind them.
$id = demo_event(array(
    'title'        => 'Hornsby Brick Show',
    'region'       => 'Sydney',
    'address'      => 'Hornsby RSL, 4 High St, Hornsby NSW 2077',
    'description'  => <<<'TXT'
A weekend LEGO fan exhibition, with club layouts, a kids' build zone and, this year, a full-size Death Star trench run built by the local LUG. We are guests of the show on the Saturday morning, posing with the Star Wars displays and the builders.

The hall has room for [b]four troopers[/b] - once those places are taken, further signups go on the waitlist.

[b]Schedule[/b]
[list]
[*]09:30 - Meet at the RSL's function room entrance, kit up in the committee room
[*]10:00 - Doors open - photos at the trench run and the Star Wars layouts
[*]11:30 - Judging the kids' build challenge
[*]13:00 - Finish
[/list]

[b]Please note[/b]
The displays are fragile and the aisles are narrow. Keep blasters holstered and mind your backpacks and belts near the tables.

Parking is available under the RSL, or it is a five minute walk from Hornsby station.
TXT
    ,
    'start_date'   => demo_at(16, '10:00:00'),
    'end_date'     => demo_at(16, '13:00:00'),
    'days'         => demo_days(16, 16, '10:00:00', '13:00:00'),
    'max_troopers' => 4,
));
foreach(array('BriannaKade', 'GusHolloway', 'PiaSolano') as $username)
{
    demo_signup($id, $username);
}
note('3/4 troopers - one place left before the waitlist', $id);

// ---------------------------------------------------------------------------

echo "\n";
out(sprintf('%d events seeded, %d demo members (password: %s)', count($seeded), count($TROOPERS) + count($WRANGLERS), $DEMO_PASSWORD));
out('sign in as "gec" to see the coordinator pages, or any member above to sign up.');
echo "\nSEED OK\n";

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
 * would bake fourteen demo events, eighteen demo members and their announcement threads
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
 * The costume list the board actually offers, read from the mapped profile field so the
 * demo never signs anybody up in a costume the field would not let them pick.
 *
 * @return array
 */
function demo_costume_options()
{
    global $db;

    static $options = null;

    if($options !== null)
    {
        return $options;
    }

    $options = array();

    $fid = (int)events_get_setting('costume_field');
    if($fid)
    {
        $field = $db->fetch_array($db->simple_select('profilefields', 'type', 'fid = ' . $fid));
        if($field)
        {
            // MyBB stores a multiselect as "multiselect\noption\noption".
            $lines = preg_split('/\r\n|\r|\n/', (string)$field['type']);
            array_shift($lines);
            $options = array_values(array_filter(array_map('trim', $lines), 'strlen'));
        }
    }

    if(!$options)
    {
        fail('no costume options are configured - run scripts/provision.php first.');
    }

    return $options;
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

$uids = array();

foreach($TROOPERS as $index => $username)
{
    $fields = array(
        'tk_id'             => sprintf('TK-%05d', 31000 + $index),
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
    'description' => "A gentle shopping centre walk raising money for the children's ward.\n\n"
                   . "[b]Bring:[/b]\n[list][*]Full kit, helmets on inside the centre[*]Water - the atrium gets warm"
                   . "[*]Civvies for the debrief afterwards[/list]\n\n"
                   . "Handlers will meet us at the loading dock. Parking is validated.",
    'start_date'  => demo_at(21, '10:00:00'),
    'end_date'    => demo_at(21, '14:00:00'),
    'days'        => demo_days(21, 21, '10:00:00', '14:00:00'),
));
note('nobody signed up yet', $id);

// 2. The big one: a three day convention, 15 troopers and 2 wranglers, and a roster where
//    people have picked different days - which is what the attendance sheet's day filter
//    and the per-day counts exist for.
$id = demo_event(array(
    'title'       => 'Sydney Royal Easter Show - Weekend Deployment',
    'region'      => 'Sydney',
    'address'     => 'Sydney Showground, 1 Showground Rd, Sydney Olympic Park NSW 2127',
    'description' => "Our largest deployment of the year. Three days, rotating shifts, full garrison turnout.\n\n"
                   . "[b]Shift pattern:[/b] two hours on, one hour off. The cooling room is behind the main stage.\n\n"
                   . "Pick only the days you can actually make - the roster is built from what you select here.",
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
    'description'   => "Ward visit for the long-stay kids. [b]A current WWCC is required[/b] - the hospital checks.\n\n"
                     . "Quiet voices, no blasters drawn indoors, and follow the play therapist's lead.",
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
    'description' => "Riding with the Hunter clubs to deliver toys to the local hospitals.\n\n"
                   . "Meet at the park at 08:30 for a 09:00 departure. Bring an unwrapped toy.",
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
    'title'         => 'Canberra Supanova',
    'region'        => 'Canberra',
    'address'       => 'Exhibition Park, 1 Flemington Rd, Mitchell ACT 2911',
    'description'   => "Two days on the convention floor with the interstate garrisons.\n\n"
                     . "[b]Numbers close early[/b] - the venue needs the crew list a fortnight out.",
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
    'title'         => 'Blacktown Library Reading Day',
    'region'        => 'Sydney',
    'address'       => '3 Flushcombe Rd, Blacktown NSW 2148',
    'description'   => "Reading picture books to the under-fives. Signups have closed - the library has the list.",
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
    'title'       => 'Private Function - Corporate Gala',
    'region'      => 'Other',
    'address'     => 'Doltone House, 48 Pirrama Rd, Pyrmont NSW 2009',
    'description' => "Invitation-only evening function. Numbers are fixed by the client, so this one is"
                   . " not open to the whole garrison.\n\n[b]Black tie for the handlers.[/b]",
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
    'title'       => 'Garrison Planning Meeting (draft)',
    'region'      => 'Sydney',
    'status'      => 'pending',
    'address'     => 'To be confirmed',
    'description' => "Draft - still chasing the venue and a date that suits the committee.\n\n"
                   . "Members cannot see this one until it goes live.",
    'start_date'  => demo_at(45, '19:00:00'),
    'end_date'    => demo_at(45, '21:00:00'),
    'days'        => demo_days(45, 45, '19:00:00', '21:00:00'),
));
note('pending - coordinators only, no announcement', $id);

// 9. Over, trooped, and the troop report still owing.
$id = demo_event(array(
    'title'       => 'Movie Premiere Red Carpet Escort',
    'region'      => 'Sydney',
    'address'     => 'Event Cinemas, 505-525 George St, Sydney NSW 2000',
    'description' => "Red carpet line-up and photos with the crowd before the doors opened.",
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
    'title'       => 'Anzac Day March',
    'region'      => 'Sydney',
    'address'     => 'Martin Place, Sydney NSW 2000',
    'description' => "Marching with the veterans' associations, as we do every year.",
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
    "Ten of us marched with the veterans' associations this year, plus one wrangler keeping the water up to us.\n\n"
  . "[b]Attendance:[/b] 10 troopers, 1 wrangler\n"
  . "[b]Charity:[/b] N/A - community event\n\n"
  . "The crowd along Martin Place was three deep by 09:00. No kit failures, no heat casualties, and the"
  . " RSL have already asked whether we will be back next year. Photos are with the media team.");
note('finished - troop report posted', $id);

// 11. Archived: hidden from the listing until the filter asks for it.
$id = demo_event(array(
    'title'       => 'Comic-Gong 2024',
    'region'      => 'Sydney',
    'status'      => 'archived',
    'address'     => 'WIN Entertainment Centre, Wollongong NSW 2500',
    'description' => "Last year's Wollongong convention. Kept for the record.",
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
    'title'       => 'Garrison Recruitment Stand',
    'region'      => 'Sydney',
    'address'     => 'Darling Harbour, Sydney NSW 2000',
    'description' => "Recruitment stand by the waterfront - in progress today.",
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
    'title'       => 'Macquarie Centre Mall Appearance',
    'region'      => 'Sydney',
    'address'     => 'Cnr Herring & Waterloo Rds, North Ryde NSW 2113',
    'description' => "Short mall appearance - meet at the food court entrance at 10:30.",
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
    'title'       => 'Costume Build Workshop',
    'region'      => 'Sydney',
    'address'     => 'Unit 4, 12 Carrington Rd, Marrickville NSW 2204',
    'description' => "Armour trimming and strapping session. [b]No kit required[/b] - this one is for helpers"
                   . " and anybody still building.\n\nTools provided. Bring your own strapping if you have it.",
    'start_date'  => demo_at(25, '10:00:00'),
    'end_date'    => demo_at(25, '16:00:00'),
    'days'        => demo_days(25, 25, '10:00:00', '16:00:00'),
));
foreach(array('RaySutton', 'TeganMoss', 'wrangler') as $username)
{
    demo_signup($id, $username, array('roles' => array('wrangler')));
}
note('wranglers only, no troopers', $id);

// ---------------------------------------------------------------------------

echo "\n";
out(sprintf('%d events seeded, %d demo members (password: %s)', count($seeded), count($TROOPERS) + count($WRANGLERS), $DEMO_PASSWORD));
out('sign in as "gec" to see the coordinator pages, or any member above to sign up.');
echo "\nSEED OK\n";

<?php
/**
 * Provisions the MyBB test forum with everything the Events plugin e2e suite needs:
 * custom profile fields, usergroups, forums, fixture users, and the plugin itself
 * (installed and activated through MyBB's real plugin code path).
 *
 * Run inside the web container:  docker compose exec -T web php /dev/stdin < scripts/provision.php
 * Idempotent: safe to run repeatedly.
 */

define('IN_MYBB', 1);
define('MYBB_ROOT', '/var/www/html/');
define('THIS_SCRIPT', 'provision.php');
define('NO_ONLINE', 1);

require_once MYBB_ROOT . 'inc/init.php';

// Surface the failing query when something goes wrong during provisioning.
$mybb->dev_mode = 1;
// Loaded as global.php does. UserDataHandler's timezone check reads the timezone names
// from it, and on PHP 8 each one missing is a logged warning rather than a silent notice.
$lang->set_language($mybb->settings['bblanguage']);
$lang->load('global');
require_once MYBB_ROOT . 'inc/functions_user.php';
require_once MYBB_ROOT . 'inc/datahandlers/user.php';

/** @var DB_MySQLi $db */
/** @var MyBB $mybb */
/** @var datacache $cache */
/** @var pluginSystem $plugins */

function out($msg) { echo "    " . $msg . "\n"; }
function fail($msg) { fwrite(STDERR, "PROVISION ERROR: " . $msg . "\n"); exit(1); }

// ---------------------------------------------------------------------------
// Board settings tuned for deterministic testing
// ---------------------------------------------------------------------------
$board_settings = array(
    // Fixed formats so the suite can assert on rendered dates.
    'dateformat'         => 'Y-m-d',
    'timeformat'         => 'H:i',
    // Remove the anti-flood and anti-bot friction that makes UI tests flaky. The flood
    // check compares against the user's last post time, which the e2e suite routinely
    // leaves in the "future" by moving the clock, so it has to be off entirely.
    'postfloodcheck'     => '0',
    'postfloodsecs'      => '0',
    'searchfloodtime'    => '0',
    'failedlogincount'   => '0',
    'captchaimage'       => '0',
    'regtype'            => 'instant',
    'verifyemail'        => '0',
    'securityquestion'   => '0',
    'usereferrals'       => '0',
    // Threads/posts created by the troop report flow should be visible immediately.
    'threadreview'       => '0',
    'minmessagelength'   => '1',
    'maxmessagelength'   => '0',
    // Keep timestamps absolute rather than "2 hours ago" so clock travel is assertable.
    'dstcorrection'      => '0',
    'timezoneoffset'     => '0',
    'relativetime'       => '0',
    // Send PHP/SQL errors to a file the e2e suite can assert on.
    'errorlogmedium'     => 'log',
    'errorloglocation'   => './cache/mybb_errors.log',
);
foreach ($board_settings as $name => $value) {
    $db->update_query('settings', array('value' => $db->escape_string($value)), "name = '" . $db->escape_string($name) . "'");
}
rebuild_settings();
out('board settings applied');

// ---------------------------------------------------------------------------
// Custom profile fields
// ---------------------------------------------------------------------------
$costume_options = array('TK - Stormtrooper', 'TD - Sandtrooper', 'TB - Biker Scout', 'TI - TIE Pilot', 'DZ - Death Star Trooper');

$profile_field_specs = array(
    // Free text, one costume per line, because that is what the real board uses: nobody
    // maintains a complete list of approved 501st costumes, and a multiselect here made
    // the dev board the one place a costume had to be picked from a fixed set - which hid
    // the whole free-text path from the suite. The strings below are just the fixtures'
    // own costumes now, not the options the field offers; they are still published to
    // events-fixtures.json because the suite builds signups out of them.
    'costume' => array(
        'name' => 'Costumes',
        'description' => 'Costumes you own and can deploy, one per line',
        'type' => 'textarea',
    ),
    'legion_id' => array('name' => 'Legion ID', 'description' => 'Your 501st legion ID', 'type' => 'text'),
    'wwcc' => array('name' => 'WWCC Number', 'description' => 'Working With Children Check number', 'type' => 'text'),
    'mobile' => array('name' => 'Mobile Number', 'description' => 'Contact number for event days', 'type' => 'text'),
    'emergency_contact' => array('name' => 'Emergency Contact', 'description' => 'Who to call in an emergency', 'type' => 'text'),
    'preferred_name' => array('name' => 'Preferred Name', 'description' => 'What to call you on the day', 'type' => 'text'),
);

// The Legion ID field was provisioned as "TK ID"; rename it rather than adding a second one.
if (!$db->num_rows($db->simple_select('profilefields', 'fid', "name = 'Legion ID'"))) {
    $db->update_query('profilefields', array('name' => 'Legion ID'), "name = 'TK ID'");
}

$field_ids = array();
$disporder = 1;
foreach ($profile_field_specs as $key => $spec) {
    $existing = $db->fetch_array($db->simple_select('profilefields', 'fid', "name = '" . $db->escape_string($spec['name']) . "'"));
    if ($existing) {
        $field_ids[$key] = (int)$existing['fid'];
        // Keep the option list in sync if it changed since the last provision.
        $db->update_query('profilefields', array('type' => $db->escape_string($spec['type'])), 'fid = ' . (int)$existing['fid']);
        $disporder++;
        continue;
    }

    $row = array(
        'name' => $db->escape_string($spec['name']),
        'description' => $db->escape_string($spec['description']),
        'disporder' => $disporder++,
        'type' => $db->escape_string($spec['type']),
        'regex' => '',
        'length' => 0,
        'maxlength' => 0,
        'required' => 0,
        'registration' => 0,
        'profile' => 1,
        'viewableby' => '-1',
        'editableby' => '-1',
        'postbit' => 0,
        'postnum' => 0,
        'allowhtml' => 0,
        'allowmycode' => 0,
        'allowsmilies' => 0,
        'allowimgcode' => 0,
        'allowvideocode' => 0,
    );
    $fid = (int)$db->insert_query('profilefields', $row);
    $db->write_query('ALTER TABLE ' . TABLE_PREFIX . "userfields ADD fid{$fid} TEXT");
    $field_ids[$key] = $fid;
}
$cache->update_profilefields();
out('profile fields: ' . json_encode($field_ids));

// ---------------------------------------------------------------------------
// Usergroups (cloned from "Registered" so every column gets a sane value)
// ---------------------------------------------------------------------------
function provision_usergroup($title)
{
    global $db, $cache;

    $existing = $db->fetch_array($db->simple_select('usergroups', 'gid', "title = '" . $db->escape_string($title) . "'"));
    if ($existing) {
        return (int)$existing['gid'];
    }

    $template = $db->fetch_array($db->simple_select('usergroups', '*', 'gid = 2'));
    unset($template['gid']);
    $template['title'] = $title;
    $template['type'] = 2; // user-assignable additional group
    $template['namestyle'] = '{username}';
    $template['usertitle'] = '';
    $template['isbannedgroup'] = 0;
    $template['candisplaygroup'] = 1;

    foreach ($template as $k => $v) {
        $template[$k] = $db->escape_string((string)$v);
    }

    $gid = (int)$db->insert_query('usergroups', $template);
    $cache->update_usergroups();
    return $gid;
}

$groups = array(
    'gec' => provision_usergroup('Event Coordinators'),
    'garrison' => provision_usergroup('Garrison Members'),
    'legion' => provision_usergroup('501st Members'),
);
out('usergroups: ' . json_encode($groups));

// ---------------------------------------------------------------------------
// Forums
// ---------------------------------------------------------------------------
function provision_forum($name, $pid)
{
    global $db, $cache;

    $existing = $db->fetch_array($db->simple_select('forums', 'fid', "name = '" . $db->escape_string($name) . "'"));
    if ($existing) {
        return (int)$existing['fid'];
    }

    $row = array(
        'name' => $db->escape_string($name),
        'description' => $db->escape_string($name),
        'linkto' => '',
        'type' => 'f',
        'pid' => (int)$pid,
        'parentlist' => '',
        'disporder' => 10,
        'active' => 1,
        'open' => 1,
        'allowhtml' => 0,
        'allowmycode' => 1,
        'allowsmilies' => 1,
        'allowimgcode' => 1,
        'allowvideocode' => 1,
        'allowpicons' => 1,
        'allowtratings' => 1,
        'usepostcounts' => 1,
        'usethreadcounts' => 1,
        'requireprefix' => 0,
        'password' => '',
        'showinjump' => 1,
        'style' => 0,
        'overridestyle' => 0,
        'rulestype' => 0,
        'rulestitle' => '',
        'rules' => '',
        'defaultdatecut' => 0,
        'defaultsortby' => '',
        'defaultsortorder' => '',
    );
    $fid = (int)$db->insert_query('forums', $row);
    $db->update_query('forums', array('parentlist' => (int)$pid . ',' . $fid), 'fid = ' . $fid);
    $cache->update_forums();
    return $fid;
}

// MyBB's default install ships "My Category" (fid 1) and "My Forum" (fid 2).
$category = $db->fetch_array($db->simple_select('forums', 'fid', "type = 'c'", array('order_by' => 'fid', 'limit' => 1)));
$category_fid = $category ? (int)$category['fid'] : 1;

$general_forum = $db->fetch_array($db->simple_select('forums', 'fid', "type = 'f'", array('order_by' => 'fid', 'limit' => 1)));
$forums = array(
    'general' => $general_forum ? (int)$general_forum['fid'] : provision_forum('General Discussion', $category_fid),
    'troop_reports' => provision_forum('Troop Reports', $category_fid),
    // Event announcements are posted by the plugin into the forum its settings name for
    // the event's region, so the suite needs a default forum and a region-specific one
    // to tell the two routes apart.
    'events' => provision_forum('Event Announcements', $category_fid),
    'events_hunter' => provision_forum('Hunter Event Announcements', $category_fid),
);
out('forums: ' . json_encode($forums));

// ---------------------------------------------------------------------------
// Fixture users
// ---------------------------------------------------------------------------
$FIXTURE_PASSWORD = 'testpass123';

$users = array(
    // A coordinator: sees pending events, manages RSVPs and attendance sheets.
    'gec' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['gec'], $groups['garrison']),
        'fields' => array('legion_id' => 'TK-10001', 'wwcc' => 'WWCC-1001', 'mobile' => '0400 000 001', 'emergency_contact' => 'Jane Coordinator 0400 111 001', 'preferred_name' => 'Jan', 'costume' => array($costume_options[0])),
    ),
    // Fully-provisioned members: can RSVP without touching the prerequisites step.
    'trooper1' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['garrison']),
        'fields' => array('legion_id' => 'TK-20001', 'wwcc' => 'WWCC-2001', 'mobile' => '0400 000 002', 'emergency_contact' => 'Kin Trooper 0400 111 002', 'preferred_name' => 'Ash', 'costume' => array($costume_options[0], $costume_options[2])),
    ),
    'trooper2' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['legion']),
        'fields' => array('legion_id' => 'TK-20002', 'wwcc' => 'WWCC-2002', 'mobile' => '0400 000 003', 'emergency_contact' => 'Kin Trooper 0400 111 003', 'preferred_name' => 'Bex', 'costume' => array($costume_options[1])),
    ),
    // Deliberately missing every prerequisite - drives the prerequisites form tests.
    'newbie' => array(
        'usergroup' => 2,
        'additionalgroups' => array(),
        'fields' => array('costume' => array($costume_options[3])),
    ),
    // Has prerequisites but no WWCC - drives the WWCC-required branch.
    'nowwcc' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['garrison']),
        'fields' => array('legion_id' => 'TK-20004', 'mobile' => '0400 000 004', 'emergency_contact' => 'Kin Trooper 0400 111 004', 'preferred_name' => 'Cass', 'costume' => array($costume_options[4])),
    ),
    // A non-costumed helper: contactable, but no Legion ID, no WWCC and no costumes. Drives
    // the wrangler flow, and proves the costume step is skipped rather than empty.
    'wrangler' => array(
        'usergroup' => 2,
        'additionalgroups' => array(),
        'fields' => array('mobile' => '0400 000 006', 'emergency_contact' => 'Kin Wrangler 0400 111 006', 'preferred_name' => 'Dev'),
    ),
    // Used for the per-event exclusion tests.
    'excluded' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['garrison']),
        'fields' => array('legion_id' => 'TK-20005', 'wwcc' => 'WWCC-2005', 'mobile' => '0400 000 005', 'emergency_contact' => 'Kin Trooper 0400 111 005', 'preferred_name' => 'Eli', 'costume' => array($costume_options[0])),
    ),
);

$user_ids = array();
foreach ($users as $username => $spec) {
    $existing = $db->fetch_array($db->simple_select('users', 'uid', "username = '" . $db->escape_string($username) . "'"));
    if ($existing) {
        $uid = (int)$existing['uid'];
    } else {
        $handler = new UserDataHandler('insert');
        $handler->set_data(array(
            'username' => $username,
            'password' => $FIXTURE_PASSWORD,
            'password2' => $FIXTURE_PASSWORD,
            'email' => $username . '@example.test',
            'email2' => $username . '@example.test',
            'usergroup' => $spec['usergroup'],
            'regip' => '127.0.0.1',
            'lastip' => '127.0.0.1',
            'language' => '',
            'regdate' => TIME_NOW,
        ));
        if (!$handler->validate_user()) {
            fail("could not create user {$username}: " . implode('; ', $handler->get_friendly_errors()));
        }
        $info = $handler->insert_user();
        $uid = (int)$info['uid'];
    }

    $db->update_query('users', array(
        'usergroup' => (int)$spec['usergroup'],
        'additionalgroups' => implode(',', $spec['additionalgroups']),
    ), 'uid = ' . $uid);

    // Profile fields go straight into userfields; multiselect values are newline
    // separated, which is how MyBB's own datahandler stores them.
    $field_values = array();
    foreach ($spec['fields'] as $key => $value) {
        if (!isset($field_ids[$key])) {
            continue;
        }
        $field_values['fid' . $field_ids[$key]] = $db->escape_string(is_array($value) ? implode("\n", $value) : $value);
    }
    if ($field_values) {
        $has_row = $db->num_rows($db->simple_select('userfields', 'ufid', 'ufid = ' . $uid)) > 0;
        if ($has_row) {
            $db->update_query('userfields', $field_values, 'ufid = ' . $uid);
        } else {
            $field_values['ufid'] = $uid;
            $db->insert_query('userfields', $field_values);
        }
    }

    $user_ids[$username] = $uid;
}
out('users: ' . json_encode($user_ids));

// ---------------------------------------------------------------------------
// Install + activate plugins through MyBB's real plugin code path
// ---------------------------------------------------------------------------
/**
 * @param string $codename  the plugin's file/function prefix
 * @param string $missing   what to tell the operator when the file isn't there
 */
function provision_activate_plugin($codename, $missing)
{
    // A plugin file's top level is where MyBB plugins register their hooks, and it runs in
    // whatever scope requires it - here, this function's. Smart Thread Link calls
    // $plugins->add_hook() straight out of file scope, so without these the include fatals
    // on a null $plugins. The rest are imported for the same reason: what a plugin file
    // touches before its functions are called is its own business.
    global $plugins, $mybb, $db, $cache, $lang;

    $plugin_file = MYBB_ROOT . "inc/plugins/{$codename}.php";
    if (!file_exists($plugin_file)) {
        fail("{$codename} plugin file missing at {$plugin_file} - {$missing}");
    }
    require_once $plugin_file;

    if (function_exists($codename . '_install') && !(function_exists($codename . '_is_installed') && call_user_func($codename . '_is_installed'))) {
        call_user_func($codename . '_install');
        out("{$codename} plugin installed");
    }
    if (function_exists($codename . '_activate')) {
        call_user_func($codename . '_activate');
        out("{$codename} plugin activated");
    }

    $plugin_cache = $cache->read('plugins');
    $active = isset($plugin_cache['active']) ? $plugin_cache['active'] : array();
    $active[$codename] = $codename;
    $cache->update('plugins', array('active' => $active));
}

provision_activate_plugin('events', 'run scripts/deploy.sh');

// Smart Thread Link supplies {$thread['smartlink']}, which is what the garrison theme's
// thread listings link with. Without it every thread subject in a forum renders as
// <a href=""> - including the event announcements and troop reports this plugin posts, so
// the suite cannot reach a thread from the forum it was posted into.
provision_activate_plugin('smartlink', 'run scripts/install-smartlink.sh');

// ---------------------------------------------------------------------------
// Point the plugin's settings at the fixtures we just created
// ---------------------------------------------------------------------------
$plugin_settings = array(
    'events_costume_field' => $field_ids['costume'],
    'events_legion_id_field' => $field_ids['legion_id'],
    'events_wwcc_field' => $field_ids['wwcc'],
    'events_mobile_field' => $field_ids['mobile'],
    'events_emergency_contact_field' => $field_ids['emergency_contact'],
    'events_preferred_name_field' => $field_ids['preferred_name'],
    'events_event_coordinator_groups' => (string)$groups['gec'],
    'events_garrison_members_group' => (string)$groups['garrison'],
    'events_501st_members_group' => (string)$groups['legion'],
    'events_troop_report_forum' => (string)$forums['troop_reports'],
    'events_event_forum' => (string)$forums['events'],
    'events_event_forums' => 'Hunter=' . (int)$forums['events_hunter'],
    // The region list is editable, so the suite pins it rather than inheriting whatever
    // a previous run's settings page left behind.
    'events_regions' => 'Sydney,Hunter,Canberra,Other',
    // Same for the event timezone, and it has to match the container's own clock (UTC,
    // see docker/php.ini): the suite drives time by moving that clock and asserts on
    // dates rendered from it, so any other zone would offset every one of those reads.
    // tests/e2e/timezone.spec.ts is where a zone other than UTC is exercised.
    'events_timezone' => 'UTC',
    // The garrison theme hardcodes its logo into the header template rather than filling
    // in MyBB's theme logo property, so the print ribbon is pointed at the file that
    // scripts/install-theme.sh copies in.
    'events_print_logo' => 'images/scg-logo.svg',
    // Never the real 501st API: the fixtures' Legion IDs belong to real members. This is
    // the suite's stand-in (tests/stubs/legion-api.php, copied in by global setup), which
    // answers "down" unless a test says otherwise.
    'events_legion_api_url' => 'http://localhost/e2e-legion-api.php',
);
foreach ($plugin_settings as $name => $value) {
    $db->update_query('settings', array('value' => $db->escape_string((string)$value)), "name = '" . $db->escape_string($name) . "'");
}
rebuild_settings();
out('plugin settings applied');

// ---------------------------------------------------------------------------
// Emit the fixture map for the e2e suite
// ---------------------------------------------------------------------------
$fixtures = array(
    'password' => $FIXTURE_PASSWORD,
    'profileFields' => $field_ids,
    'costumeOptions' => $costume_options,
    'groups' => $groups,
    'forums' => $forums,
    'users' => $user_ids,
);
file_put_contents(MYBB_ROOT . 'events-fixtures.json', json_encode($fixtures, JSON_PRETTY_PRINT));
out('fixtures written to events-fixtures.json');

echo "PROVISION OK\n";

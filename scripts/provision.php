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
    'costume' => array(
        'name' => 'Costumes',
        'description' => 'Costumes you own and can deploy',
        'type' => "multiselect\n" . implode("\n", $costume_options),
    ),
    'tk_id' => array('name' => 'TK ID', 'description' => 'Your 501st legion ID', 'type' => 'text'),
    'wwcc' => array('name' => 'WWCC Number', 'description' => 'Working With Children Check number', 'type' => 'text'),
    'mobile' => array('name' => 'Mobile Number', 'description' => 'Contact number for event days', 'type' => 'text'),
    'emergency_contact' => array('name' => 'Emergency Contact', 'description' => 'Who to call in an emergency', 'type' => 'text'),
);

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
    'scg' => provision_usergroup('SCG Members'),
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
        'additionalgroups' => array($groups['gec'], $groups['scg']),
        'fields' => array('tk_id' => 'TK-10001', 'wwcc' => 'WWCC-1001', 'mobile' => '0400 000 001', 'emergency_contact' => 'Jane Coordinator 0400 111 001', 'costume' => array($costume_options[0])),
    ),
    // Fully-provisioned members: can RSVP without touching the prerequisites step.
    'trooper1' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['scg']),
        'fields' => array('tk_id' => 'TK-20001', 'wwcc' => 'WWCC-2001', 'mobile' => '0400 000 002', 'emergency_contact' => 'Kin Trooper 0400 111 002', 'costume' => array($costume_options[0], $costume_options[2])),
    ),
    'trooper2' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['legion']),
        'fields' => array('tk_id' => 'TK-20002', 'wwcc' => 'WWCC-2002', 'mobile' => '0400 000 003', 'emergency_contact' => 'Kin Trooper 0400 111 003', 'costume' => array($costume_options[1])),
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
        'additionalgroups' => array($groups['scg']),
        'fields' => array('tk_id' => 'TK-20004', 'mobile' => '0400 000 004', 'emergency_contact' => 'Kin Trooper 0400 111 004', 'costume' => array($costume_options[4])),
    ),
    // A non-costumed helper: contactable, but no TK ID, no WWCC and no costumes. Drives
    // the wrangler flow, and proves the costume step is skipped rather than empty.
    'wrangler' => array(
        'usergroup' => 2,
        'additionalgroups' => array(),
        'fields' => array('mobile' => '0400 000 006', 'emergency_contact' => 'Kin Wrangler 0400 111 006'),
    ),
    // Used for the per-event exclusion tests.
    'excluded' => array(
        'usergroup' => 2,
        'additionalgroups' => array($groups['scg']),
        'fields' => array('tk_id' => 'TK-20005', 'wwcc' => 'WWCC-2005', 'mobile' => '0400 000 005', 'emergency_contact' => 'Kin Trooper 0400 111 005', 'costume' => array($costume_options[0])),
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
// Install + activate the Events plugin through MyBB's real plugin code path
// ---------------------------------------------------------------------------
$codename = 'events';
$plugin_file = MYBB_ROOT . "inc/plugins/{$codename}.php";
if (!file_exists($plugin_file)) {
    fail("plugin file missing at {$plugin_file} - run scripts/deploy.sh");
}
require_once $plugin_file;

if (function_exists($codename . '_install') && !(function_exists($codename . '_is_installed') && call_user_func($codename . '_is_installed'))) {
    call_user_func($codename . '_install');
    out('plugin installed');
}
if (function_exists($codename . '_activate')) {
    call_user_func($codename . '_activate');
    out('plugin activated');
}

$plugin_cache = $cache->read('plugins');
$active = isset($plugin_cache['active']) ? $plugin_cache['active'] : array();
$active[$codename] = $codename;
$cache->update('plugins', array('active' => $active));

// ---------------------------------------------------------------------------
// Point the plugin's settings at the fixtures we just created
// ---------------------------------------------------------------------------
$plugin_settings = array(
    'events_costume_field' => $field_ids['costume'],
    'events_tk_id_field' => $field_ids['tk_id'],
    'events_wwcc_field' => $field_ids['wwcc'],
    'events_mobile_field' => $field_ids['mobile'],
    'events_emergency_contact_field' => $field_ids['emergency_contact'],
    'events_event_coordinator_groups' => (string)$groups['gec'],
    'events_scg_members_group' => (string)$groups['scg'],
    'events_501st_members_group' => (string)$groups['legion'],
    'events_troop_report_forum' => (string)$forums['troop_reports'],
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

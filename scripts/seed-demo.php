<?php
/**
 * Seed a handful of events for poking at the plugin by hand.
 *
 * The Playwright suite builds its own fixtures, so this exists purely for manual testing:
 * scripts/db-restore.sh wipes the board back to the provisioned baseline, which has users
 * and settings but no events. Run it with:
 *
 *   docker compose exec -T web php /dev/stdin < scripts/seed-demo.php
 */

define('IN_MYBB', 1);
define('NO_ONLINE', 1);
chdir('/var/www/html');
require_once '/var/www/html/global.php';

/**
 * @param string $title
 * @param int $days_out Days from now that the event starts
 * @param array $opts wwcc (bool), days (array of day offsets)
 * @return int
 */
function seed_event($title, $days_out, array $opts = array())
{
    global $db;

    $now = date('Y-m-d H:i:s', TIME_NOW);

    $id = (int)$db->insert_query('event_plugin_events', array(
        'title'         => $db->escape_string($title),
        'description'   => $db->escape_string('Seeded by scripts/seed-demo.php for manual testing.'),
        'status'        => 'live',
        'region'        => 'Sydney',
        'start_date'    => $db->escape_string(date('Y-m-d H:i:s', TIME_NOW + $days_out * 86400)),
        'end_date'      => $db->escape_string(date('Y-m-d H:i:s', TIME_NOW + $days_out * 86400 + 6 * 3600)),
        'requires_wwcc' => empty($opts['wwcc']) ? 0 : 1,
        'gec_user_id'   => 2,
        'created_by'    => 2,
        'created_at'    => $db->escape_string($now),
        'updated_at'    => $db->escape_string($now),
    ));

    // MyBB's insert_query() cannot express SQL NULL, and '' is not a valid DATETIME under
    // strict mode, so the nullable cutoff is cleared separately.
    $db->write_query("UPDATE " . TABLE_PREFIX . "event_plugin_events SET signup_cutoff = NULL WHERE id = " . $id);

    foreach(isset($opts['days']) ? $opts['days'] : array() as $offset)
    {
        $db->insert_query('event_plugin_event_days', array(
            'event_id'   => $id,
            'date'       => $db->escape_string(date('Y-m-d', TIME_NOW + $offset * 86400)),
            'start_time' => '09:00:00',
            'end_time'   => '17:00:00',
        ));
    }

    echo "  #{$id}  {$title}\n";

    return $id;
}

/**
 * @param int $event_id
 * @param int $user_id
 * @param string $role
 * @param string|null $costume
 */
function seed_signup($event_id, $user_id, $role, $costume = null)
{
    global $db;

    $db->insert_query('event_plugin_rsvps', array(
        'event_id'  => $event_id,
        'user_id'   => $user_id,
        'role'      => $db->escape_string($role),
        'rsvp_date' => $db->escape_string(date('Y-m-d H:i:s', TIME_NOW)),
        'status'    => 'attending',
    ));

    if($costume !== null)
    {
        $db->insert_query('event_plugin_rsvp_costumes', array(
            'rsvp_id' => (int)$db->insert_id(),
            'costume' => $db->escape_string($costume),
        ));
    }
}

$mixed = seed_event('Sydney Shopping Centre Troop', 7);
seed_event('Kids Hospital Visit (WWCC required)', 10, array('wwcc' => true));
seed_event('Two Day Convention', 14, array('days' => array(14, 15)));

// A mixed roster on the first event, so the breakdown indicators and the coordinator
// pages have something to show straight away. uid 3 is trooper1, uid 8 is wrangler.
seed_signup($mixed, 3, 'trooper', 'TK - Stormtrooper');
seed_signup($mixed, 8, 'wrangler');

echo "SEED OK\n";

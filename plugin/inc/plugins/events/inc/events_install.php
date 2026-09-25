<?php
/**
 * MyBB Event Plugin - Database Installation
 * 
 * Creates all required database tables for the event management plugin
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Every table the plugin owns, unprefixed. Install, upgrade and uninstall all walk this
 * list, so a table added here is created, converted and dropped with the rest.
 */
function events_plugin_tables()
{
    return array(
        'event_plugin_events',
        'event_plugin_event_days',
        'event_plugin_event_exclusions',
        'event_plugin_rsvps',
        'event_plugin_rsvp_days',
        'event_plugin_rsvp_costumes',
        'event_plugin_troop_reports',
        'event_plugin_user_prefs',
        'event_plugin_feed_tokens'
    );
}

/**
 * The character set every plugin table is created with.
 *
 * utf8mb4 regardless of the board's own connection encoding: MySQL's `utf8` is the
 * three-byte subset that cannot hold an emoji, so "🎃 Halloween Troop" or a description
 * pasted from Facebook fails to save under strict mode. utf8mb4 is a superset, so it is
 * safe whatever the board connects as. The collation matches what MyBB itself creates
 * its utf8mb4 tables with.
 *
 * Every key on these tables stays inside MyISAM's 1000-byte limit at four bytes a
 * character - the widest is `region`, varchar(64). Indexing a varchar(255) would not.
 */
function events_table_charset()
{
    return "DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci";
}

function events_install_database()
{
    global $db;

    $charset = events_table_charset();
    
    // Events table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_events` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `title` varchar(255) NOT NULL,
        `description` text,
        `status` enum('pending','live','archived') NOT NULL DEFAULT 'pending',
        `region` varchar(64) NOT NULL,
        `address` varchar(255) NOT NULL DEFAULT '',
        `start_date` datetime NOT NULL,
        `end_date` datetime NOT NULL,
        `signup_cutoff` datetime DEFAULT NULL,
        `requires_wwcc` tinyint(1) NOT NULL DEFAULT 0,
        `gec_user_id` int(11) NOT NULL,
        `poc_user_id` int(11) NOT NULL DEFAULT 0,
        `max_troopers` int(10) unsigned NOT NULL DEFAULT 0,
        `max_wranglers` int(10) unsigned NOT NULL DEFAULT 0,
        `created_by` int(11) NOT NULL,
        `thread_id` int(11) DEFAULT NULL,
        `created_at` datetime NOT NULL,
        `updated_at` datetime NOT NULL,
        PRIMARY KEY (`id`),
        KEY `status` (`status`),
        KEY `region` (`region`),
        KEY `start_date` (`start_date`),
        KEY `gec_user_id` (`gec_user_id`),
        KEY `thread_id` (`thread_id`)
    ) ENGINE=MyISAM {$charset};");
    
    // Event days table (for multi-day events)
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_event_days` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `event_id` int(11) NOT NULL,
        `date` date NOT NULL,
        `start_time` time DEFAULT NULL,
        `end_time` time DEFAULT NULL,
        PRIMARY KEY (`id`),
        KEY `event_id` (`event_id`),
        KEY `date` (`date`)
    ) ENGINE=MyISAM {$charset};");
    
    // Event exclusions table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_event_exclusions` (
        `event_id` int(11) NOT NULL,
        `user_id` int(11) NOT NULL,
        PRIMARY KEY (`event_id`, `user_id`),
        KEY `user_id` (`user_id`)
    ) ENGINE=MyISAM {$charset};");
    
    // RSVPs table
    //
    // One row per member per role, so somebody can troop an event and also wrangle it.
    // A waitlisted row is still that member's one row for the role, which is why the
    // unique key excludes status. Withdrawing deletes the row; there is no cancelled state
    // to flip to, because a row left behind would keep occupying the slot.
    //
    // For an event with no days the signup has no day claims, and status is the signup's
    // own. Otherwise it is kept in step with the claims below - attending if any claim is
    // (events_rebalance_waitlist()) - so a status = 'attending' read means "going, at
    // least in part" either way.
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvps` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `event_id` int(11) NOT NULL,
        `user_id` int(11) NOT NULL,
        `role` enum('trooper','wrangler') NOT NULL DEFAULT 'trooper',
        `rsvp_date` datetime NOT NULL,
        `status` enum('attending','waitlisted') NOT NULL DEFAULT 'attending',
        PRIMARY KEY (`id`),
        UNIQUE KEY `event_user_role` (`event_id`, `user_id`, `role`),
        KEY `user_id` (`user_id`),
        KEY `status` (`status`)
    ) ENGINE=MyISAM {$charset};");
    
    // RSVP days table
    //
    // One claim per signup per day. Each claim is its own place in that day's queue for
    // the role: claimed_at is the order the queue is in, and a day added to a signup later
    // joins the back of it. The first max_troopers / max_wranglers of a queue are
    // attending and the rest waitlisted - see events_waitlist_moves().
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvp_days` (
        `rsvp_id` int(11) NOT NULL,
        `event_day_id` int(11) NOT NULL,
        `status` enum('attending','waitlisted') NOT NULL DEFAULT 'attending',
        `claimed_at` datetime NOT NULL,
        PRIMARY KEY (`rsvp_id`, `event_day_id`),
        KEY `event_day_id` (`event_day_id`)
    ) ENGINE=MyISAM {$charset};");
    
    // RSVP costumes table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvp_costumes` (
        `rsvp_id` int(11) NOT NULL,
        `costume` varchar(255) NOT NULL,
        KEY `rsvp_id` (`rsvp_id`)
    ) ENGINE=MyISAM {$charset};");
    
    // Troop reports table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_troop_reports` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `event_id` int(11) NOT NULL,
        `thread_id` int(11) DEFAULT NULL,
        `created_by` int(11) NOT NULL,
        `created_at` datetime NOT NULL,
        `posted_at` datetime DEFAULT NULL,
        `last_reminder_sent` datetime DEFAULT NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `event_id` (`event_id`),
        KEY `thread_id` (`thread_id`)
    ) ENGINE=MyISAM {$charset};");

    // Per-member preferences table
    events_create_user_prefs_table();
    events_create_feed_tokens_table();
}

/**
 * Per-member preferences for the events pages.
 *
 * Its own table rather than a column on `users`: the plugin drops what it owns on
 * uninstall, and a board that removes it should not be left carrying a stray column on
 * the busiest table MyBB has. One row per member, written only once they have actually
 * expressed a preference - the absent row is the default, so the table stays empty for
 * everybody who never touches the view toggle.
 *
 * Shared by install and upgrade, because a board that already has the plugin only ever
 * runs the latter.
 */
function events_create_user_prefs_table()
{
    global $db;

    $charset = events_table_charset();

    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_user_prefs` (
        `user_id` int(11) NOT NULL,
        `events_view` enum('list','calendar') NOT NULL DEFAULT 'list',
        PRIMARY KEY (`user_id`)
    ) ENGINE=MyISAM {$charset};");
}

/**
 * The calendar subscription tokens, one per member at most (see events_feed.php).
 *
 * Only a hash of each token is kept, never the token, so the table is of no use to
 * anyone who reads it: a feed URL cannot be rebuilt from it. The hash is SHA-256 hex;
 * utf8mb4 like every other column, which puts its unique key at 256 bytes, well inside
 * MyISAM's limit. The collation is case-insensitive, which does not matter: the lookup
 * is followed by an exact hash_equals() (events_feed_token_user()).
 *
 * Shared by install and upgrade, like events_create_user_prefs_table().
 */
function events_create_feed_tokens_table()
{
    global $db;

    $charset = events_table_charset();

    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_feed_tokens` (
        `user_id` int(11) NOT NULL,
        `token_hash` char(64) NOT NULL,
        `created_at` int(10) unsigned NOT NULL DEFAULT 0,
        `last_used_at` int(10) unsigned NOT NULL DEFAULT 0,
        PRIMARY KEY (`user_id`),
        UNIQUE KEY `token_hash` (`token_hash`)
    ) ENGINE=MyISAM {$charset};");
}

/**
 * Bring an already-installed board's schema up to date.
 *
 * MyBB gives plugins no upgrade hook and CREATE TABLE IF NOT EXISTS will not add a
 * column, so this runs from events_activate() on every activation. Each step is guarded
 * independently: MyISAM has no transactions, so a run interrupted between two ALTERs has
 * to be resumable.
 *
 * Note that ADD COLUMN on MyISAM copies the whole table under a lock. At garrison scale
 * that is instant.
 */
function events_upgrade_database()
{
    global $db;

    if(!$db->table_exists('event_plugin_rsvps'))
    {
        return;
    }

    // 1.2 - signups carry a role so a member can wrangle as well as troop.
    if(!$db->field_exists('role', 'event_plugin_rsvps'))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_rsvps`
            ADD `role` enum('trooper','wrangler') NOT NULL DEFAULT 'trooper' AFTER `user_id`");
    }

    // The old key allowed one signup per member per event. It is replaced under a new
    // name rather than widened in place, because index_exists() only reports that a
    // *name* is present - reusing `event_user` would look done on the first run and the
    // index would never actually widen.
    //
    // This cannot fail on duplicate data: every existing row takes 'trooper' from the
    // column default, and the old two-column key already guaranteed those pairs unique.
    if($db->index_exists('event_plugin_rsvps', 'event_user'))
    {
        $db->drop_index('event_plugin_rsvps', 'event_user');
    }

    if(!$db->index_exists('event_plugin_rsvps', 'event_user_role'))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_rsvps`
            ADD UNIQUE KEY `event_user_role` (`event_id`, `user_id`, `role`)");
    }

    // The events page opens in whichever view the member last used.
    events_create_user_prefs_table();
    events_create_feed_tokens_table();

    // 1.4 - regions are the board's to configure, so the column can no longer be an
    // enum of the four the plugin shipped with: MySQL silently coerces a value outside
    // an enum to '' under a non-strict mode and rejects it under a strict one, so a
    // board that added a region would either lose it or fail to save the event at all.
    // Guarded on the current type rather than on a version number, because MyBB gives a
    // plugin nowhere to record which migrations it has run.
    $column = $db->fetch_array($db->write_query(
        "SHOW COLUMNS FROM `" . TABLE_PREFIX . "event_plugin_events` LIKE 'region'"
    ));
    if($column && stripos($column['Type'], 'enum') === 0)
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_events`
            MODIFY `region` varchar(64) NOT NULL");
    }

    // 1.3 - an event carries the address it happens at, which the pages and the
    // announcement thread turn into a map link. Empty string rather than NULL: it is only
    // ever read as text, and a nullable column would mean every reader guarding for it.
    if(!$db->field_exists('address', 'event_plugin_events'))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_events`
            ADD `address` varchar(255) NOT NULL DEFAULT '' AFTER `region`");
    }

    // 1.5 - an event can name a point of contact from among its signups. 0 rather than
    // NULL for "nobody", for the same reason the address is an empty string: MyBB's query
    // helpers cannot write a NULL, and every reader would have to guard for one.
    if(!$db->field_exists('poc_user_id', 'event_plugin_events'))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_events`
            ADD `poc_user_id` int(11) NOT NULL DEFAULT 0 AFTER `gec_user_id`");
    }

    // 1.6 - the tables shipped as three-byte utf8, which cannot store an emoji. CONVERT TO
    // rewrites every text column and the data in it; utf8 to utf8mb4 is lossless, since
    // every three-byte sequence is already valid utf8mb4. It may widen a `text` column to
    // `mediumtext` so it still holds as many characters, which is harmless. Guarded per
    // table on its current collation, so an interrupted run picks up where it stopped.
    foreach(events_plugin_tables() as $table)
    {
        $status = $db->fetch_array($db->write_query(
            "SHOW TABLE STATUS LIKE '" . $db->escape_string(TABLE_PREFIX . $table) . "'"
        ));
        if($status && stripos((string)$status['Collation'], 'utf8mb4') !== 0)
        {
            $db->write_query("ALTER TABLE `" . TABLE_PREFIX . $table . "`
                CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
        }
    }

    // 1.7 - excluding a member now withdraws the signup they already held. Before, it
    // stayed on the attendance sheet and in the counts, held by somebody who could no
    // longer see the event to withdraw it. Those are withdrawn here the same way, and
    // since nothing is left to match on a second run, this needs no guard.
    if($db->table_exists('event_plugin_event_exclusions'))
    {
        $query = $db->write_query("
            SELECT r.id
            FROM " . TABLE_PREFIX . "event_plugin_rsvps r
            INNER JOIN " . TABLE_PREFIX . "event_plugin_event_exclusions x
                ON x.event_id = r.event_id AND x.user_id = r.user_id
        ");
        $rsvp_ids = array();
        while($row = $db->fetch_array($query))
        {
            $rsvp_ids[] = (int)$row['id'];
        }

        if(!empty($rsvp_ids))
        {
            $in = implode(',', $rsvp_ids);
            $db->delete_query("event_plugin_rsvp_days", "rsvp_id IN (" . $in . ")");
            $db->delete_query("event_plugin_rsvp_costumes", "rsvp_id IN (" . $in . ")");
            $db->delete_query("event_plugin_rsvps", "id IN (" . $in . ")");
        }
    }

    // 1.8 - deleting a member now drops what the plugin held against them. Before, their
    // signups stayed in the counts and blocked the troop-report reminder for everyone else
    // on the event - see events_delete_member_data(). What earlier deletions left behind
    // is cleared here; nothing matches on a second run.
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    $orphans = array();
    foreach(array('event_plugin_rsvps', 'event_plugin_event_exclusions', 'event_plugin_user_prefs', 'event_plugin_feed_tokens') as $table)
    {
        if(!$db->table_exists($table))
        {
            continue;
        }

        $query = $db->write_query("
            SELECT DISTINCT t.user_id
            FROM " . TABLE_PREFIX . $table . " t
            LEFT JOIN " . TABLE_PREFIX . "users u ON u.uid = t.user_id
            WHERE u.uid IS NULL
        ");
        while($row = $db->fetch_array($query))
        {
            $orphans[] = (int)$row['user_id'];
        }
    }
    events_delete_member_data(array_unique($orphans));
}

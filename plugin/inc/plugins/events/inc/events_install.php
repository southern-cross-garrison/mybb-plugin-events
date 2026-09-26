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
 * Every table the plugin owns, unprefixed. Uninstall walks this list, so a table added
 * here is dropped with the rest.
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
    //
    // `region` is binary, unlike every other text column: a region is an identifier from
    // the region list, which PHP holds as exact strings. Under general_ci the database
    // treated "Cafe" and "Café" as one region while PHP treated them as two, and every
    // region rename, delete and count compares in SQL.
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_events` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `title` varchar(255) NOT NULL,
        `description` text,
        `status` enum('pending','live','archived') NOT NULL DEFAULT 'pending',
        `region` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
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
    //
    // claimed_at only has whole seconds, so two claims on the last place can share one.
    // The id breaks that tie: claims are inserted under the event's signup lock, so id
    // order is the order they were actually made in. The signup's own id is not - a
    // member who signed up weeks ago and adds this day now has the older signup and the
    // newer claim.
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvp_days` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `rsvp_id` int(11) NOT NULL,
        `event_day_id` int(11) NOT NULL,
        `status` enum('attending','waitlisted') NOT NULL DEFAULT 'attending',
        `claimed_at` datetime NOT NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `rsvp_day` (`rsvp_id`, `event_day_id`),
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
 * column, so this runs from events_activate() on every activation. There is no deployed
 * board yet, so there is nothing to migrate: the schema in events_install_database() is
 * the only one. Once a board is live, a schema change goes both there and here, each
 * step guarded independently - MyISAM has no transactions, so a run interrupted between
 * two ALTERs has to be resumable.
 */
function events_upgrade_database()
{
}

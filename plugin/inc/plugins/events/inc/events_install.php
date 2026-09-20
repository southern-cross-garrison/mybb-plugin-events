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

function events_install_database()
{
    global $db;
    
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
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
    
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
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
    
    // Event exclusions table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_event_exclusions` (
        `event_id` int(11) NOT NULL,
        `user_id` int(11) NOT NULL,
        PRIMARY KEY (`event_id`, `user_id`),
        KEY `user_id` (`user_id`)
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
    
    // RSVPs table
    //
    // One row per member per role, so somebody can troop an event and also wrangle it.
    // The unique key deliberately excludes status: if cancelling is ever implemented as
    // a status flip, a cancelled row would keep occupying the slot and the member could
    // never sign up again. Delete the row instead, or widen the key.
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvps` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `event_id` int(11) NOT NULL,
        `user_id` int(11) NOT NULL,
        `role` enum('trooper','wrangler') NOT NULL DEFAULT 'trooper',
        `rsvp_date` datetime NOT NULL,
        `status` enum('attending','cancelled') NOT NULL DEFAULT 'attending',
        PRIMARY KEY (`id`),
        UNIQUE KEY `event_user_role` (`event_id`, `user_id`, `role`),
        KEY `user_id` (`user_id`),
        KEY `status` (`status`)
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
    
    // RSVP days table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvp_days` (
        `rsvp_id` int(11) NOT NULL,
        `event_day_id` int(11) NOT NULL,
        PRIMARY KEY (`rsvp_id`, `event_day_id`),
        KEY `event_day_id` (`event_day_id`)
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
    
    // RSVP costumes table
    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_rsvp_costumes` (
        `rsvp_id` int(11) NOT NULL,
        `costume` varchar(255) NOT NULL,
        KEY `rsvp_id` (`rsvp_id`)
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
    
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
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");

    // Per-member preferences table
    events_create_user_prefs_table();
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

    $db->write_query("CREATE TABLE IF NOT EXISTS `" . TABLE_PREFIX . "event_plugin_user_prefs` (
        `user_id` int(11) NOT NULL,
        `events_view` enum('list','calendar') NOT NULL DEFAULT 'list',
        PRIMARY KEY (`user_id`)
    ) ENGINE=MyISAM DEFAULT CHARSET=utf8;");
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
}

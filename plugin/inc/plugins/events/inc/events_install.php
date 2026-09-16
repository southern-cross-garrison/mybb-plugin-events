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
        `region` enum('Sydney','Hunter','Canberra','Other') NOT NULL,
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
}

<?php
/**
 * Event types: a troop, which is every event the plugin has known until now, or a social
 * event - one signup list with no costumes, no troop report and no trooping credit.
 *
 * A social event's signups are the 'attendee' role, capped by `max_attendees`. The troop
 * roles keep their own columns and never apply to a social event, so the one new role
 * needs a cap of its own rather than borrowing max_troopers.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

return function($db)
{
    if(!$db->field_exists("event_type", "event_plugin_events"))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_events`
            ADD `event_type` enum('troop','social') NOT NULL DEFAULT 'troop' AFTER `title`");
    }

    if(!$db->field_exists("max_attendees", "event_plugin_events"))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_events`
            ADD `max_attendees` int(10) unsigned NOT NULL DEFAULT 0 AFTER `max_wranglers`");
    }

    // Rewriting an enum that already holds the value is harmless, but reading it first
    // keeps a re-run from rebuilding the table for nothing.
    $column = $db->fetch_array($db->query("SHOW COLUMNS FROM `" . TABLE_PREFIX . "event_plugin_rsvps` LIKE 'role'"));
    if($column && strpos($column['Type'], "'attendee'") === false)
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_rsvps`
            MODIFY `role` enum('trooper','wrangler','attendee') NOT NULL DEFAULT 'trooper'");
    }
};

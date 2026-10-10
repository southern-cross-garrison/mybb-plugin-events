<?php
/**
 * The real signup sheet of an event another unit runs: the event's thread on that
 * garrison's own forum. Signing up here is for the garrison's records, and every event
 * in a region run by another unit links to where it counts - see events_units.php.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

return function($db)
{
    if(!$db->field_exists("external_signup_url", "event_plugin_events"))
    {
        $db->write_query("ALTER TABLE `" . TABLE_PREFIX . "event_plugin_events`
            ADD `external_signup_url` varchar(255) NOT NULL DEFAULT '' AFTER `address`");
    }
};

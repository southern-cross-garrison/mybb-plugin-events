<?php
/**
 * Troop attendance: who a posted troop report names, in the role they signed up for, and
 * the costumes their signup listed (see events_attendance.php).
 *
 * The event's date and region are not copied here but joined from the event, so a region
 * rename carries the reports with it. The costumes are a copy, because a signup can change
 * after the fact and a costume report should say what was worn when the report was taken.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

return function($db)
{
    $charset = events_table_charset();

    if(!$db->table_exists("event_plugin_attendance"))
    {
        $db->write_query("CREATE TABLE `" . TABLE_PREFIX . "event_plugin_attendance` (
            `id` int(11) NOT NULL AUTO_INCREMENT,
            `event_id` int(11) NOT NULL,
            `user_id` int(11) NOT NULL,
            `role` enum('trooper','wrangler') NOT NULL DEFAULT 'trooper',
            `recorded_at` datetime NOT NULL,
            PRIMARY KEY (`id`),
            UNIQUE KEY `event_user_role` (`event_id`, `user_id`, `role`),
            KEY `user_id` (`user_id`)
        ) ENGINE=MyISAM {$charset};");
    }

    if(!$db->table_exists("event_plugin_attendance_costumes"))
    {
        $db->write_query("CREATE TABLE `" . TABLE_PREFIX . "event_plugin_attendance_costumes` (
            `attendance_id` int(11) NOT NULL,
            `costume` varchar(255) NOT NULL,
            KEY `attendance_id` (`attendance_id`),
            KEY `costume` (`costume`(191))
        ) ENGINE=MyISAM {$charset};");
    }
};

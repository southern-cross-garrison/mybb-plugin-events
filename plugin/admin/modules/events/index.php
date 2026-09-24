<?php
/**
 * MyBB Events Plugin - Admin CP dispatcher
 * Includes the plugin's events_admin.php which handles action=events|settings|rsvps|add|edit|delete.
 */

if(!defined("IN_MYBB"))
{
	die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin.php";

<?php
/**
 * MyBB Events Plugin - Admin CP module registration
 * Required so that index.php?module=events&action=settings loads the plugin settings page.
 */

if(!defined("IN_MYBB"))
{
	die("Direct initialization of this file is not allowed.");
}

/**
 * Register Events in the admin menu.
 *
 * @return bool true
 */
function events_meta()
{
	global $page, $lang, $plugins;

	$sub_menu = array();
	$sub_menu['10'] = array("id" => "events", "title" => "Events", "link" => "index.php?module=events");
	$sub_menu['20'] = array("id" => "rsvps", "title" => "RSVPs", "link" => "index.php?module=events&action=rsvps");
	$sub_menu['30'] = array("id" => "settings", "title" => "Settings", "link" => "index.php?module=events&action=settings");

	$sub_menu = $plugins->run_hooks("admin_events_menu", $sub_menu);

	$page->add_menu_item("Event Management", "events", "index.php?module=events", 25, $sub_menu);

	return true;
}

/**
 * Return the file to run for the given action. Always delegates to the plugin's events_admin.php.
 *
 * @param string $action From URL (module=events gives action "home"; real action is in $mybb->input['action'])
 * @return string Filename under admin/modules/events/
 */
function events_action_handler($action)
{
	global $page, $mybb;

	$page->active_module = "events";
	$page->active_action = $mybb->get_input('action') ?: 'events';

	return "index.php";
}

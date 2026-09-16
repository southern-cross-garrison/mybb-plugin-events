<?php
/**
 * MyBB Event Plugin - Admin CP dispatcher
 *
 * Owns the page header and footer so the individual actions only render their body.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

$page->add_breadcrumb_item("Event Management", "index.php?module=events");
$page->output_header("Event Management");

$events_action = $mybb->get_input('action');

$page->output_nav_tabs(array(
    'events'   => array('title' => 'Events', 'link' => 'index.php?module=events', 'description' => 'Create and manage events'),
    'rsvps'    => array('title' => 'RSVPs', 'link' => 'index.php?module=events&amp;action=rsvps', 'description' => 'Review who is attending'),
    'settings' => array('title' => 'Settings', 'link' => 'index.php?module=events&amp;action=settings', 'description' => 'Configure the plugin'),
), in_array($events_action, array('rsvps', 'settings')) ? $events_action : 'events');

switch($events_action)
{
    case 'settings':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_settings.php";
        events_admin_settings();
        break;

    case 'rsvps':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_rsvps.php";
        events_admin_rsvps();
        break;

    case 'add':
    case 'edit':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_events.php";
        events_admin_edit_event();
        break;

    case 'status':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_events.php";
        events_admin_set_status();
        break;

    case 'delete':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_events.php";
        events_admin_delete_event();
        break;

    default:
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_events.php";
        events_admin_list_events();
        break;
}

$page->output_footer();

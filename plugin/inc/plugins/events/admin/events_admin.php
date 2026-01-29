<?php
/**
 * MyBB Event Plugin - Admin CP Module
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

$page->add_breadcrumb_item("Event Management", "index.php?module=events");

$sub_tabs['events'] = array(
    'title' => 'Events',
    'link' => 'index.php?module=events',
    'description' => 'Manage events'
);

$sub_tabs['rsvps'] = array(
    'title' => 'RSVPs',
    'link' => 'index.php?module=events&action=rsvps',
    'description' => 'View and manage RSVPs'
);

$sub_tabs['settings'] = array(
    'title' => 'Settings',
    'link' => 'index.php?module=events&action=settings',
    'description' => 'Configure plugin settings'
);

$page->output_header("Event Management");

$tabs = $page->output_nav_tabs($sub_tabs, 'events');

$action = $mybb->input['action'];

switch($action)
{
    case 'settings':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_settings.php";
        events_admin_settings();
        break;
    case 'rsvps':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_rsvps.php";
        events_admin_rsvps();
        break;
    case 'edit':
    case 'add':
        require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_events.php";
        events_admin_edit_event();
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

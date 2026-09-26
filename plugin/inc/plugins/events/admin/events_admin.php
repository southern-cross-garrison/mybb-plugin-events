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
require_once MYBB_ROOT . "inc/plugins/events/inc/events_form.php";

$events_action = $mybb->get_input('action');

// In the <head> rather than echoed into the body beside the controls it styles, because
// one of the things it sets is the size of the description box - and sceditor builds the
// editor at whatever size that box has resolved to by the time the page is ready. A
// stylesheet still arriving further down the body is a race with that measurement.
$page->extra_header .= events_admin_assets('../jscripts/events/');

// The event form's description box is MyBB's BBCode editor and can be previewed above the
// form, and both want something in the <head> - which output_header() below has already
// written by the time the action itself runs. The front-end form has no equivalent
// problem: its template is one string, and the head is still in it when the page is built.
if($events_action === 'add' || $events_action === 'edit')
{
    $page->extra_header .= events_description_editor_assets()
                         . events_preview_assets('../jscripts/events/');
}

// The settings form is never served from the browser's cache, so its dropdowns show the
// profile fields as they are after an add, edit or delete. Sent here because a header
// sent once output_header() has written the page never reaches the browser.
if($events_action === 'settings' && $mybb->request_method != "post")
{
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
}

// Buffered so the actions below, which run after output_header(), can still send
// headers. Without it admin_redirect() finds the headers gone and falls back to a meta
// refresh of the same URL, which a browser may treat as a reload and fill the form back
// in from what it had before the save.
ob_start();

$page->add_breadcrumb_item("Event Management", "index.php?module=events");
$page->output_header("Event Management");

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
ob_end_flush();

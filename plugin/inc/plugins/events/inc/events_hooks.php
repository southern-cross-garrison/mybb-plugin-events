<?php
/**
 * MyBB Event Plugin - Hooks
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Register the plugin's front-end hooks.
 *
 * Called from inc/plugins/events.php on every request (MyBB includes active plugin
 * files on each page load); registering inside _activate() would only ever run once.
 */
function events_register_hooks()
{
    global $plugins;

    $plugins->add_hook("pre_output_page", "events_nav_menu");
    $plugins->add_hook("showthread_start", "events_thread_display");
}

/**
 * Swap the board's Calendar navigation item for an "Events" one.
 *
 * MyBB's header template has no plugin-facing placeholder, so this works on the rendered
 * page. The board's own calendar is unused - events live in this plugin - so its menu item
 * is taken over rather than sat beside, and the replacement reuses the markup the active
 * theme put there so it stays styled like its neighbours. That matters because themes
 * rewrite the header wholesale: the SCG theme replaces MyBB's <ul class="menu top_links">
 * with a Bootstrap navbar.
 *
 * The Calendar item goes whoever is looking; the Events item only appears for users who
 * could actually open events.php.
 *
 * @param string $page
 * @return string
 */
function events_nav_menu(&$page)
{
    global $mybb;

    // Only events_hooks.php is loaded on every request (see inc/plugins/events.php), so the
    // permission helper has to be pulled in here rather than assumed.
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

    if(strpos($page, 'id="nav_events"') !== false)
    {
        return $page;
    }

    $show_events = events_can_view_events_page();
    $url = $mybb->settings['bburl'] . '/events.php';

    // Themes that leave MyBB's template HTML comments on wrap the item in them, so those
    // are swallowed too - otherwise removing the item would leave an empty pair behind.
    $calendar_item = '#(?:<!--\s*start:\s*header_menu_calendar\s*-->\s*)?'
        . '(<li\b[^>]*>)\s*(<a\b[^>]*\bhref="[^"]*calendar\.php[^"]*"[^>]*>).*?</a>\s*</li>'
        . '(?:\s*<!--\s*end:\s*header_menu_calendar\s*-->)?#is';

    if(preg_match($calendar_item, $page, $match, PREG_OFFSET_CAPTURE))
    {
        list($item, $offset) = $match[0];
        $replacement = '';

        if($show_events)
        {
            // Carry the theme's own anchor classes across, minus "calendar" - that one is
            // how MyBB's default theme names the item's sprite icon, not a shared style.
            $classes = array('events');
            if(preg_match('#\bclass="([^"]*)"#i', $match[2][0], $class_match))
            {
                $classes = array_merge($classes, array_diff(preg_split('#\s+#', trim($class_match[1]), -1, PREG_SPLIT_NO_EMPTY), array('calendar')));
            }

            $replacement = $match[1][0] . '<a href="' . $url . '" id="nav_events" class="' . implode(' ', $classes) . '">Events</a></li>';
        }

        $page = substr_replace($page, $replacement, $offset, strlen($item));

        return $page;
    }

    // Boards with the calendar switched off still have MyBB's default menu container.
    $marker = '<ul class="menu top_links">';
    if($show_events && ($offset = strpos($page, $marker)) !== false)
    {
        $item = '<li><a href="' . $url . '" id="nav_events" class="events">Events</a></li>';
        $page = substr_replace($page, $item, $offset + strlen($marker), 0);
    }

    return $page;
}

/**
 * Expose the linked event (if any) to threads, so other code/templates can use it.
 */
function events_thread_display()
{
    global $tid, $db, $event_info;

    $event_info = $db->fetch_array($db->simple_select("event_plugin_events", "*", "thread_id = " . (int)$tid));
}

/**
 * PM every attendee of a finished event that still has no posted troop report.
 *
 * Reminders are re-sent at most once a week per event. All time comparisons are done
 * in PHP rather than with SQL NOW() so the behaviour follows the application clock.
 *
 * @return int number of events reminded about
 */
function events_send_reminders()
{
    global $db, $mybb;

    require_once MYBB_ROOT . "inc/datahandlers/pm.php";

    $reminder_interval = 7 * 24 * 60 * 60;
    $now = date('Y-m-d H:i:s', TIME_NOW);
    $resend_before = date('Y-m-d H:i:s', TIME_NOW - $reminder_interval);

    $query = $db->query("
        SELECT e.id, e.title, tr.id AS report_id, tr.last_reminder_sent
        FROM " . TABLE_PREFIX . "event_plugin_events e
        LEFT JOIN " . TABLE_PREFIX . "event_plugin_troop_reports tr ON e.id = tr.event_id
        WHERE e.status = 'live'
          AND e.end_date < '" . $db->escape_string($now) . "'
          AND (tr.id IS NULL OR tr.posted_at IS NULL)
          AND (tr.last_reminder_sent IS NULL OR tr.last_reminder_sent < '" . $db->escape_string($resend_before) . "')
    ");

    $events = array();
    while($row = $db->fetch_array($query))
    {
        $events[] = $row;
    }

    $reminded = 0;
    foreach($events as $event)
    {
        $user_ids = array();
        // Troopers only: wranglers cannot author a troop report, so nagging them about a
        // missing one is noise. It also keeps somebody who both trooped and wrangled from
        // landing in $user_ids twice and being PMed twice.
        $rsvp_query = $db->simple_select("event_plugin_rsvps", "user_id",
            "event_id = " . (int)$event['id'] . " AND role = 'trooper' AND status = 'attending'");
        while($rsvp = $db->fetch_array($rsvp_query))
        {
            $user_ids[] = (int)$rsvp['user_id'];
        }

        if(empty($user_ids))
        {
            continue;
        }

        $pmhandler = new PMDataHandler();
        $pmhandler->admin_override = true;
        $pmhandler->set_data(array(
            'subject' => "Troop Report Needed: " . $event['title'],
            'message' => "The event '" . $event['title'] . "' has finished, but no troop report has been posted yet.\n\n" .
                         "Please create one here: " . $mybb->settings['bburl'] . "/troop_report.php?id=" . $event['id'],
            'fromid'  => 0,
            'toid'    => $user_ids,
            'ipaddress' => '127.0.0.1',
        ));

        if(!$pmhandler->validate_pm())
        {
            continue;
        }

        $pmhandler->insert_pm();
        $reminded++;

        if($event['report_id'])
        {
            $db->update_query("event_plugin_troop_reports",
                array('last_reminder_sent' => $db->escape_string($now)),
                "id = " . (int)$event['report_id']);
        }
        else
        {
            $db->insert_query("event_plugin_troop_reports", array(
                'event_id'           => (int)$event['id'],
                'created_by'         => 0,
                'created_at'         => $db->escape_string($now),
                'last_reminder_sent' => $db->escape_string($now),
            ));
        }
    }

    return $reminded;
}

/**
 * Keep the profile-field dropdowns on the plugin's settings page in step with the
 * board's custom profile fields.
 *
 * Hooks: admin_config_profile_fields_{add,edit,delete}_commit
 */
function events_rebuild_profile_field_dropdowns()
{
    global $db;

    require_once MYBB_ROOT . "inc/plugins/events.php";

    $optionscode = events_build_profile_field_optionscode();

    foreach(events_profile_field_settings() as $setting_name)
    {
        $db->update_query("settings",
            array("optionscode" => $db->escape_string($optionscode)),
            "name = '" . $db->escape_string($setting_name) . "'");
    }

    rebuild_settings();
}

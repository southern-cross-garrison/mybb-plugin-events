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
 * Add an "Events" item to the board's top navigation.
 *
 * MyBB's header template has no plugin-facing placeholder, so the link is injected
 * into the rendered top_links list.
 *
 * @param string $page
 * @return string
 */
function events_nav_menu(&$page)
{
    global $mybb;

    $marker = '<ul class="menu top_links">';
    if(strpos($page, $marker) === false || strpos($page, 'id="nav_events"') !== false)
    {
        return $page;
    }

    $link = $marker . '<li><a href="' . $mybb->settings['bburl'] . '/events.php" id="nav_events" class="events">Events</a></li>';
    $page = preg_replace('/' . preg_quote($marker, '/') . '/', $link, $page, 1);

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
        $rsvp_query = $db->simple_select("event_plugin_rsvps", "user_id",
            "event_id = " . (int)$event['id'] . " AND status = 'attending'");
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

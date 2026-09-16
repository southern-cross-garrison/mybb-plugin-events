<?php
/**
 * MyBB Event Plugin - Scheduled task registration
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Register the daily troop-report reminder task.
 */
function events_register_task()
{
    global $db, $cache, $lang;

    if($db->num_rows($db->simple_select("tasks", "tid", "file = 'events_reminders'")) > 0)
    {
        return;
    }

    require_once MYBB_ROOT . "inc/functions_task.php";

    $task = array(
        'title'       => $db->escape_string('Event Reminder PMs'),
        'description' => $db->escape_string('Sends reminder PMs for finished events that are missing a troop report'),
        'file'        => 'events_reminders',
        'minute'      => '0',
        'hour'        => '0',
        'day'         => '*',
        'month'       => '*',
        'weekday'     => '*',
        'enabled'     => 1,
        'logging'     => 1,
    );
    $task['nextrun'] = fetch_next_run($task);

    $db->insert_query("tasks", $task);
    $cache->update_tasks();
}

/**
 * Remove the scheduled task.
 */
function events_unregister_task()
{
    global $db, $cache;

    $db->delete_query("tasks", "file = 'events_reminders'");
    $cache->update_tasks();
}

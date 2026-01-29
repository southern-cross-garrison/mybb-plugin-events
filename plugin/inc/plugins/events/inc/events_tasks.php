<?php
/**
 * MyBB Event Plugin - Scheduled Tasks
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Register scheduled task for reminder PMs
 */
function events_register_task()
{
    global $db;
    
    // Check if task already exists
    $query = $db->simple_select("tasks", "tid", "file = 'events_reminders'");
    if($db->num_rows($query) > 0)
    {
        return;
    }
    
    // Add task
    $task = array(
        'title' => 'Event Reminder PMs',
        'description' => 'Sends reminder PMs for events missing troop reports',
        'file' => 'events_reminders',
        'minute' => '0',
        'hour' => '0',
        'day' => '*',
        'month' => '*',
        'weekday' => '*',
        'enabled' => 1,
        'logging' => 1
    );
    
    $db->insert_query("tasks", $task);
}

/**
 * Task file for reminder PMs
 */
function task_events_reminders($task)
{
    global $db;
    
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_hooks.php";
    
    events_send_reminders();
    
    add_task_log($task, "Event reminder PMs sent successfully.");
}

<?php
/**
 * MyBB Event Plugin - Scheduled task entry point
 *
 * MyBB's task runner requires a real file at inc/tasks/<file>.php; a task whose file
 * is missing is disabled automatically on its first run.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

function task_events_reminders($task)
{
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_hooks.php";

    $reminded = events_send_reminders();

    add_task_log($task, "Event reminder PMs sent for {$reminded} event(s).");
}

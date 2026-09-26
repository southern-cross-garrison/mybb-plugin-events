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
    global $mybb;

    require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
    require_once MYBB_ROOT . "inc/plugins/events/inc/events_hooks.php";

    // task.php loads no session, so there is no user at all - not even a guest - and
    // MyBB's PM handler compares every recipient against $mybb->user['uid'].
    if(!isset($mybb->user['uid']))
    {
        $mybb->user['uid'] = 0;
    }

    $reminded = events_send_reminders($failures);

    foreach($failures as $failure)
    {
        add_task_log($task, $failure);
    }

    add_task_log($task, "Event reminder PMs sent for {$reminded} event(s).");
}

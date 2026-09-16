import { spawn } from 'node:child_process';
import { REPO_ROOT } from './config';

/**
 * Run a PHP snippet inside the web container with MyBB booted.
 *
 * Used to exercise code paths that have no UI - chiefly MyBB's scheduled task runner,
 * which the suite needs in order to test the troop-report reminders under a moved clock.
 */
export async function runPhp(snippet: string): Promise<string> {
  const script = `<?php
define('IN_MYBB', 1);
define('MYBB_ROOT', '/var/www/html/');
define('THIS_SCRIPT', 'e2e.php');
define('NO_ONLINE', 1);
require_once MYBB_ROOT.'inc/init.php';
$lang->load('global');
${snippet}
`;

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'web', 'php', '/dev/stdin'], { cwd: REPO_ROOT });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`runPhp exited with ${code}:\n${stdout}\n${stderr}`));
        return;
      }
      resolve(`${stdout}${stderr}`);
    });

    child.stdin.write(script);
    child.stdin.end();
  });

  if (output.includes('MyBB SQL Error') || output.includes('Fatal error')) {
    throw new Error(`runPhp produced a PHP/SQL error:\n${output}`);
  }

  return output.trim();
}

/** Run one of MyBB's scheduled tasks through its real task runner. */
export async function runScheduledTask(file: string): Promise<string> {
  return runPhp(`
require_once MYBB_ROOT.'inc/functions_task.php';
$task = $db->fetch_array($db->simple_select('tasks', '*', "file = '${file}'"));
if(!$task) { echo "TASK_MISSING"; exit; }
// run_task() skips tasks that are not due yet, so force this one to be due.
$db->update_query('tasks', array('nextrun' => 0, 'locked' => 0, 'enabled' => 1), 'tid = '.(int)$task['tid']);
$task['nextrun'] = 0;
$task['locked'] = 0;
run_task($task['tid']);
// Ordered by id, not dateline: the suite moves the clock around, so log entries are
// not written in timestamp order.
$log = $db->fetch_array($db->simple_select('tasklog', '*', 'tid = '.(int)$task['tid'], array('order_by' => 'lid', 'order_dir' => 'DESC', 'limit' => 1)));
$after = $db->fetch_array($db->simple_select('tasks', 'enabled', 'tid = '.(int)$task['tid']));
echo "ENABLED:".$after['enabled']."\\n";
echo "LOG:".(isset($log['data']) ? $log['data'] : '(none)')."\\n";
`);
}

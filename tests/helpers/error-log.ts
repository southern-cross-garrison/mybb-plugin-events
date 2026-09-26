import { runPhp } from './container';

/**
 * Warnings the garrison theme's own templates raise on PHP 8, where an undefined variable
 * or key stopped being a notice MyBB ignores. None is the plugin's: `$avatarep_script`
 * belongs to the Avatarep plugin the theme's headerinclude expects, the guest login modal
 * reads `$captcha` and `$redirect_url`, which MyBB never sets, and the theme's postbit reads
 * `$post['profilefield']`, which MyBB only fills for a post by a registered member - not
 * for a PM from the board itself. Matched by exact message and only inside an eval'd
 * template, so anything else a page logs still counts.
 */
const THEME_TEMPLATE_WARNINGS = [
  'Undefined variable $avatarep_script',
  'Undefined variable $captcha',
  'Undefined variable $redirect_url',
  'Undefined array key "profilefield"',
];

// MyBB's log closes the message with its tag and PHP's goes on to say where, so neither
// mistakes `$captcha` for a longer name that merely starts with it.
const isThemeWarning = (entry: string): boolean =>
  entry.includes("eval()'d code") &&
  THEME_TEMPLATE_WARNINGS.some(
    (warning) => entry.includes(`<message>${warning}</message>`) || entry.includes(`${warning} in `),
  );

/** Empty both logs, so what is read back afterwards was written since. */
export async function clearErrorLogs(): Promise<void> {
  await runPhp(`
@unlink('/var/www/html/cache/mybb_errors.log');
@unlink('/var/log/php_errors.log');
echo "cleared";
`);
}

/**
 * Everything MyBB's error log and PHP's have recorded since clearErrorLogs(), less the
 * theme's own warnings. MyBB's log is a run of `<error>` blocks and PHP's one line per
 * error, so each entry is judged whole.
 */
export async function readErrorLogs(): Promise<string> {
  const log = await runPhp(`
foreach(array('/var/www/html/cache/mybb_errors.log', '/var/log/php_errors.log') as $file)
{
    if(file_exists($file)) { echo file_get_contents($file); }
}
echo "END_OF_LOG";
`);

  const entries = log.replace('END_OF_LOG', '').match(/<error>[\s\S]*?<\/error>|[^\n]+/g) ?? [];
  return entries
    .filter((entry) => entry.trim() !== '' && !isThemeWarning(entry))
    .join('\n')
    .trim();
}

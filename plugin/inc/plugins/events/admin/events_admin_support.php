<?php
/**
 * MyBB Event Plugin - Support tab in the Admin CP
 *
 * A short credit and where to get help, then the copyright and licence - the same things
 * the NOTICE file beside the plugin says, written for a page rather than for a text file
 * wrapped at 80 columns.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

/**
 * The tab, as MyCode. NOTICE stays plain text - it is the file a redistributed copy
 * carries, and has to read properly outside the board - so it is not parsed here.
 * plugin-setup.spec.ts checks the copyright line below still matches it.
 */
define('EVENTS_SUPPORT_MYCODE', <<<'MYCODE'
[size=large][b]Event Management[/b][/size] {version}

Created by [url=https://www.501st.com/member/33151/][b]Kevin Brown (TK-33151)[/b][/url] of the [url=https://www.501scg.org/]Southern Cross Garrison[/url], 501st Legion.

[size=medium][b]Documentation:[/b] [url=https://events-guide.501scg.org/]events-guide.501scg.org[/url][/size]

[b]Found a bug or have an idea?[/b] [url=https://github.com/southern-cross-garrison/mybb-plugin-events/issues]Open an issue on GitHub[/url].
[b]Source code:[/b] [url=https://github.com/southern-cross-garrison/mybb-plugin-events]github.com/southern-cross-garrison/mybb-plugin-events[/url]
MYCODE
);

define('EVENTS_LICENCE_MYCODE', <<<'MYCODE'
Copyright 2026 Kevin Brown (TK-33151)

Licensed under the [url=http://www.apache.org/licenses/LICENSE-2.0]Apache License, Version 2.0[/url]. A copy is in [b]inc/plugins/events/LICENSE[/b], with the attribution notice in [b]inc/plugins/events/NOTICE[/b]; a redistributed copy of the plugin has to keep both.

Unless required by applicable law or agreed to in writing, the plugin is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
MYCODE
);

function events_admin_support()
{
    $info = function_exists('events_info') ? events_info() : array();
    $version = isset($info['version']) ? 'v' . $info['version'] : '';

    $table = new Table;
    $table->construct_cell('<div class="events_support">' . events_support_mycode(str_replace('{version}', $version, EVENTS_SUPPORT_MYCODE)) . '</div>');
    $table->construct_row();
    $table->output("Support");

    $table = new Table;
    $table->construct_cell('<div class="events_licence">' . events_support_mycode(EVENTS_LICENCE_MYCODE) . '</div>');
    $table->construct_row();
    $table->output("Copyright and Licence");
}

/**
 * @param string $mycode
 * @return string HTML
 */
function events_support_mycode($mycode)
{
    return events_parser()->parse_message($mycode, array(
        // Passed as 0 rather than left out: parse_message() reads the key directly.
        'allow_html'    => 0,
        'allow_mycode'  => 1,
        'allow_smilies' => 0,
        'allow_imgcode' => 0,
        'nl2br'         => 1,
    ));
}

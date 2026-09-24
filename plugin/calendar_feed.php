<?php
/**
 * MyBB Event Plugin - Calendar subscription
 *
 * Where a member makes, resets or turns off the private link their calendar app
 * subscribes to (ical_feed.php). The link is shown once, in the response to the POST that
 * made it: only its hash is kept, so there is nothing to show it from afterwards, and
 * getting it again means making a new one.
 */

define("IN_MYBB", 1);
define("THIS_SCRIPT", "calendar_feed.php");

$templatelist = "events_calendar_feed";

require_once "./global.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_feed.php";

if(!events_can_view_events_page())
{
    error_no_permission();
}

$user_id = (int)$mybb->user['uid'];

add_breadcrumb("Events", "events.php");
add_breadcrumb("Calendar Subscription", "calendar_feed.php");

$token = null;
if($mybb->request_method === 'post')
{
    verify_post_check($mybb->get_input('my_post_key'));

    $action = $mybb->get_input('action');
    if($action === 'create')
    {
        $token = events_feed_create_token($user_id);
    }
    elseif($action === 'revoke')
    {
        events_feed_revoke_token($user_id);
        redirect("calendar_feed.php", "Your calendar subscription link has been turned off.");
    }
}

$status = events_feed_token_status($user_id);
$post_key = htmlspecialchars_uni($mybb->post_code);

/**
 * A one-button POST form. Actions that change the link are never GET links, so nothing
 * can be tricked into resetting a member's feed by getting them to follow a URL.
 */
function events_calendar_feed_button($action, $label, $id, $post_key, $confirm = '')
{
    // json_encode makes the message a JS string literal, htmlspecialchars makes that safe
    // inside the attribute; an apostrophe in the message would otherwise end the string.
    $onsubmit = $confirm !== '' ? ' onsubmit="return confirm(' . htmlspecialchars(json_encode($confirm), ENT_QUOTES, 'UTF-8') . ');"' : '';

    return '<form method="post" action="calendar_feed.php" class="events_feed_form"' . $onsubmit . '>'
        . '<input type="hidden" name="my_post_key" value="' . $post_key . '" />'
        . '<input type="hidden" name="action" value="' . $action . '" />'
        . '<input type="submit" class="button" id="' . $id . '" value="' . htmlspecialchars_uni($label) . '" />'
        . '</form>';
}

$feed_body = '<p>Subscribe your calendar app to a private link and every event you sign up for appears in it, '
    . 'kept up to date: change which days you are coming to, or withdraw, and your calendar follows the next time '
    . 'it refreshes. Google Calendar refreshes about once a day; Apple and Outlook more often.</p>';

if($token !== null)
{
    // This response holds the link in the clear, and it is the only one that ever will.
    header("Cache-Control: private, no-store");

    $https = htmlspecialchars_uni(events_feed_url($token));
    $webcal = htmlspecialchars_uni(events_feed_webcal_url($token));

    $feed_body .= '<div class="events_feed_link" id="calendar_feed_link">'
        . '<p class="events_notice"><strong>Copy this link now.</strong> It is shown only this once. '
        . 'If you lose it, make a new one - that also turns this one off.</p>'
        . '<p><a href="' . $webcal . '" class="button" id="calendar_feed_subscribe">Subscribe in my calendar app</a></p>'
        . '<label class="events_label" for="calendar_feed_url">Or paste this into your calendar\'s "subscribe by URL" option '
        . '(in Google Calendar: Other calendars &rarr; From URL)</label>'
        . '<input type="text" readonly="readonly" class="events_input events_feed_url" id="calendar_feed_url" value="' . $https . '" onfocus="this.select();" />'
        . '<p class="events_hint">Treat it like a password: anyone who has it can see the events you have signed up for. '
        . 'Do not post it or share it.</p>'
        . '</div>';
}

if($status)
{
    $created = my_date('relative', (int)$status['created_at']);
    $used = (int)$status['last_used_at'] ? my_date('relative', (int)$status['last_used_at']) : 'not yet';

    $feed_body .= '<p id="calendar_feed_status">Your link was made ' . $created
        . '. A calendar last fetched it: <span id="calendar_feed_last_used">' . $used . '</span>.</p>'
        . '<div class="events_feed_actions">'
        . events_calendar_feed_button('create', 'Make a new link', 'calendar_feed_reset', $post_key,
            'Your current link will stop working, and any calendar subscribed to it will stop updating. Continue?')
        . events_calendar_feed_button('revoke', 'Turn off', 'calendar_feed_revoke', $post_key,
            'Any calendar subscribed to your link will stop updating. Continue?')
        . '</div>';

    if($token === null)
    {
        $feed_body .= '<p class="events_hint">The link itself is not stored, so it cannot be shown again. '
            . 'If you need it again, make a new one and subscribe with that - the old one stops working.</p>';
    }
}
else
{
    $feed_body .= '<div class="events_feed_actions">'
        . events_calendar_feed_button('create', 'Make my subscription link', 'calendar_feed_create', $post_key)
        . '</div>';
}

$events_print_header = events_print_header('Calendar Subscription', array());

eval("\$page = \"" . $templates->get("events_calendar_feed") . "\";");
output_page($page);

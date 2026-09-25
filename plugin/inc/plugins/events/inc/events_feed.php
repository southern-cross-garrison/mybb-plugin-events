<?php
/**
 * MyBB Event Plugin - Calendar subscription tokens
 *
 * A calendar app subscribes to a member's signups by URL and fetches it on its own
 * schedule, from its own servers, with none of the member's cookies. The token in that
 * URL is therefore the whole of the member's authentication for it, and is treated as a
 * password that never leaves the member's hands:
 *
 * - 512 bits from the OS's CSPRNG (random_bytes). Guessing one is not a matter of rate
 *   limits or checksums: there is nothing to narrow the search, and the space is too
 *   large to walk. (The stored SHA-256 caps what a guess has to hit at 256 bits, which
 *   is equally out of reach; the extra length costs nothing but URL.)
 * - Only its SHA-256 is stored. A plain hash rather than a slow password hash, because a
 *   slow hash exists to protect a guessable secret, and this one is not guessable; a
 *   copy of the table (a backup, a leaked dump) holds nothing that opens a feed.
 * - The member sees it once, when it is made. Getting it again means resetting it, which
 *   also kills the old one - the same thing to do when a link has been shared by mistake.
 * - Having a valid token grants only what the member could see signed in, checked afresh
 *   on every fetch: a member since banned or deleted gets nothing, and an event they have
 *   since been excluded from drops out of their feed.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/** Bytes of randomness in a token. 64 is 512 bits, which is 86 characters of base64url. */
define('EVENTS_FEED_TOKEN_BYTES', 64);

/**
 * The shape every token has. A value that does not match is refused before it gets
 * anywhere near the database.
 */
define('EVENTS_FEED_TOKEN_PATTERN', '/^[A-Za-z0-9_-]{86}$/');

/**
 * @param string $token
 * @return string hex SHA-256, as stored
 */
function events_feed_token_hash($token)
{
    return hash('sha256', (string)$token);
}

/**
 * Give a member a new feed token, replacing (and so revoking) any they had.
 *
 * @param int $user_id
 * @return string The token. It is not stored and cannot be recovered after this.
 */
function events_feed_create_token($user_id)
{
    global $db;

    // base64url: nothing in it needs escaping in a query string.
    $token = rtrim(strtr(base64_encode(random_bytes(EVENTS_FEED_TOKEN_BYTES)), '+/', '-_'), '=');

    $db->replace_query("event_plugin_feed_tokens", array(
        'user_id'      => (int)$user_id,
        'token_hash'   => $db->escape_string(events_feed_token_hash($token)),
        'created_at'   => TIME_NOW,
        'last_used_at' => 0,
    ), 'user_id');

    return $token;
}

/**
 * Turn a member's feed off. Their calendar app's next fetch is refused.
 *
 * @param int $user_id
 * @return void
 */
function events_feed_revoke_token($user_id)
{
    global $db;

    $db->delete_query("event_plugin_feed_tokens", "user_id = " . (int)$user_id);
}

/**
 * The member's token row, without the hash, or null when they have no feed.
 *
 * @param int $user_id
 * @return array|null created_at, last_used_at
 */
function events_feed_token_status($user_id)
{
    global $db;

    $row = $db->fetch_array($db->simple_select("event_plugin_feed_tokens", "created_at, last_used_at",
        "user_id = " . (int)$user_id));

    return $row ? $row : null;
}

/**
 * The member a token belongs to, when it is valid and they may still use it.
 *
 * Every way a token can fail returns null, and the caller answers all of them the same
 * way, so a request learns nothing about why it was refused - not even whether the
 * token ever existed.
 *
 * @param string $token As it arrived in the request
 * @return array|null users row
 */
function events_feed_token_user($token)
{
    global $db, $cache;

    if(!is_string($token) || !preg_match(EVENTS_FEED_TOKEN_PATTERN, $token))
    {
        return null;
    }

    $hash = events_feed_token_hash($token);
    $row = $db->fetch_array($db->simple_select("event_plugin_feed_tokens", "user_id, token_hash",
        "token_hash = '" . $db->escape_string($hash) . "'"));

    // The lookup has already matched the hash; comparing it again in constant time costs
    // nothing and keeps the check from resting on how the database compares strings.
    if(!$row || !hash_equals((string)$row['token_hash'], $hash))
    {
        return null;
    }

    $user = $db->fetch_array($db->simple_select("users", "*", "uid = " . (int)$row['user_id']));
    if(!$user)
    {
        return null;
    }

    // A banned member keeps their token row, so the feed comes back if the ban is lifted,
    // but it answers nothing while it stands.
    $usergroups = $cache->read('usergroups');
    $group = isset($usergroups[$user['usergroup']]) ? $usergroups[$user['usergroup']] : null;
    if(!$group || !empty($group['isbannedgroup']))
    {
        return null;
    }

    // Nor does it answer a member the board itself would turn away - one moved into a
    // group that cannot view the board, "Inactive" and the like. Asked across every group
    // they are in, merged the way MyBB merges them for a page view, so an additional
    // group that grants it counts just as it does everywhere else.
    $groups = $user['usergroup'];
    if(!empty($user['additionalgroups']))
    {
        $groups .= ',' . $user['additionalgroups'];
    }
    $permissions = usergroup_permissions($groups);
    if(empty($permissions['canview']))
    {
        return null;
    }

    $db->update_query("event_plugin_feed_tokens", array('last_used_at' => TIME_NOW),
        "user_id = " . (int)$user['uid']);

    return $user;
}

/**
 * The feed's address for a token, as https (or whatever the board runs on).
 *
 * @param string $token
 * @return string
 */
function events_feed_url($token)
{
    global $mybb;

    return $mybb->settings['bburl'] . '/ical_feed.php?token=' . $token;
}

/**
 * The same address as webcal://, which is what makes a click open the calendar app's
 * subscribe dialog rather than download a file.
 *
 * @param string $token
 * @return string
 */
function events_feed_webcal_url($token)
{
    return preg_replace('#^https?://#i', 'webcal://', events_feed_url($token));
}

/**
 * A one-button POST form. Actions that change the link are never GET links, so nothing
 * can be tricked into resetting a member's feed by getting them to follow a URL.
 *
 * @param string $form_action Where the form posts
 * @param array $hidden Extra fields the page needs to route the post back to itself
 * @param string $feed_action create or revoke
 * @param string $label
 * @param string $id
 * @param string $confirm Asked before submitting; empty for none
 * @return string
 */
function events_calendar_feed_button($form_action, array $hidden, $feed_action, $label, $id, $confirm = '')
{
    global $mybb;

    // json_encode makes the message a JS string literal, htmlspecialchars makes that safe
    // inside the attribute; an apostrophe in the message would otherwise end the string.
    $onsubmit = $confirm !== '' ? ' onsubmit="return confirm(' . htmlspecialchars(json_encode($confirm), ENT_QUOTES, 'UTF-8') . ');"' : '';

    $fields = '';
    foreach($hidden + array('my_post_key' => $mybb->post_code, 'feed_action' => $feed_action) as $name => $value)
    {
        $fields .= '<input type="hidden" name="' . htmlspecialchars_uni($name) . '" value="' . htmlspecialchars_uni($value) . '" />';
    }

    return '<form method="post" action="' . htmlspecialchars_uni($form_action) . '" class="events_feed_form"' . $onsubmit . '>'
        . $fields
        . '<input type="submit" class="button" id="' . $id . '" value="' . htmlspecialchars_uni($label) . '" />'
        . '</form>';
}

/**
 * Handle the subscription page's POST, if there is one, and build the page's body.
 *
 * The page exists twice - calendar_feed.php off the events toolbar, and a User CP page
 * (events_usercp_calendar_feed()) - and only its surroundings differ, so everything the
 * member sees and does lives here. Each posts back to itself: $form_action and $hidden
 * say how.
 *
 * The link is shown once, in the response to the POST that made it: only its hash is
 * kept, so there is nothing to show it from afterwards, and getting it again means
 * making a new one.
 *
 * @param string $form_action
 * @param array $hidden
 * @return string HTML
 */
function events_calendar_feed_body($form_action, array $hidden = array())
{
    global $mybb;

    $user_id = (int)$mybb->user['uid'];

    $token = null;
    if($mybb->request_method === 'post')
    {
        verify_post_check($mybb->get_input('my_post_key'));

        $feed_action = $mybb->get_input('feed_action');
        if($feed_action === 'create')
        {
            $token = events_feed_create_token($user_id);
        }
        elseif($feed_action === 'revoke')
        {
            events_feed_revoke_token($user_id);
            $back = $form_action . ($hidden ? '?' . http_build_query($hidden) : '');
            redirect($back, "Your calendar subscription link has been turned off.");
        }
    }

    $status = events_feed_token_status($user_id);

    $body = '<p>Subscribe your calendar app to a private link and every event you sign up for appears in it, '
        . 'kept up to date: change which days you are coming to, or withdraw, and your calendar follows the next time '
        . 'it refreshes. Google Calendar refreshes about once a day; Apple and Outlook more often.</p>';

    if($token !== null)
    {
        // This response holds the link in the clear, and it is the only one that ever will.
        header("Cache-Control: private, no-store");

        $https = htmlspecialchars_uni(events_feed_url($token));
        $webcal = htmlspecialchars_uni(events_feed_webcal_url($token));

        $body .= '<div class="events_feed_link" id="calendar_feed_link">'
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
        // An absolute instant, so my_date() and the member's own zone are right here -
        // unlike an event's dates, which are wall clocks in the event zone.
        $created = my_date('relative', (int)$status['created_at']);
        $used = (int)$status['last_used_at'] ? my_date('relative', (int)$status['last_used_at']) : 'not yet';

        // Labels rather than a sentence: my_date()'s relative forms are capitalised
        // ("Less than 1 minute ago", "Yesterday") and read wrongly mid-sentence.
        $body .= '<p id="calendar_feed_status">Your link is active.<br />'
            . 'Made: ' . $created . '<br />'
            . 'Last fetched by a calendar: <span id="calendar_feed_last_used">' . $used . '</span></p>'
            . '<div class="events_feed_actions">'
            . events_calendar_feed_button($form_action, $hidden, 'create', 'Make a new link', 'calendar_feed_reset',
                'Your current link will stop working, and any calendar subscribed to it will stop updating. Continue?')
            . events_calendar_feed_button($form_action, $hidden, 'revoke', 'Turn off', 'calendar_feed_revoke',
                'Any calendar subscribed to your link will stop updating. Continue?')
            . '</div>';

        if($token === null)
        {
            $body .= '<p class="events_hint">The link itself is not stored, so it cannot be shown again. '
                . 'If you need it again, make a new one and subscribe with that - the old one stops working.</p>';
        }
    }
    else
    {
        $body .= '<div class="events_feed_actions">'
            . events_calendar_feed_button($form_action, $hidden, 'create', 'Make my subscription link', 'calendar_feed_create')
            . '</div>';
    }

    return $body;
}

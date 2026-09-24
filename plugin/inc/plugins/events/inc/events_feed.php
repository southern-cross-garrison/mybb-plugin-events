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

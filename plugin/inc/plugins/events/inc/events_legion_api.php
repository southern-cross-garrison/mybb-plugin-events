<?php
/**
 * Costumes from the 501st Legion's public API.
 *
 * The Legion's member database is the record of which costumes a member is approved in,
 * and the profile field is a copy a member keeps by hand. So whenever a member says they
 * want to troop, their costumes are fetched by Legion ID and written over that copy before
 * the signup asks anything of it. The API is a convenience, not a dependency: when it is
 * down, slow, unset, or knows nothing about the member, the field is left as it was and
 * the signup carries on with what is on file - which, if that is nothing, means asking for
 * costumes on the prerequisites step as before.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * Seconds to wait on the API, connecting and in all. It is fetched while a member waits on
 * the next step of a signup, and what is on file is a good answer, so a slow API is given
 * up on quickly rather than waited out.
 */
define('EVENTS_LEGION_API_CONNECT_TIMEOUT', 3);
define('EVENTS_LEGION_API_TIMEOUT', 5);

/**
 * The digits of a Legion ID as members type it: "TK-12345", "TK 12345" or "12345".
 *
 * @param string $tk_id
 * @return string Empty when there is no number in it
 */
function events_legion_id_number($tk_id)
{
    return ltrim(preg_replace('/\D/', '', (string)$tk_id), '0');
}

/**
 * Look a member up in the API by Legion ID.
 *
 * @param string $legion_id Digits only
 * @return array|null null when the API gave no usable answer (unset, down, slow, an error,
 *                    not JSON). Otherwise 'found' => false for a classified record, or
 *                    'found' => true with 'name', 'garrison' and 'costumes' (formatted
 *                    for the profile field, possibly none)
 */
function events_legion_api_member($legion_id)
{
    $base = trim((string)events_get_setting('legion_api_url'));
    if($base === '' || $legion_id === '' || !function_exists('curl_init'))
    {
        return null;
    }

    // Not fetch_remote_file(): it refuses localhost and private addresses, which is right
    // for a URL a member supplies and wrong for one only an administrator can set, and it
    // waits ten seconds.
    $ch = curl_init(rtrim($base, '/') . '/legionId/' . rawurlencode($legion_id) . '/costumes');
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_PROTOCOLS      => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => EVENTS_LEGION_API_CONNECT_TIMEOUT,
        CURLOPT_TIMEOUT        => EVENTS_LEGION_API_TIMEOUT,
        CURLOPT_HTTPHEADER     => array('Accept: application/json'),
    ));
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if($body === false || $status !== 200)
    {
        return null;
    }

    $data = json_decode($body, true);
    if(!is_array($data))
    {
        return null;
    }

    // A member who has made their details private on 501st.com comes back 200 as a bare
    // "Classified Record": a status and nothing else. So does an ID nobody holds - the API
    // answers the two the same way, so nothing here can tell them apart.
    if(!isset($data['fullName']) || !is_string($data['fullName']))
    {
        return array('found' => false);
    }

    $costumes = array();
    foreach(isset($data['costumes']) && is_array($data['costumes']) ? $data['costumes'] : array() as $costume)
    {
        if(!is_array($costume) || !isset($costume['costumeName']) || !is_string($costume['costumeName']))
        {
            continue;
        }

        $formatted = events_legion_api_format_costume($costume);
        if($formatted !== '')
        {
            $costumes[] = $formatted;
        }
    }

    return array(
        'found'    => true,
        'name'     => trim(preg_replace('/\s+/u', ' ', $data['fullName'])),
        'garrison' => isset($data['garrisonName']) && is_string($data['garrisonName']) ? trim($data['garrisonName']) : '',
        'costumes' => array_values(array_unique($costumes)),
    );
}

/**
 * Fetch a member's approved costumes from the API.
 *
 * @param string $legion_id Digits only
 * @return array|null One costume per entry, formatted for the profile field; null when the
 *                    API gave no usable answer
 */
function events_legion_api_costumes($legion_id)
{
    $member = events_legion_api_member($legion_id);

    // A member found with no costumes is no answer either: writing that over the field
    // would blank costumes they typed in, and the signup would then ask for them again
    // every time.
    return $member && $member['found'] && $member['costumes'] ? $member['costumes'] : null;
}

/**
 * One API costume as a line of the profile field: "TK - Stormtrooper: ANH Stunt", the
 * designation and the costume, the way members write them by hand.
 *
 * The field is split on commas as well as lines (events_parse_costumes()), so a comma in
 * a costume's name - "Officer: Line Officer, (Olive Drab)" - would make two costumes of
 * it. The API's names also carry stray whitespace, non-breaking spaces included.
 *
 * @param array $costume
 * @return string
 */
function events_legion_api_format_costume(array $costume)
{
    $clean = function($value)
    {
        $value = preg_replace('/\s*,\s*/u', ' ', (string)$value);
        return trim(preg_replace('/\s+/u', ' ', $value));
    };

    $name = $clean($costume['costumeName']);
    if($name === '')
    {
        return '';
    }

    $designation = isset($costume['designation']) && is_string($costume['designation']) ? $clean($costume['designation']) : '';

    $line = $designation !== '' ? $designation . ' - ' . $name : $name;

    // The signup's costume rows are varchar(255).
    return my_substr($line, 0, 255);
}

/**
 * Bring a member's costume field up to date from the API, if it has an answer.
 *
 * @param int $user_id
 * @return bool Whether the field now holds the API's costumes - rewritten, or already the
 *              same
 */
function events_sync_user_costumes($user_id)
{
    if(!events_get_setting('costume_field'))
    {
        return false;
    }

    $costumes = events_legion_api_costumes(events_legion_id_number(events_get_user_field($user_id, 'tk_id')));
    if($costumes === null)
    {
        return false;
    }

    $value = implode("\n", $costumes);
    if($value !== events_get_user_field($user_id, 'costume'))
    {
        events_save_user_fields($user_id, array('costume' => $value));
    }

    return true;
}

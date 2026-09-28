<?php
/**
 * MyBB Event Plugin - Shared event create/edit logic
 *
 * An event can be built from two places: the Admin CP module, and manage_event.php on
 * the front end for coordinators who have no Admin CP access. The two render their forms
 * with completely different furniture - MyBB's ACP Form/FormContainer classes on one
 * side, the plugin's own .events_field markup on the other - but they read the same POST
 * and have to agree exactly on what is valid and what gets written.
 *
 * So the reading, validating and saving lives here and the two pages only render. The
 * alternative was two copies of the validation, which is how a board ends up with an
 * event that the Admin CP would have rejected.
 *
 * Values are carried around raw and escaped at the point they are written, because the
 * same array is handed back to the form to re-render after a failed submit.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_thread.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_charts.php";

/**
 * The statuses an event can be in, and how they read in a form.
 *
 * @return array status => label
 */
function events_event_statuses()
{
    return array(
        'pending'  => 'Pending',
        'live'     => 'Live',
        'archived' => 'Archived',
    );
}

/**
 * The <link> and <script> that bring the calendar picker in.
 *
 * One copy of the asset serves both roots. The front end loads it relative to the web
 * root; the Admin CP sits one directory below, and reaches the same file by going up -
 * which is how MyBB's own Admin CP loads jquery.js, so it holds wherever the admin
 * directory has been renamed to.
 *
 * @param string $base 'jscripts/events/' on the front end, '../jscripts/events/' in the ACP
 * @return string
 */
function events_datepicker_assets($base)
{
    return '<link rel="stylesheet" href="' . $base . 'events-datepicker.css" />'
         . '<script src="' . $base . 'jquery-ui-datepicker.js"></script>';
}

/**
 * The <link> that styles the exclusions tag field.
 *
 * It is an asset rather than a block in events.css for the same reason the calendar's
 * stylesheet is one: the control is built by a script that runs on the front-end form and
 * the Admin CP one alike, and the Admin CP loads no theme stylesheet at all - a field
 * styled only in events.css would be a heap of unstyled spans there. Its colours are read
 * from the same --events-* custom properties as everything else, so a theme that retints
 * the plugin retints this too.
 *
 * @param string $base 'jscripts/events/' on the front end, '../jscripts/events/' in the ACP
 * @return string
 */
function events_tag_field_assets($base)
{
    return '<link rel="stylesheet" href="' . $base . 'events-tags.css" />';
}

/**
 * The <link> that styles the controls the plugin adds to the Admin CP.
 *
 * Same reasoning as the two above, minus the second root: these controls only exist in
 * the Admin CP, which is exactly the place MyBB loads no theme stylesheet - so there is
 * nowhere else for their styling to live. The Reports tab's charts come with it; their
 * sheet is shared with the User CP (events_chart_assets()).
 *
 * @param string $base '../jscripts/events/' in the ACP
 * @return string
 */
function events_admin_assets($base)
{
    return '<link rel="stylesheet" href="' . $base . 'events-admin.css" />'
         . events_chart_assets($base);
}

/**
 * The <link> that styles the description preview.
 *
 * Both forms preview, so the sheet is loaded from both roots for the same reason the
 * calendar's and the tag field's are: the Admin CP has no theme stylesheet to put it in,
 * and the preview should not read as one control on the board and another in the ACP.
 *
 * @param string $base 'jscripts/events/' on the front end, '../jscripts/events/' in the ACP
 * @return string
 */
function events_preview_assets($base)
{
    return '<link rel="stylesheet" href="' . $base . 'events-preview.css" />';
}

/**
 * Whether the description box gets MyBB's BBCode editor.
 *
 * Two board settings decide it and neither is the plugin's: "BBCode inserter" turns the
 * editor off board-wide, and a member can turn it off for themselves in their own
 * options. The description is written in the same BBCode a post is, so somebody who has
 * asked not to be given the editor when they post should not be handed it here either -
 * including in the Admin CP, where MyBB's own signature box ignores the preference. The
 * plugin's two forms agreeing with each other matters more here than matching MyBB's.
 *
 * With it off the box is the plain textarea it has always been, and BBCode typed into it
 * is parsed exactly the same way.
 *
 * @return bool
 */
function events_description_editor_enabled()
{
    global $mybb;

    return !empty($mybb->settings['bbcodeinserter'])
        && (!isset($mybb->user['showcodebuttons']) || $mybb->user['showcodebuttons'] != 0);
}

/**
 * MyBB's BBCode editor, bound to a textarea.
 *
 * build_mycode_inserter() is the board's own, and it already knows which half of it to
 * emit: the front end gets the `codebuttons` template, which carries its own stylesheet
 * and scripts, and the Admin CP gets the script alone - see events_description_editor_assets()
 * for the rest of that half.
 *
 * @param string $bind The textarea's id
 * @return string empty when the editor is turned off
 */
function events_description_editor($bind)
{
    if(!events_description_editor_enabled())
    {
        return '';
    }

    // Smilies on, because a description is read as a post is. The dropdown itself still
    // obeys the board's smilie inserter settings, inside build_mycode_inserter().
    return build_mycode_inserter($bind, true);
}

/**
 * The editor's stylesheet and scripts, for the Admin CP only.
 *
 * The front-end half of build_mycode_inserter() renders the `codebuttons` template, which
 * brings these with it; the Admin CP half returns the configuration script on its own and
 * leaves the page to have loaded sceditor already. MyBB's own user editor does this in
 * exactly this way, down to the `../jscripts/` paths - which is how the Admin CP reaches
 * the board root wherever the admin directory has been renamed to.
 *
 * Must be added to $page->extra_header before output_header() has written the <head>.
 *
 * @return string empty when the editor is turned off
 */
function events_description_editor_assets()
{
    global $mybb;

    if(!events_description_editor_enabled())
    {
        return '';
    }

    $version = (int)$mybb->version_code;

    return '<link rel="stylesheet" href="../jscripts/sceditor/themes/mybb.css" type="text/css" media="all" />'
         . '<script type="text/javascript" src="../jscripts/sceditor/jquery.sceditor.bbcode.min.js?ver=' . $version . '"></script>'
         . '<script type="text/javascript" src="../jscripts/bbcodes_sceditor.js?ver=' . $version . '"></script>'
         . '<script type="text/javascript" src="../jscripts/sceditor/plugins/undo.js?ver=' . $version . '"></script>';
}

/**
 * Whether the submitted form is the Preview button rather than the save.
 *
 * Preview is a plain submit that posts the form and comes back with it, which is what
 * MyBB's own Preview Post is - so it works with the script off, and the editor has
 * written its contents back into the textarea by the time the form is posted either way.
 *
 * Both forms give the button `formnovalidate`. An event needs a title and two dates, so
 * those controls are marked required and the browser refuses to submit the form without
 * them - which would mean a description could only be previewed once the rest of the
 * form was filled in, and a description is most often previewed while it is being
 * written. Preview saves nothing, so nothing is riding on the fields it skips.
 *
 * @return bool
 */
function events_is_description_preview()
{
    global $mybb;

    return $mybb->request_method === 'post' && $mybb->get_input('preview_description') !== '';
}

/**
 * The panel that shows what the description will look like.
 *
 * Rendered with the same events_parse_description() the event page uses, so the preview
 * is the page rather than an approximation of it.
 *
 * @param string $description Raw, as typed
 * @return string
 */
function events_description_preview($description)
{
    $body = events_parse_description($description);

    if($body === '')
    {
        $body = '<p class="events_preview_empty">The description is empty.</p>';
    }

    return '<div class="events_preview" id="event_description_preview">'
         . '<h2 class="events_preview_heading">Description Preview</h2>'
         . '<div class="events_preview_body" id="event_description_preview_body">' . $body . '</div>'
         . '</div>';
}

/**
 * One date box and the time beside it.
 *
 * Rendered here rather than by each form so the Admin CP and the front end post the same
 * two fields under the same two names. Only the class differs, because the control has to
 * look like the form it is in: MyBB's own .text_input in the Admin CP, the plugin's
 * .events_input on the board.
 *
 * The date keeps the field's plain name, so what the rest of the plugin already calls
 * start_date is still what the date box posts; the time arrives as "{$name}_time" and
 * events_posted_datetime() puts the two back together.
 *
 * autocomplete is off because the browser's own suggestion list covers the calendar, which
 * opens on the same focus.
 *
 * @param string $name
 * @param string $id
 * @param string $value 'Y-m-d H:i:s', or empty
 * @param array $options input_class, required, time_required, described, label
 * @return string
 */
function events_datetime_field($name, $id, $value, array $options = array())
{
    $input_class = isset($options['input_class']) ? $options['input_class'] : 'events_input';
    $label = isset($options['label']) ? $options['label'] : $name;
    $parts = events_datetime_parts($value);

    $required = !empty($options['required']) ? ' required="required"' : '';
    $time_required = !empty($options['time_required']) ? ' required="required"' : '';
    $described = !empty($options['described']) ? ' aria-describedby="hint_' . $id . '"' : '';

    return '<span class="events_datetime">'
         . '<input type="text" class="' . $input_class . ' events_datepicker" name="' . $name . '"'
         . ' id="' . $id . '" value="' . htmlspecialchars_uni($parts['date']) . '"'
         . ' placeholder="YYYY-MM-DD" autocomplete="off"'
         . ' aria-label="' . htmlspecialchars_uni($label . ' date') . '"' . $required . $described . ' />'
         . '<input type="time" class="' . $input_class . ' events_time_input" name="' . $name . '_time"'
         . ' id="' . $id . '_time" value="' . htmlspecialchars_uni($parts['time']) . '"'
         . ' aria-label="' . htmlspecialchars_uni($label . ' time') . '"' . $time_required . ' />'
         . '</span>';
}

/**
 * Split a stored date and time into the two boxes that render it.
 *
 * A bare 'Y-m-d' is a posted date whose time was left blank, and it comes back with the
 * time box blank too - read as midnight, a form re-rendered after an error would fill in
 * a time nobody typed, and the next submit would sail past the check that asked for one.
 *
 * @param string $value 'Y-m-d H:i:s', 'Y-m-d', or empty / the zero date for an unset one
 * @return array date ('Y-m-d') and time ('H:i'), both '' when unset
 */
function events_datetime_parts($value)
{
    $value = trim((string)$value);
    $stamp = events_strtotime($value);

    if($stamp === false)
    {
        return array('date' => '', 'time' => '');
    }

    if(strlen($value) <= 10)
    {
        return array('date' => events_date('Y-m-d', $stamp), 'time' => '');
    }

    // H:i, not H:i:s: a time input with no step shows and posts whole minutes, and handing
    // it seconds it will drop makes the box disagree with what was saved.
    return array('date' => events_date('Y-m-d', $stamp), 'time' => events_date('H:i', $stamp));
}

/**
 * Read one date box and its time back into the 'Y-m-d H:i:s' the rest of the plugin
 * carries dates around as.
 *
 * Nothing is checked here - events_datetime_error() is what says a date is unusable. The
 * one case decided here is the empty one: no date means the field is unset, which is how
 * an optional date (the signup cutoff) says there is no cutoff. A time on its own is not a
 * date, so it goes with it.
 *
 * A date with its time left blank comes back as the bare 'Y-m-d', not as midnight, so the
 * validator can tell the two apart. Filled in as 00:00, an end date typed without a time
 * put the end of a one-day event at the very start of its day: signups locked, the troop
 * report opened and the reminders went out before anybody had arrived. Where a blank time
 * is allowed (only the signup cutoff), events_strtotime() still reads the bare date as
 * midnight.
 *
 * @param string $name
 * @return string '' when the field was left unset, 'Y-m-d' when only its time was
 */
function events_posted_datetime($name)
{
    global $mybb;

    $date = trim($mybb->get_input($name));
    $time = trim($mybb->get_input($name . '_time'));

    if($date === '')
    {
        return '';
    }

    return $time === '' ? $date : $date . ' ' . $time;
}

/**
 * Why a date and time cannot be used, or '' when it can.
 *
 * checkdate() rather than strtotime(), which does not reject a date that does not exist:
 * PHP reads '2026-02-30' as the 2nd of March and '0000-00-00' as a real moment in the year
 * zero. Either would have been saved as a date nobody chose rather than handed back as a
 * mistake, and the picker is not the only way into these fields - the box can be typed in,
 * and the form can be posted without it.
 *
 * @param string $value From events_posted_datetime()
 * @param string $label How the field reads in a message, e.g. 'start date'
 * @return string empty when the value is usable
 */
function events_datetime_error($value, $label)
{
    $value = trim((string)$value);
    $date = substr($value, 0, 10);
    $time = trim(substr($value, 10));

    if(!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $date, $parts)
        || !checkdate((int)$parts[2], (int)$parts[3], (int)$parts[1]))
    {
        return "The " . $label . " must be a real date, as YYYY-MM-DD.";
    }

    if($time !== '' && events_strtotime($date . ' ' . $time) === false)
    {
        return "The " . $label . " time '" . $time
            . "' is not a valid time (HH:MM).";
    }

    return '';
}

/**
 * Users who can be assigned as an event's coordinator.
 *
 * The list is drawn from the groups named in the Event Coordinator User Groups setting,
 * matching either a user's primary group or any of their additional ones, and is sorted
 * by username so a long list can be read down.
 *
 * Extra user ids are folded in for the people a form has to offer whether or not they are
 * in those groups: whoever is filling it in, who can always take an event on themselves,
 * and the event's existing coordinator, because editing an event is not the place to be
 * told its coordinator is no longer valid.
 *
 * @param array $extra_uids user ids to include regardless of group membership
 * @return array uid => username
 */
function events_coordinator_choices($extra_uids = array())
{
    global $db;

    $conditions = array();

    foreach(explode(',', (string)events_get_setting('event_coordinator_groups')) as $gid)
    {
        $gid = (int)$gid;
        if(!$gid)
        {
            continue;
        }

        // additionalgroups is a bare comma separated list, so both it and the id being
        // looked for are padded with commas - otherwise group 1 would match group 11.
        $conditions[] = "usergroup = " . $gid;
        $conditions[] = "CONCAT(',', additionalgroups, ',') LIKE '%," . $gid . ",%'";
    }

    $extra = array();
    foreach((array)$extra_uids as $uid)
    {
        $uid = (int)$uid;
        if($uid)
        {
            $extra[$uid] = $uid;
        }
    }

    if(!empty($extra))
    {
        $conditions[] = "uid IN (" . implode(',', $extra) . ")";
    }

    // No groups configured and nobody passed in: the board has not said who may
    // coordinate, so nothing is offered rather than everybody.
    if(empty($conditions))
    {
        return array();
    }

    $query = $db->simple_select("users", "uid, username", implode(' OR ', $conditions));

    $users = array();
    while($user = $db->fetch_array($query))
    {
        $users[(int)$user['uid']] = $user['username'];
    }

    // Sorted here rather than with ORDER BY because which names come first in SQL depends
    // on the column's collation, and a board running a case sensitive one would list
    // every lowercase username after the uppercase ones.
    uasort($users, 'strcasecmp');

    return $users;
}

/**
 * The coordinator select's options: the choices, led by a blank one.
 *
 * An event whose coordinator has been deleted names a uid that is no longer on the list,
 * and a select with nothing matching its value falls back to its first option. Without a
 * blank one that was whoever sorts first, so anybody who saved the event without looking
 * at the field made that member its coordinator. The blank option posts 0, which the
 * validator refuses like any other uid not on the list.
 *
 * @param array $choices From events_coordinator_choices()
 * @return array value => label
 */
function events_coordinator_select_options(array $choices)
{
    return array('' => 'Choose a coordinator') + $choices;
}

/**
 * Members who can be named as an event's point of contact.
 *
 * Anybody signed up to the event - in either role, since a wrangler is on the day as much
 * as a trooper is - plus the extra user ids a form has to offer regardless: whoever is
 * filling it in, who can always name themselves, and the event's existing point of contact,
 * for the same reason events_coordinator_choices() keeps the existing coordinator. Somebody
 * who has since withdrawn their signup stays named until the coordinator says otherwise,
 * rather than being dropped by an unrelated edit.
 *
 * "Nobody" is not in the list; the forms offer it themselves as the first option.
 *
 * @param int $event_id 0 for an event not yet created, which has no signups
 * @param array $extra_uids user ids to include whether or not they have signed up
 * @return array uid => username, sorted by username
 */
function events_poc_choices($event_id, $extra_uids = array())
{
    global $db;

    $conditions = array();

    $event_id = (int)$event_id;
    if($event_id)
    {
        $conditions[] = "uid IN (SELECT user_id FROM " . TABLE_PREFIX . "event_plugin_rsvps"
            . " WHERE event_id = " . $event_id . " AND status = 'attending')";
    }

    $extra = array();
    foreach((array)$extra_uids as $uid)
    {
        $uid = (int)$uid;
        if($uid)
        {
            $extra[$uid] = $uid;
        }
    }

    if(!empty($extra))
    {
        $conditions[] = "uid IN (" . implode(',', $extra) . ")";
    }

    if(empty($conditions))
    {
        return array();
    }

    $query = $db->simple_select("users", "uid, username", implode(' OR ', $conditions));

    $users = array();
    while($user = $db->fetch_array($query))
    {
        $users[(int)$user['uid']] = $user['username'];
    }

    // Sorted in PHP for the same collation reason as events_coordinator_choices().
    uasort($users, 'strcasecmp');

    return $users;
}

/**
 * The point of contact select's options: nobody first, then everybody who may be named.
 *
 * Built here so both forms offer the same list under the same "nobody" value, which is
 * what events_validate_event_input() reads as the field being left unset.
 *
 * @param array $event The event being edited, or empty when creating
 * @return array uid => label, with 0 => 'None'
 */
function events_poc_options(array $event = array())
{
    global $mybb;

    // The stored point of contact rather than the posted one, so a forged uid that failed
    // validation does not earn itself a place on the list when the form comes back.
    return array(0 => 'None') + events_poc_choices(
        isset($event['id']) ? $event['id'] : 0,
        array($mybb->user['uid'], isset($event['poc_user_id']) ? $event['poc_user_id'] : 0)
    );
}

/**
 * Turn the exclusions field's comma separated list into a list of user ids.
 *
 * Accepts usernames and/or user ids. A token that matches nobody is reported through
 * $unknown rather than dropped: the field is a tag input that will only let a real member
 * be picked, and something that got past it is a mistake worth showing rather than an
 * exclusion that silently does not exist.
 *
 * A token is read as a username first and as a user id only when no member has that
 * name. The tag field posts usernames, so a member named "42" is who "42" means - reading
 * it as uid 42 first excluded somebody else and withdrew their signup.
 *
 * @param string $input
 * @param array|null $unknown Set to the tokens that matched no member
 * @return array of int
 */
function events_parse_exclusions($input, &$unknown = null)
{
    global $db;

    $unknown = array();
    $uids = array();
    foreach(explode(',', (string)$input) as $token)
    {
        $token = trim($token);
        if($token === '')
        {
            continue;
        }

        $user = $db->fetch_array($db->simple_select("users", "uid", "username = '" . $db->escape_string($token) . "'"));
        if(!$user && ctype_digit($token))
        {
            $user = $db->fetch_array($db->simple_select("users", "uid", "uid = " . (int)$token));
        }

        if($user)
        {
            $uids[] = (int)$user['uid'];
        }
        else
        {
            $unknown[] = $token;
        }
    }

    return array_values(array_unique($uids));
}

/**
 * The usernames currently excluded from an event, for the exclusions box.
 *
 * @param int $event_id
 * @return array of string
 */
function events_get_event_exclusion_names($event_id)
{
    global $db;

    $names = array();
    $query = $db->query("
        SELECT u.username
        FROM " . TABLE_PREFIX . "event_plugin_event_exclusions x
        INNER JOIN " . TABLE_PREFIX . "users u ON x.user_id = u.uid
        WHERE x.event_id = " . (int)$event_id . "
        ORDER BY u.username ASC
    ");
    while($row = $db->fetch_array($query))
    {
        $names[] = $row['username'];
    }

    return $names;
}

/**
 * The excluded members field.
 *
 * What is rendered here is a plain text box holding the comma separated list the server
 * reads, which is all there is with the script turned off. events_tag_field_script() finds
 * it by the wrapper's data attribute and builds the tag input around it, keeping this box
 * as the thing that posts - so the two forms, and the server, only ever deal with the one
 * format the field has always had.
 *
 * The username search is MyBB's own xmlhttp.php, whose path differs between the board and
 * the Admin CP, so it is handed over as an attribute rather than assumed by the script.
 *
 * @param string $value Comma separated usernames
 * @param array $options id, input_class, search_url, described
 * @return string
 */
function events_exclusions_field($value, array $options)
{
    $id = $options['id'];
    $input_class = isset($options['input_class']) ? $options['input_class'] : 'events_input';

    return '<div class="events_tag_field" data-events-tag-field="1"'
         . ' data-events-tag-source="' . htmlspecialchars_uni($options['search_url']) . '">'
         . '<input type="text" class="' . $input_class . '" name="exclusions" id="' . $id . '"'
         . ' value="' . htmlspecialchars_uni((string)$value) . '" autocomplete="off"'
         . (empty($options['described']) ? '' : ' aria-describedby="hint_' . $id . '"')
         . ' />'
         . '</div>';
}

/**
 * The form's starting values for an event that already exists, or for a blank one.
 *
 * Both callers render from this shape, so a failed submit can hand back
 * events_event_form_input() in its place and the form fills itself in identically.
 *
 * @param array $event Event row, or empty for a new event
 * @return array
 */
function events_event_form_values(array $event = array())
{
    global $mybb;

    if(empty($event['id']))
    {
        return array(
            'title'         => '',
            'description'   => '',
            'status'        => 'pending',
            'region'        => 'Sydney',
            'address'       => '',
            'start_date'    => '',
            'end_date'      => '',
            'signup_cutoff' => '',
            'requires_wwcc' => 0,
            'gec_user_id'   => (int)$mybb->user['uid'],
            'poc_user_id'   => 0,
            'max_troopers'  => '',
            'max_wranglers' => '',
            'days'          => array(),
            'exclusions'    => '',
        );
    }

    $event_id = (int)$event['id'];

    $days = array();
    foreach(events_get_event_days($event_id) as $day)
    {
        $days[] = array(
            'date'       => $day['date'],
            'start_time' => $day['start_time'],
            'end_time'   => $day['end_time'],
        );
    }

    // A cleared cutoff is NULL in the database (see events_save_event), and older rows can
    // still hold MySQL's zero date. Neither belongs in a text box.
    $cutoff = isset($event['signup_cutoff']) ? (string)$event['signup_cutoff'] : '';
    if($cutoff === '0000-00-00 00:00:00')
    {
        $cutoff = '';
    }

    return array(
        'title'         => $event['title'],
        'description'   => $event['description'],
        'status'        => $event['status'],
        'region'        => $event['region'],
        // Events written before the column existed have no key at all on a board that has
        // not been re-activated yet, so this is read defensively rather than as a string.
        'address'       => isset($event['address']) ? (string)$event['address'] : '',
        'start_date'    => $event['start_date'],
        'end_date'      => $event['end_date'],
        'signup_cutoff' => $cutoff,
        'requires_wwcc' => (int)$event['requires_wwcc'],
        'gec_user_id'   => (int)$event['gec_user_id'],
        // Read defensively for the same reason as the address above.
        'poc_user_id'   => isset($event['poc_user_id']) ? (int)$event['poc_user_id'] : 0,
        // No limit is stored as 0 and shown as an empty box, which is what the hint says
        // to leave it as.
        'max_troopers'  => events_event_cap($event, 'trooper') ? (string)events_event_cap($event, 'trooper') : '',
        'max_wranglers' => events_event_cap($event, 'wrangler') ? (string)events_event_cap($event, 'wrangler') : '',
        'days'          => $days,
        'exclusions'    => implode(', ', events_get_event_exclusion_names($event_id)),
    );
}

/**
 * Read the posted event form into the same shape events_event_form_values() returns.
 *
 * Nothing is escaped or reformatted here: the array goes back to the form as-is when
 * validation fails, so what the user typed is what they see again.
 *
 * @return array
 */
function events_event_form_input()
{
    global $mybb;

    $days = array();
    foreach((array)$mybb->get_input('event_days', MyBB::INPUT_ARRAY) as $day)
    {
        $day = (array)$day;
        $date = isset($day['date']) ? trim((string)$day['date']) : '';

        // The forms post a day's date as a hidden field they filled in themselves, so a
        // blank one is a row that was never meant to be there rather than an error to
        // report back.
        if($date === '')
        {
            continue;
        }

        $days[] = array(
            'date'       => $date,
            'start_time' => isset($day['start_time']) ? trim((string)$day['start_time']) : '',
            'end_time'   => isset($day['end_time']) ? trim((string)$day['end_time']) : '',
        );
    }

    return array(
        'title'         => trim($mybb->get_input('title')),
        'description'   => $mybb->get_input('description'),
        'status'        => $mybb->get_input('status'),
        'region'        => $mybb->get_input('region'),
        'address'       => trim($mybb->get_input('address')),
        'start_date'    => events_posted_datetime('start_date'),
        'end_date'      => events_posted_datetime('end_date'),
        'signup_cutoff' => events_posted_datetime('signup_cutoff'),
        'requires_wwcc' => $mybb->get_input('requires_wwcc', MyBB::INPUT_INT) ? 1 : 0,
        'gec_user_id'   => $mybb->get_input('gec_user_id', MyBB::INPUT_INT),
        'poc_user_id'   => $mybb->get_input('poc_user_id', MyBB::INPUT_INT),
        'max_troopers'  => trim($mybb->get_input('max_troopers')),
        'max_wranglers' => trim($mybb->get_input('max_wranglers')),
        'days'          => $days,
        'exclusions'    => $mybb->get_input('exclusions'),
    );
}

/**
 * Validate a submitted event.
 *
 * @param array $input From events_event_form_input()
 * @param array $event The event being edited, or empty when creating
 * @return array of plain-text error strings, empty when the event can be saved. They
 *         quote what was posted, so each renderer escapes them: events_form_errors() on
 *         the front end, and the Admin CP before output_inline_error(), which echoes raw.
 */
function events_validate_event_input(array $input, array $event = array())
{
    global $mybb;

    $errors = array();

    if($input['title'] === '')
    {
        $errors[] = "A title is required.";
    }
    elseif(my_strlen($input['title']) > EVENTS_TITLE_MAX_LENGTH)
    {
        $errors[] = "The title is too long (" . EVENTS_TITLE_MAX_LENGTH . " characters at most).";
    }

    // Each date is checked on its own before the two are compared, so an event is never
    // told its end is before its start on the strength of a date that is not a date.
    //
    // The article is spelled out beside each label rather than derived from it, which is
    // what produced "A end date is required."
    //
    // Both need a time as well as a date. There is no sensible default: midnight puts an
    // end at the start of the last day rather than the end of it, and a start at an hour
    // no troop begins.
    $date_fields = array(
        'start_date' => array('label' => 'start date', 'article' => 'A'),
        'end_date'   => array('label' => 'end date',   'article' => 'An'),
    );

    $stamps = array();
    foreach($date_fields as $field => $spec)
    {
        $label = $spec['label'];

        if($input[$field] === '')
        {
            $errors[] = $spec['article'] . " " . $label . " is required.";
            continue;
        }

        $error = events_datetime_error($input[$field], $label);
        if($error !== '')
        {
            $errors[] = $error;
            continue;
        }

        if(strlen(trim($input[$field])) <= 10)
        {
            $errors[] = $spec['article'] . " " . $label . " needs a time as well as a date.";
            continue;
        }

        $stamps[$field] = events_strtotime($input[$field]);
    }

    // Strictly later: an event that ends the moment it starts has ended before anybody
    // could sign up for it.
    if(isset($stamps['start_date'], $stamps['end_date']) && $stamps['end_date'] <= $stamps['start_date'])
    {
        $errors[] = "The end must be later than the start.";
    }

    if($input['signup_cutoff'] !== '')
    {
        $error = events_datetime_error($input['signup_cutoff'], 'signup cutoff');
        if($error !== '')
        {
            $errors[] = $error;
        }
        // Signups already close when the event ends, so a cutoff after that is a date that
        // never applies - and read on the event page as signups still being open after it.
        // A cutoff exactly at the end is allowed; it says the same thing as having none.
        elseif(isset($stamps['end_date']) && events_strtotime($input['signup_cutoff']) > $stamps['end_date'])
        {
            $errors[] = "The signup cutoff cannot be later than the end of the event.";
        }
    }

    $statuses = events_event_statuses();
    if(!isset($statuses[$input['status']]))
    {
        $errors[] = "Invalid status.";
    }
    if(!in_array($input['region'], events_regions(), true))
    {
        $errors[] = "Invalid region.";
    }

    // The column is varchar(255) and MySQL would truncate anything longer without saying
    // so, leaving a map link pointing at half an address.
    if(my_strlen($input['address']) > 255)
    {
        $errors[] = "The address cannot be longer than 255 characters.";
    }

    // The coordinator arrives as a select box on both forms, so anything not on the list
    // is a forged post rather than a mistake. The event's current coordinator counts even
    // if they have since left the coordinator groups - editing an event is not the place
    // to be told its existing coordinator is no longer valid.
    $allowed_coordinators = array_keys(events_coordinator_choices(array(
        $mybb->user['uid'],
        isset($event['gec_user_id']) ? $event['gec_user_id'] : 0,
    )));
    if(!in_array((int)$input['gec_user_id'], $allowed_coordinators, true))
    {
        $errors[] = "Choose an event coordinator from the list.";
    }

    // Optional, and a select box on both forms like the coordinator: 0 is "nobody", and
    // anything else has to be somebody signed up to the event, the person saving it, or
    // whoever it already names.
    if((int)$input['poc_user_id'] !== 0
        && !array_key_exists((int)$input['poc_user_id'], events_poc_options($event)))
    {
        $errors[] = "Choose a point of contact from the list: somebody signed up to the event, or yourself.";
    }

    // A maximum is a count of people, so a whole number; empty is no limit, and so is 0.
    foreach(array('max_troopers' => 'maximum number of troopers', 'max_wranglers' => 'maximum number of wranglers') as $field => $label)
    {
        if($input[$field] !== '' && (!ctype_digit($input[$field]) || (int)$input[$field] > EVENTS_MAX_PLACES))
        {
            $errors[] = "The " . $label . " must be a whole number from 0 to " . EVENTS_MAX_PLACES . ", or empty for no limit.";
        }
    }

    // The exclusions field only lets a real member be picked, so a name that matches
    // nobody has either been typed with the script off or mistyped into a form that was
    // then submitted without it. Either way the event is not saved excluding somebody who
    // does not exist without a word about it.
    $unknown = array();
    events_parse_exclusions($input['exclusions'], $unknown);
    foreach($unknown as $token)
    {
        $errors[] = "There is no member named '" . $token . "'.";
    }

    // Each valid day's hours, by date, for the overnight check below.
    $hours = array();

    foreach($input['days'] as $day)
    {
        if(!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $day['date'], $ymd)
            || !checkdate((int)$ymd[2], (int)$ymd[3], (int)$ymd[1]))
        {
            $errors[] = "Event day '" . $day['date'] . "' is not a valid date.";
            continue;
        }

        // Times are validated as well as dates because this form is no longer admins only.
        // An unparseable time would otherwise reach a TIME column and fail as a SQL error
        // rather than as something the form could explain.
        $valid = true;
        foreach(array('start_time' => 'start time', 'end_time' => 'end time') as $field => $label)
        {
            if($day[$field] !== '' && events_parse_day_time($day[$field]) === false)
            {
                $errors[] = "The " . $label . " '" . $day[$field]
                    . "' for " . $day['date'] . " is not a valid time (HH:MM:SS).";
                $valid = false;
            }
        }

        // Compared as the strings they are stored as, with the same defaults a blank box
        // saves as. A day stores only its hours, so one that ends earlier than it starts
        // is a night that runs past midnight - a 22:00 to 01:00 troop - and every reader
        // of a day (the feed, the labels) finishes it on the following date. The same time
        // at both ends is either no time at all or a whole day, and a whole day is what a
        // blank pair of boxes already says, so that one is refused as the mistake it is.
        if($valid && events_day_time($day, 'end_time') === events_day_time($day, 'start_time'))
        {
            $errors[] = "The start and end times for " . $day['date'] . " are the same.";
        }
        elseif($valid)
        {
            $hours[$day['date']] = array(events_day_time($day, 'start_time'), events_day_time($day, 'end_time'));
        }
    }

    // A night running past midnight must be over before the next day begins, or the two
    // rows claim the same hours and a member signed up for both is booked twice at once.
    // A blank start box is midnight, so the next day has to be given its hours.
    foreach($hours as $date => $times)
    {
        $next = events_date('Y-m-d', events_strtotime($date . ' +1 day'));
        if($times[1] < $times[0] && isset($hours[$next]) && $times[1] > $hours[$next][0])
        {
            $errors[] = "The hours for " . $date . " run past midnight into " . $next
                . ", which starts at " . substr($hours[$next][0], 0, 5) . ".";
        }
    }

    return $errors;
}

/**
 * Read a time of day as H:i:s, or false if it is not one.
 *
 * Only a clock time is accepted - H:MM or H:MM:SS, 24-hour - and it is read as digits
 * rather than through strtotime(), which would build it on today's date in the event
 * zone. That moved 02:30 to 03:30 on a spring-forward day, and it took "now" or
 * "+3 hours" as a time. A day's times belong to that day's date, not to today's.
 *
 * @param string $value
 * @return string|false
 */
function events_parse_day_time($value)
{
    if(!preg_match('/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/', trim((string)$value), $m))
    {
        return false;
    }

    $seconds = isset($m[3]) ? (int)$m[3] : 0;
    if((int)$m[1] > 23 || (int)$m[2] > 59 || $seconds > 59)
    {
        return false;
    }

    return sprintf('%02d:%02d:%02d', (int)$m[1], (int)$m[2], $seconds);
}

/**
 * A posted day's start or end time as it is stored: a blank box is the whole day's edge.
 *
 * @param array $day From events_event_form_input(), already validated
 * @param string $field start_time or end_time
 * @return string H:i:s
 */
function events_day_time(array $day, $field)
{
    $time = $day[$field] !== '' ? events_parse_day_time($day[$field]) : false;
    if($time === false)
    {
        return $field === 'start_time' ? '00:00:00' : '23:59:59';
    }

    return $time;
}

/**
 * Bring an event's day rows into line with the posted days, keeping the rows that survive.
 *
 * A signup records its days as event_day ids, so replacing the rows wholesale - as this
 * once did - gave every day a new id on every save and cut each signup off from the days
 * it was for, without a word to anybody. Days are matched on their date instead, which is
 * what the form draws a row for: a date still on the event keeps its row and has its times
 * updated, a new date gets a new row, and a date that has gone is deleted along with any
 * claim still on it. events_save_event() has already cancelled the signups holding one:
 * dropping only the claim left a signup with no days, which reads as "every day".
 *
 * @param int $event_id
 * @param array $days From events_event_form_input(), already validated
 * @return void
 */
function events_save_event_days($event_id, array $days)
{
    global $db;

    $event_id = (int)$event_id;

    $existing = array();
    foreach(events_get_event_days($event_id) as $day)
    {
        $existing[$day['date']] = (int)$day['id'];
    }

    $kept = array();
    foreach($days as $day)
    {
        $date = events_date('Y-m-d', events_strtotime($day['date']));
        $row = array(
            'start_time' => $db->escape_string(events_day_time($day, 'start_time')),
            'end_time'   => $db->escape_string(events_day_time($day, 'end_time')),
        );

        // The grid never posts a date twice, but a hand-built POST could; the first wins.
        if(isset($kept[$date]))
        {
            continue;
        }

        if(isset($existing[$date]))
        {
            $db->update_query("event_plugin_event_days", $row, "id = " . $existing[$date]);
            $kept[$date] = $existing[$date];
        }
        else
        {
            $row['event_id'] = $event_id;
            $row['date'] = $db->escape_string($date);
            $kept[$date] = (int)$db->insert_query("event_plugin_event_days", $row);
        }
    }

    $removed = array_values(array_diff($existing, $kept));
    if($removed)
    {
        $ids = implode(',', array_map('intval', $removed));

        // Going back to one day deletes the day it still runs on too, and the signups for
        // it become day-less ones, queued by rsvp_date (events_signup_queues()). That is
        // when each member first signed up, not when they claimed this day, so a member
        // who switched to it late would jump everybody who was there first. The claim's
        // claimed_at is carried onto the signup so the queue keeps its order. Every claim
        // left is on that day: events_save_event() has cancelled the signups for the rest.
        if(empty($days))
        {
            $db->write_query("
                UPDATE " . TABLE_PREFIX . "event_plugin_rsvps r
                INNER JOIN (
                    SELECT rsvp_id, MIN(claimed_at) AS claimed_at
                    FROM " . TABLE_PREFIX . "event_plugin_rsvp_days
                    WHERE event_day_id IN (" . $ids . ")
                    GROUP BY rsvp_id
                ) d ON d.rsvp_id = r.id
                SET r.rsvp_date = d.claimed_at
                WHERE r.event_id = " . $event_id . "
            ");
        }

        $db->delete_query("event_plugin_rsvp_days", "event_day_id IN (" . $ids . ")");
        $db->delete_query("event_plugin_event_days", "id IN (" . $ids . ")");
    }
}

/**
 * The event's days that saving this form takes away from it.
 *
 * Matched on date the same way events_save_event_days() matches them: a date that is no
 * longer among the posted days. Moving an event loses every one of them.
 *
 * Turning an event back into a single-day one posts no days at all, and every row is then
 * deleted - but the day it now runs on has not gone anywhere. A signup for that day is
 * left with no day rows, which for a single-day event is exactly right, so it is not
 * counted here.
 *
 * A single-day event has no day rows, but it still runs on a day, and moving it takes
 * that day away just as surely. It comes back as a stand-in row with id 0 - the place
 * events_signup_queues() files a day-less signup under - dated and timed from the event
 * as it was before this save. Growing it into several days that still include that date
 * removes nothing.
 *
 * @param int $event_id
 * @param array $input From events_event_form_input(), already validated
 * @return array of event_day rows
 */
function events_removed_event_days($event_id, array $input)
{
    $posted = array();
    foreach($input['days'] as $day)
    {
        $posted[events_date('Y-m-d', events_strtotime($day['date']))] = true;
    }
    if(empty($posted))
    {
        $posted[events_date('Y-m-d', events_strtotime($input['start_date']))] = true;
    }

    $days = events_get_event_days($event_id);
    if(empty($days))
    {
        $day = events_single_event_day($event_id);

        return ($day && !isset($posted[$day['date']])) ? array($day) : array();
    }

    $removed = array();
    foreach($days as $day)
    {
        if(!isset($posted[$day['date']]))
        {
            $removed[] = $day;
        }
    }

    return $removed;
}

/**
 * The one day a single-day event runs on, as a stand-in event_day row with id 0.
 *
 * Read from the event as it is stored, so it has to be asked before a save writes the
 * new dates over it.
 *
 * @param int $event_id
 * @return array|null array('id', 'date', 'start_time', 'end_time'), or null for no such event
 */
function events_single_event_day($event_id)
{
    $event = events_get_event($event_id);
    if(!$event)
    {
        return null;
    }

    $start = events_strtotime($event['start_date']);
    $end = events_strtotime($event['end_date']);
    $date = events_date('Y-m-d', $start);

    // Hours are only given when both ends fall on that date; events_day_label() reads
    // them against it, and an event running past midnight would come out backwards.
    $same_day = events_date('Y-m-d', $end) === $date;

    return array(
        'id'         => 0,
        'date'       => $date,
        'start_time' => $same_day ? events_date('H:i:s', $start) : '',
        'end_time'   => $same_day ? events_date('H:i:s', $end) : '',
    );
}

/**
 * The members signed up for any of these days, and which of them each one holds.
 *
 * Waitlisted claims count: a place in the queue for a day that is going is a signup the
 * save cancels like any other, and its member is told the same way.
 *
 * The stand-in day 0 of a single-day event (events_single_event_day()) is held by every
 * signup with no day claims, which on such an event is every signup.
 *
 * @param int $event_id
 * @param array $removed_days event_day rows, from events_removed_event_days()
 * @return array uid => array('uid', 'username', 'day_ids'), ordered by username
 */
function events_day_change_signups($event_id, array $removed_days)
{
    global $db;

    if(empty($removed_days))
    {
        return array();
    }

    $ids = implode(',', array_map(function($day) { return (int)$day['id']; }, $removed_days));

    $members = array();
    $query = $db->query("
        SELECT r.user_id, u.username, COALESCE(d.event_day_id, 0) AS event_day_id
        FROM " . TABLE_PREFIX . "event_plugin_rsvps r
        LEFT JOIN " . TABLE_PREFIX . "event_plugin_rsvp_days d ON d.rsvp_id = r.id
        LEFT JOIN " . TABLE_PREFIX . "users u ON u.uid = r.user_id
        WHERE r.event_id = " . (int)$event_id . "
          AND COALESCE(d.event_day_id, 0) IN (" . $ids . ")
        ORDER BY u.username ASC, event_day_id ASC
    ");
    while($row = $db->fetch_array($query))
    {
        $uid = (int)$row['user_id'];
        if(!isset($members[$uid]))
        {
            $members[$uid] = array('uid' => $uid, 'username' => (string)$row['username'], 'day_ids' => array());
        }

        $day_id = (int)$row['event_day_id'];
        if(!in_array($day_id, $members[$uid]['day_ids'], true))
        {
            $members[$uid]['day_ids'][] = $day_id;
        }
    }

    return $members;
}

/**
 * The signups a save would cancel, when the person saving has not yet agreed to it.
 *
 * Removing a day used to delete the signups' claims on it and keep the signups, so moving
 * an event left every signup with no days - which the event page reads as "all days" and
 * the attendance sheet as none. Saving now cancels those signups outright (see
 * events_save_event()), and because that is somebody else's signup going, both forms stop
 * and say who first. The confirm button posts a token of exactly what was shown, so a
 * form edited again before confirming - or a signup that arrives in between - is warned
 * about afresh rather than carried through on the earlier answer.
 *
 * Lowering a maximum is the same kind of change - it takes confirmed places away from
 * people who hold them - so it is asked about in the same warning, under the same token.
 * Raising one only ever gives places out, and needs no asking.
 *
 * @param int $event_id 0 for a new event, which has nothing to cancel
 * @param array $input From events_event_form_input(), already validated
 * @return array|null array('removed', 'members', 'demoted', 'token'), or null when the save can go ahead
 */
function events_day_change_to_confirm($event_id, array $input)
{
    global $mybb;

    if((int)$event_id <= 0)
    {
        return null;
    }

    $removed = events_removed_event_days($event_id, $input);
    $members = events_day_change_signups($event_id, $removed);

    // A member being excluded in the same save is withdrawn by the exclusion, and is not
    // sent the PM, so they are not somebody this save cancels on account of the days.
    $excluded = events_parse_exclusions($input['exclusions']);
    $members = array_diff_key($members, array_flip($excluded));

    $demoted = events_cap_change_demotions($event_id, $input, $removed, array_merge($excluded, array_keys($members)));

    if(empty($members) && empty($demoted))
    {
        return null;
    }

    $day_ids = array_map(function($day) { return (int)$day['id']; }, $removed);
    $demoted_key = array();
    foreach($demoted as $uid => $member)
    {
        foreach($member['places'] as $role => $place_days)
        {
            $demoted_key[] = $uid . ':' . $role . ':' . implode('.', $place_days);
        }
    }
    $token = md5(implode(',', $day_ids) . '|' . implode(',', array_keys($members)) . '|' . implode(',', $demoted_key));

    if($mybb->get_input('confirm_day_changes') === $token)
    {
        return null;
    }

    return array('removed' => $removed, 'members' => $members, 'demoted' => $demoted, 'token' => $token);
}

/**
 * The members a save's maximums would move from a place to the waitlist.
 *
 * Asked of the queues as the save will leave them: the members whose signups it cancels
 * or withdraws, and the days it removes, are already out of the way, since the places
 * they free are places nobody else has to give up.
 *
 * @param int $event_id
 * @param array $input From events_event_form_input(), already validated
 * @param array $removed_days From events_removed_event_days()
 * @param int[] $dropped_uids Members whose signups the save removes
 * @return array uid => array('uid', 'username', 'places' => role => day ids, 'labels'), ordered by username
 */
function events_cap_change_demotions($event_id, array $input, array $removed_days, array $dropped_uids)
{
    $event = events_get_event($event_id);

    // A finished event is never rebalanced (events_rebalance_waitlist()), so nothing moves.
    if(!$event || events_strtotime($input['end_date']) <= TIME_NOW)
    {
        return array();
    }

    $moves = events_waitlist_moves($event,
        array('trooper' => (int)$input['max_troopers'], 'wrangler' => (int)$input['max_wranglers']),
        array('uids' => $dropped_uids, 'days' => array_map(function($day) { return (int)$day['id']; }, $removed_days)));

    $day_labels = array();
    foreach(events_get_event_days($event_id) as $day)
    {
        $day_labels[(int)$day['id']] = events_day_label($day);
    }

    $demoted = array();
    foreach(events_group_waitlist_moves($moves) as $uid => $member)
    {
        if(empty($member['demoted']))
        {
            continue;
        }

        $labels = array();
        foreach($member['demoted'] as $role => $day_ids)
        {
            $days = array();
            foreach($day_ids as $day_id)
            {
                if(isset($day_labels[$day_id]))
                {
                    $days[] = $day_labels[$day_id];
                }
            }

            $labels[] = events_role_verb($role) . (empty($days) ? '' : ' - ' . implode(', ', $days));
        }

        $user = events_get_user($uid);
        $demoted[$uid] = array(
            'uid'      => $uid,
            'username' => isset($user['username']) ? (string)$user['username'] : '',
            'places'   => $member['demoted'],
            'labels'   => $labels,
        );
    }

    uasort($demoted, function($a, $b) { return strcasecmp($a['username'], $b['username']); });

    return $demoted;
}

/**
 * The warning both forms show above themselves before cancelling signups.
 *
 * It has to sit inside the form: its button is a submit of the whole form, carrying the
 * token events_day_change_to_confirm() asked for, so what is confirmed is what is on the
 * screen. Anything else - saving normally again - is warned about again.
 *
 * @param array $change From events_day_change_to_confirm()
 * @param string $button_class The submit class of the form it sits in
 * @return string
 */
function events_day_change_warning(array $change, $button_class)
{
    $html = '';
    $actions = array();

    $count = count($change['members']);
    if($count)
    {
        $dates = array();
        foreach($change['removed'] as $day)
        {
            $dates[] = htmlspecialchars_uni(events_day_label($day));
        }

        $names = '';
        foreach($change['members'] as $member)
        {
            $names .= '<li>' . htmlspecialchars_uni($member['username']) . '</li>';
        }

        $noun = $count === 1 ? 'member is' : 'members are';

        $html .= '<p><strong>These changes remove ' . implode(', ', $dates) . ' from the event, and '
            . $count . ' ' . $noun . ' signed up for ' . (count($dates) === 1 ? 'it' : 'them') . ':</strong></p>'
            . '<ul id="event_day_change_members">' . $names . '</ul>'
            . '<p>Saving will cancel ' . ($count === 1 ? 'that signup' : 'those signups')
            . ' and send each of them a PM asking them to sign up again if the new times work for them.'
            . ' To keep them, change the dates below and save again.</p>';

        $actions[] = 'cancel ' . $count . ' ' . ($count === 1 ? 'signup' : 'signups');
    }

    $demoted = isset($change['demoted']) ? $change['demoted'] : array();
    if($demoted)
    {
        $names = '';
        foreach($demoted as $member)
        {
            $names .= '<li>' . htmlspecialchars_uni($member['username'])
                . ' (' . htmlspecialchars_uni(implode('; ', $member['labels'])) . ')</li>';
        }

        $demoted_count = count($demoted);
        $html .= '<p><strong>Lowering the maximum moves ' . $demoted_count . ' '
            . ($demoted_count === 1 ? 'member' : 'members') . ' from a place to the waitlist:</strong></p>'
            . '<ul id="event_cap_change_members">' . $names . '</ul>'
            . '<p>They are the most recent signups, and they keep their place at the front of the waitlist.'
            . ' Each of them will be sent a PM. To keep them, raise the maximum below and save again.</p>';

        $actions[] = 'move ' . $demoted_count . ' to the waitlist';
    }

    // Pressing Enter in a field submits with the form's first submit button, and this
    // warning sits above the form's own, so without the decoy in front of it Enter would
    // agree to the cancellations. The decoy is unnamed, like both forms' Save buttons, so
    // it is an ordinary save - which brings this warning straight back. Moved off screen
    // rather than display: none, which some browsers take as "no default button".
    return $html
        . '<p><button type="submit" class="events_default_submit" tabindex="-1" aria-hidden="true">Save</button>'
        . '<button type="submit" class="' . htmlspecialchars_uni($button_class) . '" name="confirm_day_changes"'
        . ' id="event_day_change_confirm" value="' . htmlspecialchars_uni($change['token']) . '">'
        . 'Save and ' . implode(' and ', $actions) . '</button></p>';
}

/**
 * PM each member whose signup a day change cancelled.
 *
 * Sent after the event is saved, so the dates it gives are the new ones. It comes from
 * whoever made the change, so a reply reaches somebody who can answer it. A member who is
 * excluded from the event is not told - the event is hidden from them, and a PM inviting
 * them to sign up again would be the one place it was still announced - and neither is
 * the person making the change, who has just been shown the list.
 *
 * @param int $event_id
 * @param array $removed_days event_day rows, read before they were deleted
 * @param array $members From events_day_change_signups()
 * @param int $from_uid
 * @return void
 */
function events_send_day_change_pms($event_id, array $removed_days, array $members, $from_uid)
{
    global $db, $mybb;

    require_once MYBB_ROOT . "inc/datahandlers/pm.php";

    $event = events_get_event($event_id);
    if(!$event || empty($members))
    {
        return;
    }

    $excluded = array();
    $query = $db->simple_select("event_plugin_event_exclusions", "user_id", "event_id = " . (int)$event_id);
    while($row = $db->fetch_array($query))
    {
        $excluded[] = (int)$row['user_id'];
    }

    $labels = array();
    foreach($removed_days as $day)
    {
        $labels[(int)$day['id']] = events_day_label($day);
    }

    $now_runs = '';
    foreach(events_get_event_days($event_id) as $day)
    {
        $now_runs .= "[*]" . events_day_label($day) . "\n";
    }
    if($now_runs === '')
    {
        // Labelled like the day it replaced when it starts and ends on one date, so a
        // moved single-day event reads as one day to another.
        $single = events_single_event_day($event_id);
        $now_runs = $single['start_time'] !== ''
            ? "[*]" . events_day_label($single) . "\n"
            : "[*]" . events_format_date($event['start_date']) . " - " . events_format_date($event['end_date']) . "\n";
    }

    $title = events_escape_bbcode($event['title']);

    $subject = "Event changed: " . $event['title'];
    if(my_strlen($subject) > 85)
    {
        $subject = my_substr($subject, 0, 82) . "...";
    }

    foreach($members as $member)
    {
        if(in_array($member['uid'], $excluded, true) || $member['uid'] === (int)$from_uid)
        {
            continue;
        }

        // Asked as the recipient: whoever saved may read threads in a forum they cannot.
        $url = $mybb->settings['bburl'] . '/' . events_event_url($event, $member['uid']);

        $held = '';
        foreach($member['day_ids'] as $day_id)
        {
            if(isset($labels[$day_id]))
            {
                $held .= "[*]" . $labels[$day_id] . "\n";
            }
        }

        $pmhandler = new PMDataHandler();
        $pmhandler->admin_override = true;
        $pmhandler->set_data(array(
            'subject'   => $subject,
            'message'   => "[b]" . $title . "[/b] has been edited, and it no longer runs on "
                . (count($member['day_ids']) === 1 ? "this day" : "these days") . " you were signed up for:\n"
                . "[list]\n" . $held . "[/list]\n"
                . "Because of that, your signup for the event has been cancelled.\n\n"
                . "The event now runs:\n"
                . "[list]\n" . $now_runs . "[/list]\n"
                . "If the new times work for you, please sign up again: [url=" . $url . "]" . $title . "[/url]",
            'fromid'    => (int)$from_uid,
            'toid'      => array($member['uid']),
            'ipaddress' => my_inet_pton(get_ip()),
            'options'   => array('savecopy' => 0),
        ));

        // A PM that cannot be delivered does not undo the save: the signup has already
        // gone, and failing the event over one full inbox would be worse.
        if($pmhandler->validate_pm())
        {
            $pmhandler->insert_pm();
        }
    }
}

/**
 * Write a validated event, its days and its exclusions.
 *
 * Exclusions are replaced wholesale: they carry nothing of their own worth keeping, and
 * the form posts the complete set every time. Days are reconciled instead, because
 * signups point at them by id - see events_save_event_days().
 *
 * A day that is removed takes every signup on it with it, whole: see
 * events_day_change_to_confirm(), which both forms ask before they get here. The members
 * are PMed once the event is saved, so the PM gives its new dates.
 *
 * @param int $event_id 0 to create, otherwise the event to update
 * @param array $input From events_event_form_input(), already validated
 * @param int $user_id Who is saving, recorded as created_by on a new event
 * @param string|null $thread_error Set to why the announcement thread could not be
 *                                  written, for a caller that can pass it on
 * An excluded member cannot see the event, so cannot withdraw from it either: a signup
 * they already held is withdrawn for them, exactly as if they had done it first. They are
 * not PMed - the event is hidden from them, and a PM about it would say what the
 * exclusion is there not to.
 *
 * Everything that touches signups - the withdrawals, the cancellations, the days and the
 * maximums - happens under the event's signup lock, and the queues are settled once at the
 * end of it, so a place freed by a cancellation and a maximum lowered in the same save are
 * one decision rather than a promotion and a demotion in turn.
 *
 * @param int $cancelled Set to how many members' signups a removed day cancelled
 * @param int $withdrawn Set to how many excluded members' signups were withdrawn
 * @param int $promoted Set to how many members were given a place off the waitlist
 * @param int $demoted Set to how many members were moved to the waitlist
 * @return int the event's id
 */
function events_save_event($event_id, array $input, $user_id, &$thread_error = null, &$cancelled = 0, &$withdrawn = 0, &$promoted = 0, &$demoted = 0)
{
    global $db;

    $event_id = (int)$event_id;
    $is_edit = $event_id > 0;

    $data = array(
        'title'         => $db->escape_string($input['title']),
        'description'   => $db->escape_string($input['description']),
        'status'        => $db->escape_string($input['status']),
        'region'        => $db->escape_string($input['region']),
        'address'       => $db->escape_string($input['address']),
        'start_date'    => $db->escape_string(events_date('Y-m-d H:i:s', events_strtotime($input['start_date']))),
        'end_date'      => $db->escape_string(events_date('Y-m-d H:i:s', events_strtotime($input['end_date']))),
        'requires_wwcc' => $input['requires_wwcc'] ? 1 : 0,
        'gec_user_id'   => (int)$input['gec_user_id'],
        'poc_user_id'   => (int)$input['poc_user_id'],
        'max_troopers'  => (int)$input['max_troopers'],
        'max_wranglers' => (int)$input['max_wranglers'],
        'updated_at'    => $db->escape_string(events_date('Y-m-d H:i:s')),
    );

    // MyBB quotes insert/update values but has no way to express SQL NULL, and an empty
    // string is not a valid DATETIME under strict mode, so the nullable columns are
    // cleared in a second statement.
    $nullable = array();

    // With the check turned off the forms do not offer the box, so an unticked one says
    // nothing. The event keeps what it had, and turning the check back on restores it.
    if(!events_wwcc_enabled() && $is_edit)
    {
        unset($data['requires_wwcc']);
    }

    if($input['signup_cutoff'] !== '')
    {
        $data['signup_cutoff'] = $db->escape_string(events_date('Y-m-d H:i:s', events_strtotime($input['signup_cutoff'])));
    }
    else
    {
        $nullable[] = 'signup_cutoff';
    }

    // Read before anything is written: the days are reconciled further down, which deletes
    // the rows this needs to name, and a single-day event's one day is read from the dates
    // this update is about to overwrite.
    $removed_days = $is_edit ? events_removed_event_days($event_id, $input) : array();

    if($is_edit)
    {
        $db->update_query("event_plugin_events", $data, "id = " . $event_id);
    }
    else
    {
        $data['created_by'] = (int)$user_id;
        $data['created_at'] = $db->escape_string(events_date('Y-m-d H:i:s'));
        $event_id = (int)$db->insert_query("event_plugin_events", $data);
    }

    if(!empty($nullable))
    {
        $db->write_query("UPDATE " . TABLE_PREFIX . "event_plugin_events
            SET " . implode(' = NULL, ', $nullable) . " = NULL
            WHERE id = " . $event_id);
    }

    $excluded = events_parse_exclusions($input['exclusions']);

    // Taken whether or not it can be had: an administrator's save is not refused over a
    // signup that is slow to finish, and every write below is one the lock would only
    // have delayed.
    $lock = events_signup_lock($event_id);
    $locked = events_acquire_lock($lock);

    // Written under the lock, and before the withdrawals: events_save_signup() re-reads
    // the exclusion once it holds the same lock, so a signup racing this save either
    // finished first and is withdrawn below, or runs after and is refused.
    $db->delete_query("event_plugin_event_exclusions", "event_id = " . $event_id);
    foreach($excluded as $uid)
    {
        $db->insert_query("event_plugin_event_exclusions", array('event_id' => $event_id, 'user_id' => $uid));
    }

    // Withdrawn before the days are looked at, so a member being excluded is not also
    // counted - and PMed - as a signup the removed days cancelled.
    $withdrawn = 0;
    foreach($excluded as $uid)
    {
        if(!empty(events_get_user_signup($event_id, $uid)))
        {
            events_write_signup($event_id, $uid, array(), array());
            $withdrawn++;
        }
    }

    $cancelled_members = events_day_change_signups($event_id, $removed_days);
    foreach($cancelled_members as $member)
    {
        // An empty intent drops every role, with its days and costumes - the same write
        // as the member withdrawing themselves.
        events_write_signup($event_id, $member['uid'], array(), array());
    }
    $cancelled = count($cancelled_members);

    events_save_event_days($event_id, $input['days']);
    events_claim_every_day($event_id);

    $moves = events_rebalance_waitlist($event_id);
    if($locked)
    {
        events_release_lock($lock);
    }

    $moved = events_group_waitlist_moves($moves);
    $promoted = count(array_filter($moved, function($member) { return !empty($member['promoted']); }));
    $demoted = count(array_filter($moved, function($member) { return !empty($member['demoted']); }));

    // The event's forum announcement is written from the event, so it is refreshed here
    // rather than by each form - a coordinator editing a date and the thread still
    // advertising the old one is exactly what generating the post is meant to prevent.
    // A thread that cannot be written does not fail the save: the event is already in
    // the database and losing it over a misconfigured forum would be worse than an
    // announcement the caller can report as missing.
    events_sync_event_thread($event_id, $thread_error);
    events_drop_hidden_thread_subscriptions($event_id);

    events_send_day_change_pms($event_id, $removed_days, $cancelled_members, $user_id);
    events_send_waitlist_pms($event_id, $moves, $user_id);

    return $event_id;
}

/**
 * An event as the administrator log compares it: every part of it the form can change,
 * keyed by the name the form gives it.
 *
 * Read from the database rather than from what was posted, on both sides of the save, so
 * a field only counts as changed when what is stored is different - a date retyped the
 * same, or a description whose line endings the browser rewrote, is not a change.
 *
 * @param int $event_id
 * @return array Field name => stored value; empty when there is no such event
 */
function events_event_log_state($event_id)
{
    global $db;

    $event_id = (int)$event_id;
    $event = events_get_event($event_id);
    if(!$event)
    {
        return array();
    }

    $columns = array(
        'title'         => 'Title',
        'description'   => 'Description',
        'status'        => 'Status',
        'region'        => 'Region',
        'address'       => 'Address',
        'start_date'    => 'Start Date',
        'end_date'      => 'End Date',
        'signup_cutoff' => 'Signup Cutoff',
        'max_troopers'  => 'Maximum Troopers',
        'max_wranglers' => 'Maximum Wranglers',
        'requires_wwcc' => 'Requires ' . events_wwcc_name(),
        'gec_user_id'   => 'Coordinator',
        'poc_user_id'   => 'Point of Contact',
    );

    $state = array();
    foreach($columns as $column => $label)
    {
        $state[$label] = (string)$event[$column];
    }

    $days = array();
    $query = $db->simple_select("event_plugin_event_days", "date, start_time, end_time", "event_id = " . $event_id, array('order_by' => 'date'));
    while($day = $db->fetch_array($query))
    {
        $days[] = $day['date'] . ' ' . $day['start_time'] . '-' . $day['end_time'];
    }
    $state['Event Days'] = implode(', ', $days);

    $excluded = array();
    $query = $db->simple_select("event_plugin_event_exclusions", "user_id", "event_id = " . $event_id, array('order_by' => 'user_id'));
    while($row = $db->fetch_array($query))
    {
        $excluded[] = (int)$row['user_id'];
    }
    $state['Excluded Members'] = implode(',', $excluded);

    return $state;
}

/**
 * Log a save from either event form to the administrator log - see events_log_action().
 *
 * An edit names the fields it changed, so the log says what somebody did to an event
 * rather than only that they opened the form and pressed Save.
 *
 * @param int $event_id The id events_save_event() returned
 * @param array $before events_event_log_state() from before the save; empty for a new event
 * @param bool $frontend Whether the save came from manage_event.php
 */
function events_log_event_save($event_id, array $before, $frontend)
{
    $after = events_event_log_state($event_id);
    if(empty($after))
    {
        return;
    }

    $suffix = $frontend ? '_frontend' : '';

    if(empty($before))
    {
        events_log_action('add' . $suffix, array($event_id, $after['Title']));
        return;
    }

    $changed = array();
    foreach($after as $label => $value)
    {
        if(!isset($before[$label]) || $before[$label] !== $value)
        {
            $changed[] = $label;
        }
    }

    events_log_action('edit' . $suffix, array(
        $event_id,
        $after['Title'],
        $changed ? implode(', ', $changed) : 'nothing',
    ));
}

/**
 * What a save did to the waitlist, for the message both forms show after it.
 *
 * @param int $promoted
 * @param int $demoted
 * @return string Empty when it did nothing, otherwise a sentence with a leading space
 */
function events_waitlist_save_message($promoted, $demoted)
{
    $message = '';
    if($promoted > 0)
    {
        $message .= " " . $promoted . ($promoted === 1 ? " member was" : " members were")
            . " given a place off the waitlist and sent a PM.";
    }
    if($demoted > 0)
    {
        $message .= " " . $demoted . ($demoted === 1 ? " member was" : " members were")
            . " moved to the waitlist and sent a PM.";
    }

    return $message;
}

/**
 * Give every signup without day claims a claim on each of the event's days.
 *
 * A signup made while an event had no days has no claims, and once the event gains some
 * it reads as "every day" everywhere it is shown. Each day is its own queue, though, so
 * a signup has to be in each one to be counted there. The claims take the signup's own
 * status and its rsvp_date, which is where it would have been in each queue all along.
 *
 * Called with events_signup_lock() held.
 *
 * @param int $event_id
 * @return void
 */
function events_claim_every_day($event_id)
{
    global $db;

    $event_id = (int)$event_id;
    $days = events_get_event_days($event_id);
    if(empty($days))
    {
        return;
    }

    $query = $db->query("
        SELECT r.id, r.status, r.rsvp_date
        FROM " . TABLE_PREFIX . "event_plugin_rsvps r
        WHERE r.event_id = " . $event_id . "
          AND NOT EXISTS (SELECT 1 FROM " . TABLE_PREFIX . "event_plugin_rsvp_days d WHERE d.rsvp_id = r.id)
        ORDER BY r.rsvp_date ASC, r.id ASC
    ");
    // In queue order, so claims copied from signups made in the same second get ids that
    // keep them the way the day-less queue had them.
    while($row = $db->fetch_array($query))
    {
        foreach($days as $day)
        {
            $db->insert_query("event_plugin_rsvp_days", array(
                'rsvp_id'      => (int)$row['id'],
                'event_day_id' => (int)$day['id'],
                'status'       => $row['status'] === 'waitlisted' ? 'waitlisted' : 'attending',
                'claimed_at'   => $db->escape_string($row['rsvp_date']),
            ));
        }
    }
}

/**
 * The longest title an event can have.
 *
 * The title becomes the subject of posts and PMs the plugin writes, and MyBB refuses a
 * subject over 85 characters - in a datahandler, long after the event was saved. The
 * longest prefix is the reminder PM's "Troop Report Needed: ", which leaves 64. Past that
 * the reminder fails every night without saying so, the troop report is refused after the
 * member has written it, and the announcement thread is never posted.
 */
define('EVENTS_TITLE_MAX_LENGTH', 64);

/**
 * How many day rows a form will ever draw.
 *
 * A mistyped year turns "24th to 26th" into "24th of this year to the 26th of next", and
 * without a ceiling the form would try to render a row for every day in between. The cap
 * is generous enough that no real event reaches it.
 */
define('EVENTS_MAX_EVENT_DAYS', 31);

/**
 * The largest maximum troopers or wranglers an event can be given. Past this the number
 * is a typo, not a limit, and would read on the event page as one.
 */
define('EVENTS_MAX_PLACES', 9999);

/**
 * The calendar days an event covers, from its start date to its end date.
 *
 * Returns nothing for a single-day event: the plugin already treats an event with no day
 * rows as a one-day event (the signup wizard asks one question instead of one per day),
 * so there is nothing for a one-row grid to add and the form hides it instead.
 *
 * The dates are events_event_dates()'s, so an event that starts at 22:00 and ends at
 * 01:00 is one night rather than two days, and two such nights are two rows, not three. The script in events_event_days_script()
 * applies the same rule, and the two have to agree.
 *
 * @param string $start_date Anything events_strtotime() accepts
 * @param string $end_date
 * @return array of 'Y-m-d', empty when the dates are unusable or cover one day
 */
function events_event_day_span($start_date, $end_date)
{
    $dates = events_event_dates($start_date, $end_date, EVENTS_MAX_EVENT_DAYS);

    return count($dates) > 1 ? $dates : array();
}

/**
 * The event day grid both forms render: one row per day the event covers, each offering
 * the hours that day runs.
 *
 * The dates are not typed. They follow the event's start and end dates, so the grid is
 * derived rather than entered, and only the times are the coordinator's to set. The date
 * still posts, as a hidden field, because events_save_event() writes a date per row and
 * validation is shared with a form that once typed them.
 *
 * Times already entered are matched to the new grid by date, so correcting an end date
 * keeps the hours set for the days that survive the change.
 *
 * The grid carries the ids of the two date boxes rather than looking for well-known ones:
 * the Admin CP and the front end name their fields differently, and the script below is
 * the same script on both.
 *
 * @param array $values From events_event_form_values() or events_event_form_input()
 * @param array $options container_id, start_input, end_input, id_prefix, input_class
 * @return array ('html' => string, 'rows' => int) - no rows means the caller should hide
 *               its Event Days section, which the script does too once dates are typed
 */
function events_event_days_grid(array $values, array $options)
{
    $container_id = $options['container_id'];
    $id_prefix = $options['id_prefix'];
    $input_class = isset($options['input_class']) ? $options['input_class'] : 'events_input';

    // Whatever times are already on file, so a re-render (an edit, or a failed submit)
    // does not throw them away.
    $times = array();
    foreach($values['days'] as $day)
    {
        $times[$day['date']] = array($day['start_time'], $day['end_time']);
    }

    $dates = events_event_day_span($values['start_date'], $values['end_date']);

    $html = '<div id="' . $container_id . '" class="events_day_grid" data-events-day-grid="1"'
          . ' data-events-day-start="' . htmlspecialchars_uni($options['start_input']) . '"'
          . ' data-events-day-end="' . htmlspecialchars_uni($options['end_input']) . '"'
          . ' data-events-day-max="' . EVENTS_MAX_EVENT_DAYS . '">';

    // The script clones this rather than building markup of its own, so there is one
    // description of a day row and the rows it adds match the ones PHP drew.
    $html .= '<template data-events-day-template="1">'
           . events_event_day_row('__INDEX__', '__DATE__', '__LABEL__', '', '', $id_prefix, $input_class)
           . '</template>';

    foreach($dates as $index => $date)
    {
        $time = isset($times[$date]) ? $times[$date] : array('', '');
        $html .= events_event_day_row(
            $index,
            $date,
            events_date('D j M Y', events_strtotime($date)),
            $time[0],
            $time[1],
            $id_prefix,
            $input_class
        );
    }

    return array('html' => $html . '</div>', 'rows' => count($dates));
}

/**
 * One row of the day grid. Also rendered with placeholders as the script's template, so
 * nothing here may depend on the values actually being a date or a number.
 *
 * @return string
 */
function events_event_day_row($index, $date, $label, $start_time, $end_time, $id_prefix, $input_class)
{
    // Whole minutes, because that is all a time input shows or posts. The stored value is
    // H:i:s, and handing the box seconds it will drop makes it disagree with what was saved.
    $time_value = function($value)
    {
        $time = events_parse_day_time($value);

        return $time === false ? '' : substr($time, 0, 5);
    };

    $cell = function($name, $id, $value, $label) use ($input_class, $time_value)
    {
        return '<label class="events_day_cell"><span class="events_day_cell_label">' . $label . '</span>'
             . '<input type="time" class="' . $input_class . ' events_time_input" name="' . $name . '"'
             . ' id="' . $id . '" value="' . htmlspecialchars_uni($time_value($value)) . '" /></label>';
    };

    return '<div class="events_day_row" data-events-day-date="' . htmlspecialchars_uni((string)$date) . '">'
         . '<span class="events_day_date">' . htmlspecialchars_uni((string)$label) . '</span>'
         . '<input type="hidden" name="event_days[' . $index . '][date]" value="' . htmlspecialchars_uni((string)$date) . '" />'
         . $cell("event_days[{$index}][start_time]", "{$id_prefix}{$index}_start", $start_time, 'Starts')
         . $cell("event_days[{$index}][end_time]", "{$id_prefix}{$index}_end", $end_time, 'Ends')
         . '</div>';
}

/**
 * The script that keeps the day grid in step with the start and end dates.
 *
 * Without it the grid can only be as right as the last save, because the dates it is
 * derived from are typed on the same page: a coordinator creating a three-day event would
 * have to save it before the form would offer them three rows.
 *
 * It is an enhancement rather than a requirement. With no script the grid is still correct
 * for an event that has been saved, which is the only state the server can know about.
 *
 * Inline rather than a file because it is needed on two pages served from two different
 * roots - the front end and the Admin CP - which would otherwise need two copies of it
 * deployed to two places.
 *
 * @return string
 */
function events_event_days_script()
{
    return <<<'SCRIPT'
<script type="text/javascript">
(function() {
	var grid = document.querySelector('[data-events-day-grid]');
	if(!grid) { return; }

	var template = grid.querySelector('[data-events-day-template]');
	var startInput = document.getElementById(grid.getAttribute('data-events-day-start'));
	var endInput = document.getElementById(grid.getAttribute('data-events-day-end'));
	// Each date box's time box, which events_datetime_field() names after it. The times
	// decide whether an event that crosses midnight is one night or two days.
	var startTimeInput = startInput ? document.getElementById(startInput.id + '_time') : null;
	var endTimeInput = endInput ? document.getElementById(endInput.id + '_time') : null;

	// 'content' in template is the feature test for <template> itself; without it the
	// server-rendered grid is left exactly as it is.
	if(!template || !('content' in template) || !startInput || !endInput) { return; }

	var max = parseInt(grid.getAttribute('data-events-day-max'), 10) || 31;
	var sections = document.querySelectorAll('[data-events-day-section]');
	var NIGHT_ENDS = 6 * 3600000; // EVENTS_NIGHT_ENDS
	var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	// Dates are held as UTC midnights and stepped by whole days, so no row is skipped or
	// repeated when the event runs across a daylight saving change.
	//
	// The date has to be complete to count: this runs while the field is still being typed,
	// and a half-typed 2026-10-2 must not be read as the 2nd and redraw the grid around it.
	function parseDate(value) {
		var parts = /^\s*(\d{4})-(\d{2})-(\d{2})(?![\d-])/.exec(value || '');
		return parts ? Date.UTC(+parts[1], +parts[2] - 1, +parts[3]) : null;
	}

	// A time box's value as milliseconds into its day; blank, as on the server, is midnight.
	function parseTime(input) {
		var parts = /^\s*(\d{1,2}):(\d{2})/.exec(input ? input.value : '');
		return parts ? (+parts[1] * 60 + +parts[2]) * 60000 : 0;
	}

	function pad(number) {
		return (number < 10 ? '0' : '') + number;
	}

	function isoDate(stamp) {
		var date = new Date(stamp);
		return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
	}

	// Matches PHP's date('D j M Y'), so a row the script adds reads like one PHP drew.
	function labelDate(stamp) {
		var date = new Date(stamp);
		return DAYS[date.getUTCDay()] + ' ' + date.getUTCDate() + ' '
			+ MONTHS[date.getUTCMonth()] + ' ' + date.getUTCFullYear();
	}

	function rows() {
		return grid.querySelectorAll('[data-events-day-date]');
	}

	function times(row) {
		return row.querySelectorAll('input[type="time"]');
	}

	// settled is false while a field is still being typed in, where an unreadable date means
	// "not finished" rather than "no days" - clearing the grid under someone mid-keystroke
	// would take the hours they had already entered with it.
	function render(settled) {
		var start = parseDate(startInput.value);
		var end = parseDate(endInput.value);

		if(!settled && (start === null || end === null)) { return; }

		var existing = rows();
		var dates = [];
		var i;

		if(start !== null && end !== null && end >= start) {
			// events_event_dates()'s rules, which the two have to share: shorter than a day on
			// the wall clock is the night it starts, and an end before NIGHT_ENDS belongs to
			// the night before, so a 22:00 to 01:00 troop is not drawn as two days.
			var last = end;
			var endTime = parseTime(endTimeInput);
			if(end + endTime - (start + parseTime(startTimeInput)) < 86400000) {
				last = start;
			} else if(endTime < NIGHT_ENDS) {
				last = end - 86400000;
			}
			for(var stamp = start; stamp <= last && dates.length < max; stamp += 86400000) {
				dates.push(stamp);
			}
		}

		// One day is no day: an event with no rows is a single-day event already.
		if(dates.length < 2) { dates = []; }

		// Nothing to do when the days have not moved. Rebuilding anyway would be invisible
		// but not harmless: it destroys the row somebody may be part way through filling
		// in, and this runs on every blur of a date field, changed or not.
		var unchanged = existing.length === dates.length;
		for(i = 0; unchanged && i < dates.length; i++) {
			unchanged = existing[i].getAttribute('data-events-day-date') === isoDate(dates[i]);
		}
		if(unchanged && existing.length) { return; }

		var kept = {};
		for(i = 0; i < existing.length; i++) {
			var inputs = times(existing[i]);
			kept[existing[i].getAttribute('data-events-day-date')] = [
				inputs[0] ? inputs[0].value : '',
				inputs[1] ? inputs[1].value : ''
			];
			existing[i].parentNode.removeChild(existing[i]);
		}

		for(i = 0; i < dates.length; i++) {
			var date = isoDate(dates[i]);
			var holder = document.createElement('div');

			holder.innerHTML = template.innerHTML
				.split('__INDEX__').join(String(i))
				.split('__DATE__').join(date)
				.split('__LABEL__').join(labelDate(dates[i]));

			var row = holder.firstElementChild;
			if(kept[date]) {
				var cells = times(row);
				if(cells[0]) { cells[0].value = kept[date][0]; }
				if(cells[1]) { cells[1].value = kept[date][1]; }
			}

			grid.appendChild(row);
		}

		for(i = 0; i < sections.length; i++) {
			sections[i].style.display = dates.length ? '' : 'none';
		}
	}

	// Both events, because neither is enough on its own: 'change' alone misses a date that
	// is pasted or filled in and never blurred, and 'input' alone would have to act on a
	// half-typed one. 'input' redraws as soon as both dates read as dates; 'change' settles
	// the grid when the field is left, including when it was left empty.
	function onInput() { render(false); }
	function onChange() { render(true); }

	startInput.addEventListener('input', onInput);
	endInput.addEventListener('input', onInput);
	startInput.addEventListener('change', onChange);
	endInput.addEventListener('change', onChange);
	// A time can take an event over or under a day. Unsettled, so a change to one while a
	// date box is still half typed leaves the grid alone rather than clearing it.
	var timeInputs = [startTimeInput, endTimeInput];
	for(var t = 0; t < timeInputs.length; t++) {
		if(timeInputs[t]) {
			timeInputs[t].addEventListener('input', onInput);
			timeInputs[t].addEventListener('change', onInput);
		}
	}
})();
</script>
SCRIPT;
}

/**
 * The script that turns the date boxes into calendars.
 *
 * Kept apart from events_event_days_script() because the two are needed independently: the
 * day grid is only on the form when an event spans more than one day, and the pickers are
 * wanted either way.
 *
 * The date format is the one the plugin stores and the day grid reads, so what the box
 * holds after a pick is the same thing somebody would have typed, and nothing has to be
 * converted on the way to the server.
 *
 * Inline for the same reason the day grid's script is: it is short, and it is needed on two
 * pages served from two different roots, which a file would need deploying to twice. The
 * picker itself is a real asset - see events_datepicker_assets() - because 85KB of vendored
 * library is not something to inline on every page view.
 *
 * @return string
 */
function events_datepicker_script()
{
    global $mybb;

    // MyBB asks the board which day its weeks start on; the calendar should agree with the
    // one on calendar.php rather than assume Sunday.
    $first_day = isset($mybb->settings['startofweek']) ? (int)$mybb->settings['startofweek'] : 0;

    return <<<SCRIPT
<script type="text/javascript">
(function() {
	if(!window.jQuery || !window.jQuery.datepicker) { return; }

	jQuery(function(\$) {
		var inputs = \$('.events_datepicker');

		// A submit that fails the browser's own required-field check focuses the first
		// control it stopped on and pops its message over it - and the picker opens on
		// focus, so that one focus used to put the whole calendar on top of the message
		// the member most needs to read. The next open is suppressed instead, and only
		// until the end of the current task, so a focus the member caused themselves
		// still opens the calendar.
		var block_open = false;
		inputs.on('invalid', function() {
			block_open = true;
			// The picker is not open yet - the focus that opens it comes after this
			// event - but it is, if the member submitted with the calendar already down.
			\$(this).datepicker('hide');
			setTimeout(function() { block_open = false; }, 0);
		});

		// The browser leaves the field focused once it has reported a problem on it, so
		// the picker's own focus trigger never fires again and the member's next click on
		// the box would do nothing at all. A click is them asking for the calendar whether
		// the focus moved or not, and asking for one that is already down is a no-op
		// inside jQuery UI.
		inputs.on('click', function() {
			if(!block_open) { \$(this).datepicker('show'); }
		});

		inputs.datepicker({
			dateFormat: 'yy-mm-dd',
			changeMonth: true,
			changeYear: true,
			// Far enough back to reopen an archived event, far enough forward to plan one.
			yearRange: 'c-3:c+5',
			firstDay: {$first_day},
			showOtherMonths: true,
			selectOtherMonths: true,

			// Returning false is jQuery UI's own way of cancelling an open, so a
			// suppressed calendar is never shown rather than shown and closed again.
			beforeShow: function() {
				return block_open ? false : {};
			},

			// jQuery's own trigger('change') runs jQuery handlers only - it does not
			// dispatch a DOM event, so nothing bound with addEventListener would hear it,
			// and the day grid is bound that way. Picking a date has to reach it, or the
			// grid would only follow dates that were typed.
			onSelect: function() {
				var event;
				if(typeof Event === 'function') {
					event = new Event('change', { bubbles: true });
				} else {
					event = document.createEvent('HTMLEvents');
					event.initEvent('change', true, false);
				}
				this.dispatchEvent(event);
			}
		});
	});
})();
</script>
SCRIPT;
}

/**
 * The script that turns the excluded members box into a tag input.
 *
 * Typing searches the board's members, picking one adds a lozenge, and the box that posts
 * is kept in step behind it as the same comma separated list it has always been. Nothing
 * but a member who was offered can be added, so the list that reaches the server names
 * people who exist - which the server checks again, because a field cannot be a rule.
 *
 * The search is MyBB's own xmlhttp.php?action=get_users, the endpoint the Admin CP's user
 * boxes use. It ignores anything shorter than two characters and returns at most fifteen
 * matches, and both of those are its rules rather than this script's.
 *
 * Inline, and for the same reason as the other two: it runs on the front-end form and the
 * Admin CP one, which are served from different roots. With no script the box is a text
 * field holding a comma separated list, which is exactly what the server reads.
 *
 * @return string
 */
function events_tag_field_script()
{
    return <<<'SCRIPT'
<script type="text/javascript">
(function() {
	var fields = document.querySelectorAll('[data-events-tag-field]');
	for(var f = 0; f < fields.length; f++) { enhance(fields[f]); }

	function enhance(field) {
		var store = field.querySelector('input[type="text"]');
		var source = field.getAttribute('data-events-tag-source');
		if(!store || !source) { return; }

		var names = [];       // what is chosen, in the order it was chosen
		var options = [];     // what the menu is offering right now
		var active = -1;      // which of those is highlighted
		var sequence = 0;     // bumped per search, so a slow reply cannot land on a newer one
		var timer = null;

		var box = document.createElement('div');
		box.className = 'events_tags';

		var entry = document.createElement('input');
		entry.type = 'text';
		entry.className = 'events_tag_entry';
		entry.setAttribute('autocomplete', 'off');
		entry.setAttribute('role', 'combobox');
		entry.setAttribute('aria-autocomplete', 'list');
		entry.setAttribute('aria-expanded', 'false');
		entry.setAttribute('placeholder', 'Type a username');

		var menu = document.createElement('ul');
		menu.className = 'events_tag_menu';
		menu.setAttribute('role', 'listbox');
		menu.hidden = true;

		// Everything the menu cannot say on its own: nothing matched, or what was typed is
		// not a member. A live region, so it is read out rather than only seen.
		var note = document.createElement('p');
		note.className = 'events_tag_note';
		note.setAttribute('role', 'status');
		note.setAttribute('aria-live', 'polite');
		note.hidden = true;

		// The id moves to the box being typed in, so the field's label still points at a
		// control somebody can click into. What posts keeps the name and takes a derived id.
		var id = store.id;
		if(id) {
			store.id = id + '_value';
			entry.id = id;
			menu.id = id + '_menu';
			entry.setAttribute('aria-controls', menu.id);
		}

		var describedby = store.getAttribute('aria-describedby');
		if(describedby) {
			entry.setAttribute('aria-describedby', describedby);
			store.removeAttribute('aria-describedby');
		}

		// Hidden rather than removed: it is still the field that posts, and the server
		// reads the same comma separated list whether this script ran or not.
		store.type = 'hidden';

		field.appendChild(box);
		field.appendChild(menu);
		field.appendChild(note);
		box.appendChild(entry);

		// The box is a text field as far as anyone using it is concerned, so clicking the
		// empty part of it puts the cursor in it rather than doing nothing.
		box.addEventListener('mousedown', function(event) {
			if(event.target === box) { event.preventDefault(); entry.focus(); }
		});

		entry.addEventListener('input', onInput);
		entry.addEventListener('keydown', onKeyDown);
		entry.addEventListener('blur', onBlur);

		// Whatever is already on file. These names came out of the database, so they are
		// members by definition and are not searched for again.
		var initial = store.value.split(',');
		for(var i = 0; i < initial.length; i++) {
			var name = trim(initial[i]);
			if(name !== '' && !has(name)) { names.push(name); }
		}
		render();

		function trim(value) {
			return String(value).replace(/^\s+|\s+$/g, '');
		}

		function has(name) {
			var lower = name.toLowerCase();
			for(var i = 0; i < names.length; i++) {
				if(names[i].toLowerCase() === lower) { return true; }
			}
			return false;
		}

		function render() {
			var tags = box.querySelectorAll('[data-events-tag]');
			var i;

			for(i = 0; i < tags.length; i++) { box.removeChild(tags[i]); }
			for(i = 0; i < names.length; i++) { box.insertBefore(tag(names[i]), entry); }

			store.value = names.join(', ');
		}

		function tag(name) {
			var holder = document.createElement('span');
			holder.className = 'events_tag';
			holder.setAttribute('data-events-tag', name);

			var label = document.createElement('span');
			label.className = 'events_tag_name';
			label.appendChild(document.createTextNode(name));

			// type="button", or every remove would submit the form it sits in.
			var remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'events_tag_remove';
			remove.setAttribute('aria-label', 'Remove ' + name);
			remove.appendChild(document.createTextNode('×'));
			remove.addEventListener('click', function() {
				drop(name);
				entry.focus();
			});

			holder.appendChild(label);
			holder.appendChild(remove);

			return holder;
		}

		function add(name) {
			if(!has(name)) {
				names.push(name);
				render();
			}

			entry.value = '';
			close();
			say('');
		}

		function drop(name) {
			var lower = name.toLowerCase();
			var kept = [];

			for(var i = 0; i < names.length; i++) {
				if(names[i].toLowerCase() !== lower) { kept.push(names[i]); }
			}

			names = kept;
			render();
		}

		function say(message) {
			while(note.firstChild) { note.removeChild(note.firstChild); }
			if(message !== '') { note.appendChild(document.createTextNode(message)); }
			note.hidden = message === '';
		}

		function close() {
			options = [];
			active = -1;
			while(menu.firstChild) { menu.removeChild(menu.firstChild); }
			menu.hidden = true;
			entry.setAttribute('aria-expanded', 'false');
			entry.removeAttribute('aria-activedescendant');
		}

		/**
		 * Offer these names, minus the ones already chosen, and say how many are left to
		 * offer - a search that matched only people who are already excluded has nothing
		 * to show but is not the same as one that matched nobody.
		 */
		function show(matches) {
			var i;
			close();

			for(i = 0; i < matches.length; i++) {
				if(!has(matches[i])) { options.push(matches[i]); }
			}

			if(!options.length) { return 0; }

			for(i = 0; i < options.length; i++) { menu.appendChild(option(options[i], i)); }

			menu.hidden = false;
			entry.setAttribute('aria-expanded', 'true');
			highlight(0);

			return options.length;
		}

		function option(name, index) {
			var item = document.createElement('li');
			item.className = 'events_tag_option';
			item.setAttribute('role', 'option');
			item.setAttribute('data-events-tag-option', name);
			item.id = (menu.id || 'events_tag') + '_option_' + index;
			item.appendChild(document.createTextNode(name));

			// mousedown rather than click: a click blurs the entry first, and the blur
			// closes the menu out from under the very option being clicked.
			item.addEventListener('mousedown', function(event) {
				event.preventDefault();
				add(name);
			});
			item.addEventListener('mouseenter', function() { highlight(index); });

			return item;
		}

		function highlight(index) {
			var items = menu.childNodes;
			active = index;

			for(var i = 0; i < items.length; i++) {
				var on = (i === active);
				items[i].className = on ? 'events_tag_option events_tag_option_active' : 'events_tag_option';
				items[i].setAttribute('aria-selected', on ? 'true' : 'false');
				if(on) { entry.setAttribute('aria-activedescendant', items[i].id); }
			}
		}

		function search(query) {
			var request = new XMLHttpRequest();
			var mine = ++sequence;

			request.open('GET', source + '&query=' + encodeURIComponent(query), true);
			request.onreadystatechange = function() {
				// Anything but the newest search is an answer to a question that has since
				// been retyped, and would replace the menu with a stale list.
				if(request.readyState !== 4 || mine !== sequence) { return; }

				var found = [];
				try {
					var data = JSON.parse(request.responseText);
					for(var i = 0; i < data.length; i++) { found.push(data[i].text || data[i].id); }
				} catch(error) {
					found = [];
				}

				var shown = show(found);
				if(found.length && !shown) { say('Already excluded.'); }
				else if(!found.length) { say('No member matches ‘' + query + '’.'); }
				else { say(''); }
			};
			request.send(null);
		}

		function onInput() {
			var query = trim(entry.value);

			if(timer) { window.clearTimeout(timer); }
			// Whatever is in flight is already answering an older query.
			sequence++;

			// xmlhttp.php answers nothing under two characters, so there is nothing to ask.
			if(query.length < 2) { close(); say(''); return; }

			timer = window.setTimeout(function() { search(query); }, 180);
		}

		/**
		 * Take what is highlighted, or what was typed if it is exactly one of the names on
		 * offer. Anything else is not a member, and is refused with a reason rather than
		 * added and quietly dropped on the way to the database.
		 */
		function commit() {
			var typed = trim(entry.value);
			var i;

			if(active >= 0 && options[active]) { add(options[active]); return; }

			for(i = 0; i < options.length; i++) {
				if(options[i].toLowerCase() === typed.toLowerCase()) { add(options[i]); return; }
			}

			if(typed === '') { return; }

			if(has(typed)) {
				entry.value = '';
				close();
				say('‘' + typed + '’ is already excluded.');
				return;
			}

			say('Pick a member from the list. ‘' + typed + '’ is not one.');
		}

		function onKeyDown(event) {
			var key = event.key;

			if(key === 'ArrowDown' || key === 'Down') {
				if(options.length) { event.preventDefault(); highlight((active + 1) % options.length); }
				return;
			}

			if(key === 'ArrowUp' || key === 'Up') {
				if(options.length) { event.preventDefault(); highlight((active + options.length - 1) % options.length); }
				return;
			}

			// Enter belongs to the list while the list is open or something is half typed:
			// an event saved part way through choosing who is excluded is not what the key
			// was pressed for. A comma is how the list used to be typed, so it commits too.
			if(key === 'Enter' || key === ',') {
				if(options.length || trim(entry.value) !== '') { event.preventDefault(); commit(); }
				return;
			}

			if(key === 'Escape' || key === 'Esc') {
				if(!menu.hidden) { event.preventDefault(); close(); }
				else if(entry.value !== '') { entry.value = ''; say(''); }
				return;
			}

			// Backspace in an empty box takes back the last lozenge, which is what every
			// other tag input does and what the hand expects.
			if(key === 'Backspace' && entry.value === '' && names.length) {
				event.preventDefault();
				drop(names[names.length - 1]);
			}
		}

		function onBlur(event) {
			// Leaving for the remove button or an option is not leaving the field.
			var next = event.relatedTarget;
			if(next && field.contains(next)) { return; }

			// Text that was never picked is not an exclusion, and a box still holding it
			// after the cursor has gone reads as though it were.
			entry.value = '';
			close();
			say('');
		}
	}
})();
</script>
SCRIPT;
}

<?php
/**
 * MyBB Event Plugin - Admin Settings
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_thread.php";
require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_regions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_form.php";

/**
 * The value a control on this form should render with.
 *
 * The stored setting normally, but whatever was submitted when the form is coming back
 * with an error - otherwise one bad region name would quietly throw away every other
 * change the admin had made on the page before they hit Save.
 *
 * @param string $input_name   Name of the form control
 * @param string $setting_name Full setting name, events_ prefix and all
 * @return mixed
 */
function events_admin_settings_value($input_name, $setting_name)
{
    global $mybb;

    if($mybb->request_method == "post")
    {
        return $mybb->get_input($input_name);
    }

    return isset($mybb->settings[$setting_name]) ? $mybb->settings[$setting_name] : '';
}

/**
 * MyBB's own forum dropdown: the board's forums in display order, children indented
 * under their parents.
 *
 * Its "None" option posts -1 rather than an empty string, so a caller that offers it
 * reads the choice back through events_admin_forum_input().
 *
 * @param Form   $form
 * @param string $name  Name of the form control
 * @param string $value Selected forum id, '' for none
 * @param string $id    Element id
 * @param bool   $none  Whether to offer None at the top
 * @return string
 */
function events_admin_forum_select($form, $name, $value, $id, $none = false)
{
    $options = array('id' => $id);
    if($none)
    {
        $options['main_option'] = 'None';
        if((int)$value <= 0)
        {
            $value = -1;
        }
    }

    return $form->generate_forum_select($name, (int)$value, $options);
}

/**
 * A forum id posted by events_admin_forum_select(), with its None read as ''.
 *
 * @param mixed $value
 * @return string
 */
function events_admin_forum_input($value)
{
    return (int)$value > 0 ? (string)(int)$value : '';
}

/**
 * The post id a "Preapproval Requirements" entry names: a bare id, or a link to the post
 * as the board writes one - showthread.php?pid=, an anchor #pid, or a search-friendly
 * post-N.html. A link to a thread names its first post.
 *
 * @param string $value
 * @return int|null 0 for blank, null for something that names no post
 */
function events_admin_preapproval_post_id($value)
{
    global $db;

    $value = trim((string)$value);
    if($value === '')
    {
        return 0;
    }

    if(preg_match('/^\d+$/', $value))
    {
        $pid = (int)$value;
    }
    elseif(preg_match('/(?:[?&;]pid=|#pid|\bpost-)(\d+)/i', $value, $match))
    {
        $pid = (int)$match[1];
    }
    elseif(preg_match('/(?:[?&;]tid=|\bthread-)(\d+)/i', $value, $match))
    {
        $thread = get_thread((int)$match[1]);
        $pid = $thread ? (int)$thread['firstpost'] : 0;
    }
    else
    {
        return null;
    }

    $query = $db->simple_select("posts", "pid", "pid = " . $pid . " AND visible = 1", array("limit" => 1));

    return $pid > 0 && $db->fetch_field($query, "pid") ? $pid : null;
}

/**
 * A fingerprint of every stored plugin setting, which the settings form carries so a
 * save can tell whether it is overwriting a state it was never shown.
 *
 * The form writes every setting on it at once, the region list included, so a save
 * from a page opened before somebody else's change quietly undoes that change - and
 * for a region added in the meantime that means dropping it from the list while its
 * events stay filed under it. Adding and deleting a region, the other admin's own save,
 * and MyBB's own settings screen all write these rows, so fingerprinting the rows
 * rather than keeping a version number that each of them would have to remember to
 * bump catches all of them.
 *
 * Read from the table rather than from $mybb->settings, which is the generated cache
 * and could be behind the rows it was generated from.
 *
 * @return string
 */
function events_admin_settings_version()
{
    return sha1(json_encode(events_admin_stored_settings()));
}

/**
 * Every setting in the plugin's group, as the settings table holds it right now.
 *
 * $mybb->settings comes from the generated inc/settings.php, and rebuild_settings()
 * rewrites that file without invalidating opcache. On a host that caches compiled
 * files, the page a save redirects to runs the old copy, and the form showed the
 * values from before the save until opcache next checked the file.
 *
 * @return array Setting name => value
 */
function events_admin_stored_settings()
{
    global $db;

    $query = $db->write_query("SELECT s.name, s.value
        FROM `" . TABLE_PREFIX . "settings` s
        INNER JOIN `" . TABLE_PREFIX . "settinggroups` g ON g.gid = s.gid
        WHERE g.name = 'events'
        ORDER BY s.name");

    $values = array();
    while($row = $db->fetch_array($query))
    {
        $values[$row['name']] = $row['value'];
    }

    return $values;
}

function events_admin_settings()
{
    global $mybb, $db, $page, $lang;

    // Everything on this page - the form's values, the region rows and their forums -
    // reads $mybb->settings, so it is brought up to the table first.
    $mybb->settings = array_merge($mybb->settings, events_admin_stored_settings());

    // Adding and deleting a region are actions of their own on this page rather than
    // edits to the form below: each asks a question of its own first, and a deletion's
    // question - where its events go - has to be answered before anything happens.
    if(events_admin_region_action())
    {
        return;
    }

    $errors = array();
    $region_counts = events_admin_region_event_counts();
    $region_rows = events_admin_region_rows();

    if($mybb->request_method == "post")
    {
        // Checked before anything else, and the whole save refused rather than merged:
        // the form cannot say which of its values the admin changed and which it merely
        // rendered, so there is nothing safe to keep. It goes back to a fresh form rather
        // than re-rendering the submitted one, which would carry the stale values - and
        // the stale token - straight into the next save.
        if(!hash_equals(events_admin_settings_version(), (string)$mybb->get_input('settings_version')))
        {
            flash_message("This data was altered by someone else between when you loaded it and when you saved. Please reapply your changes so work is not lost.", "error");
            admin_redirect("index.php?module=events&action=settings");
        }

        // What the region rows mean is worked out before anything is written, because
        // the rest of this page hangs off them: the announcement forums are keyed by
        // region name, and an event carries its region as text. A save that wrote the
        // other settings and then gave up on a bad region name would leave the three
        // disagreeing about which regions exist.
        $region_plan = events_admin_plan_regions($region_rows, $errors);

        // The zone arrives from a select box, so anything off the list is a forged post
        // rather than a typo - but it is checked all the same, because a name PHP cannot
        // resolve would silently move every date on the board back to UTC.
        $timezone = trim($mybb->get_input('timezone'));
        if(!array_key_exists($timezone, events_timezone_choices()))
        {
            $errors[] = "Choose an event timezone from the list.";
        }

        // Blank falls back to the default rather than saving a name every label would
        // then be missing.
        $wwcc_name = trim($mybb->get_input('wwcc_name'));
        if($wwcc_name === '')
        {
            $wwcc_name = EVENTS_DEFAULT_WWCC_NAME;
        }

        // Blank turns the fetch off; anything else is requested by the server, so it has
        // to be a web address.
        $legion_api_url = trim($mybb->get_input('legion_api_url'));
        if($legion_api_url !== '' && !preg_match('#^https?://[^\s/]+#i', $legion_api_url))
        {
            $errors[] = "The 501st Legion API must be a web address starting with http:// or https://, or blank.";
        }

        // Stored as the post's id, whichever way the admin named it, so a thread moved to
        // another forum or a board switching to search-friendly URLs still finds it.
        $preapproval_post = events_admin_preapproval_post_id($mybb->get_input('preapproval_post'));
        if($preapproval_post === null)
        {
            $errors[] = "Preapproval Requirements must be a link to a post on this board, its post ID, or blank.";
        }

        if($region_plan !== false && empty($errors))
        {
            $settings = array(
                'events_costume_field' => $mybb->input['costume_field'],
                'events_legion_id_field' => $mybb->input['legion_id_field'],
                'events_legion_api_url' => $legion_api_url,
                'events_wwcc_enabled' => $mybb->get_input('wwcc_enabled', MyBB::INPUT_INT) ? '1' : '0',
                'events_preapproval_enabled' => $mybb->get_input('preapproval_enabled', MyBB::INPUT_INT) ? '1' : '0',
                'events_preapproval_post' => $preapproval_post ? (string)$preapproval_post : '',
                'events_wwcc_name' => $wwcc_name,
                'events_wwcc_field' => $mybb->input['wwcc_field'],
                'events_mobile_field' => $mybb->input['mobile_field'],
                'events_emergency_contact_field' => $mybb->input['emergency_contact_field'],
                'events_preferred_name_field' => $mybb->input['preferred_name_field'],
                'events_event_coordinator_groups' => implode(',', array_filter(array_map('intval', (array)$mybb->get_input('event_coordinator_groups', MyBB::INPUT_ARRAY)))),
                'events_garrison_members_group' => $mybb->input['garrison_members_group'],
                'events_501st_members_group' => $mybb->input['501st_members_group'],
                'events_troop_report_forum' => $mybb->input['troop_report_forum'],
                'events_timezone' => $timezone,
                'events_event_forum' => events_admin_forum_input($mybb->get_input('event_forum')),
                'events_regions' => $region_plan['list'],
                // One dropdown per region, folded back into the single Region=fid setting
                // under the names the regions now have - without that, renaming a region
                // silently unroutes its announcements.
                'events_event_forums' => events_build_region_forums_setting(
                    events_admin_region_forums_from_rows($region_rows, $region_plan['renames'])
                )
            );

            // A rename takes the region's events with it, and they move before the list
            // is written so that an interruption between the two leaves them filed under
            // a region the board can still see rather than under one it cannot.
            $former_forum_ids = events_announcement_forum_ids();
            $announced = events_admin_announced_event_ids($region_plan['moves']);
            $moved = events_admin_apply_region_moves($region_plan['moves']);

            foreach($settings as $name => $value)
            {
                $db->update_query("settings", array("value" => $db->escape_string($value)), "name = '" . $db->escape_string($name) . "'");
            }

            rebuild_settings();

            // The announcements name the region and link to its listing, and the same
            // save may have pointed the region at another forum. Synced against the new
            // settings, which is what rebuild_settings() just put in place.
            $thread_errors = events_admin_sync_region_threads($announced, $former_forum_ids);

            $message = "Settings updated successfully.";
            if($moved > 0)
            {
                $message .= " " . $moved . " " . ($moved === 1 ? "event was" : "events were") . " moved to a renamed region.";
            }

            if($thread_errors)
            {
                flash_message($message . " " . implode(" ", $thread_errors), "error");
            }
            else
            {
                flash_message($message, "success");
            }
            admin_redirect("index.php?module=events&action=settings");
        }

        $page->output_inline_error($errors);
    }
    
    // Get all custom profile fields (fresh from DB each load)
    $profile_fields = array();
    $query = $db->simple_select("profilefields", "*", "", array("order_by" => "name", "order_dir" => "ASC"));
    while($field = $db->fetch_array($query))
    {
        $profile_fields[$field['fid']] = $field['name'];
    }
    
    // Get all user groups
    $user_groups = array();
    $query = $db->simple_select("usergroups", "gid, title", "", array("order_by" => "title", "order_dir" => "ASC"));
    while($group = $db->fetch_array($query))
    {
        $user_groups[$group['gid']] = $group['title'];
    }
    
    $form = new Form("index.php?module=events&action=settings", "post");

    // A form coming back with a validation error still shows what was submitted, so it
    // keeps the token that was submitted with it: it is still based on that state, and a
    // fresh token would let the next save overwrite whatever changed in between.
    echo $form->generate_hidden_field("settings_version", $mybb->request_method == "post"
        ? $mybb->get_input('settings_version')
        : events_admin_settings_version());

    $form_container = new FormContainer("Event Management Settings");

    // Every date the plugin stores is a wall clock with no offset on it, so the board has
    // to say which zone those clocks are read in. The server's own timezone deliberately
    // does not come into it: a garrison's events happen where the garrison is, and a host
    // move should not walk every signup cutoff an hour sideways.
    //
    // The box falls back to the zone actually in force rather than to whatever sorts
    // first, so a board whose setting is empty or names a zone this PHP does not have
    // cannot be moved to Abidjan by an admin saving an unrelated change.
    $timezone_choices = events_timezone_choices();
    $timezone_value = events_admin_settings_value('timezone', 'events_timezone');
    if(!array_key_exists($timezone_value, $timezone_choices))
    {
        $timezone_value = events_timezone_name();
    }

    $form_container->output_row("Event Timezone",
        "Where the garrison is, not where the forum is hosted. Every event date is entered, stored and shown in this zone, and the server's own timezone is ignored - a board on a UTC host whose events happen in Sydney sets this to Australia/Sydney and every time on the board reads as Sydney time. Signup cutoffs, \"the event has ended\" and troop report reminders are all judged against this zone too. The offsets shown are the ones in force right now; a zone that observes daylight saving follows it.",
        $form->generate_select_box("timezone", $timezone_choices, $timezone_value, array("id" => "timezone")));

    // Costume field
    $form_container->output_row("Costume Profile Field", 
        "Select the custom profile field that contains user costumes",
        $form->generate_select_box("costume_field", $profile_fields, events_admin_settings_value('costume_field', 'events_costume_field')));
    
    // Legion ID field
    $form_container->output_row("Legion ID Profile Field",
        "Select the custom profile field that contains Legion IDs",
        $form->generate_select_box("legion_id_field", $profile_fields, events_admin_settings_value('legion_id_field', 'events_legion_id_field')));
    
    $form_container->output_row("501st Legion API",
        "Members' costumes are fetched from here by their Legion ID when they sign up to troop, replacing the ones on their profile. Leave blank to use only the costumes on their profiles.",
        $form->generate_text_box("legion_api_url", events_admin_settings_value('legion_api_url', 'events_legion_api_url'), array("id" => "legion_api_url")),
        "legion_api_url");

    $form_container->output_row("Preapproved Costumes",
        "Lets a member signing up to troop type in a costume they are preapproved for instead of picking one from their profile",
        $form->generate_yes_no_radio("preapproval_enabled", (string)events_admin_settings_value('preapproval_enabled', 'events_preapproval_enabled') === '1' ? '1' : '0', true,
            array("id" => "preapproval_enabled_yes"), array("id" => "preapproval_enabled_no")),
        "", array(), array("id" => "row_preapproval_enabled"));

    // Shown back as the bare id it is stored as, with the link to the post beside the box
    // rather than in it. A web address in a posted field is what a host's ModSecurity
    // rules refuse with a 406 before the plugin ever sees the request, and a box filled
    // with one would make every later save of this page fail the same way. The script
    // below turns a pasted link into its id before the form is sent.
    $preapproval_pid = (int)events_get_setting('preapproval_post');
    if($mybb->request_method == "post")
    {
        $preapproval_post_value = $mybb->get_input('preapproval_post');
    }
    else
    {
        $preapproval_post_value = $preapproval_pid > 0 ? (string)$preapproval_pid : '';
    }
    $preapproval_post_link = '';
    if($preapproval_pid > 0)
    {
        $preapproval_post_link = ' <a href="' . htmlspecialchars_uni($mybb->settings['bburl'] . '/' . get_post_link($preapproval_pid) . '#pid' . $preapproval_pid) . '" target="_blank" rel="noopener" id="preapproval_post_link">View post</a>';
    }
    $form_container->output_row("Preapproval Requirements",
        "A post setting out what a member must do to be preapproved. A member using a preapproved costume is shown it and has to confirm they have followed it each time they sign up. Paste a link to the post or its ID, or leave blank to ask for nothing.",
        $form->generate_text_box("preapproval_post", $preapproval_post_value, array("id" => "preapproval_post")) . $preapproval_post_link,
        "preapproval_post", array(), array("id" => "row_preapproval_post"));

    // Working with children checks. The name and the profile field only mean anything
    // while the check is on, so they are hidden with it - by script, with the rows left
    // showing when there is none, since they post the same either way.
    $wwcc_enabled = events_admin_settings_value('wwcc_enabled', 'events_wwcc_enabled');
    $form_container->output_row("Working With Children Checks",
        "Lets an event require its attendees to have one on file",
        $form->generate_yes_no_radio("wwcc_enabled", (string)$wwcc_enabled === '0' ? '0' : '1', true,
            array("id" => "wwcc_enabled_yes"), array("id" => "wwcc_enabled_no")),
        "", array(), array("id" => "row_wwcc_enabled"));

    $form_container->output_row("Check Name",
        "What the check is called where the garrison is, e.g. Blue Card in Queensland",
        $form->generate_text_box("wwcc_name", events_admin_settings_value('wwcc_name', 'events_wwcc_name'), array("id" => "wwcc_name", "maxlength" => 64)),
        "wwcc_name", array(), array("id" => "row_wwcc_name"));

    $form_container->output_row("Check Profile Field",
        "Select the custom profile field that contains the check's number",
        $form->generate_select_box("wwcc_field", $profile_fields, events_admin_settings_value('wwcc_field', 'events_wwcc_field'), array("id" => "wwcc_field")),
        "wwcc_field", array(), array("id" => "row_wwcc_field"));
    
    // Mobile field
    $form_container->output_row("Mobile Number Profile Field",
        "Select the custom profile field that contains mobile numbers",
        $form->generate_select_box("mobile_field", $profile_fields, events_admin_settings_value('mobile_field', 'events_mobile_field')));
    
    // Emergency contact field
    $form_container->output_row("Emergency Contact Profile Field",
        "Select the custom profile field that contains emergency contact information",
        $form->generate_select_box("emergency_contact_field", $profile_fields, events_admin_settings_value('emergency_contact_field', 'events_emergency_contact_field')));
    
    // Preferred name field
    $form_container->output_row("Preferred Name Profile Field",
        "Select the custom profile field that contains the name a member goes by on the day",
        $form->generate_select_box("preferred_name_field", $profile_fields, events_admin_settings_value('preferred_name_field', 'events_preferred_name_field')));

    // Event Coordinator groups
    $selected_coordinator_groups = $mybb->request_method == "post"
        ? array_filter(array_map('intval', (array)$mybb->get_input('event_coordinator_groups', MyBB::INPUT_ARRAY)))
        : array_filter(array_map('intval', explode(',', (string)$mybb->settings['events_event_coordinator_groups'])));
    $form_container->output_row("Event Coordinator User Groups",
        "Members of these groups may coordinate events, and are who the Coordinator dropdown on an event is drawn from (hold ctrl to select more than one)",
        $form->generate_select_box("event_coordinator_groups[]", $user_groups, $selected_coordinator_groups, array("id" => "event_coordinator_groups", "multiple" => true, "size" => 6)));
    
    // Garrison Members group
    $form_container->output_row("Garrison Members Group",
        "User group for Garrison Members (required for Legion ID validation)",
        $form->generate_select_box("garrison_members_group", $user_groups, events_admin_settings_value('garrison_members_group', 'events_garrison_members_group')));
    
    // 501st Members group
    $form_container->output_row("501st Members Group",
        "User group for 501st Members (required for Legion ID validation)",
        $form->generate_select_box("501st_members_group", $user_groups, events_admin_settings_value('501st_members_group', 'events_501st_members_group')));
    
    // Troop report forum
    $form_container->output_row("Troop Report Forum",
        "Forum where troop reports should be posted",
        events_admin_forum_select($form, "troop_report_forum", events_admin_settings_value('troop_report_forum', 'events_troop_report_forum'), "troop_report_forum"));
    
    // Event announcement forums. An event's thread is generated and posted by the
    // plugin, so the board has to say where - and a garrison running regions across
    // several states wants each region's events in that region's forum rather than all
    // of them in one. The per-region choice is on the region's own row, below; this is
    // the fallback for the regions that have not made one.
    $form_container->output_row("Default Event Forum",
        "Forum where event threads are posted when the region they belong to has None beside it in the list below. Leave this unset too and those events are not announced at all.",
        events_admin_forum_select($form, "event_forum", events_admin_settings_value('event_forum', 'events_event_forum'), "event_forum", true));

    $form_container->end();

    // The regions, each with the forum its announcements go to on the row beside it.
    // Which forum a region posts to is a property of that region, so it belongs on the
    // region rather than in a parallel list of "<Region> Event Forum" rows that the two
    // would have to be read side by side to make sense of.
    events_admin_output_region_rows($form, $region_rows, $region_counts);

    $buttons = array($form->generate_submit_button("Save Settings"));
    $form->output_submit_wrapper($buttons);
    $form->end();

    echo <<<HTML
<script type="text/javascript">
(function () {
    var yes = document.getElementById('wwcc_enabled_yes');
    var no = document.getElementById('wwcc_enabled_no');
    if (!yes || !no) { return; }

    var rows = [document.getElementById('row_wwcc_name'), document.getElementById('row_wwcc_field')];

    function update() {
        for (var i = 0; i < rows.length; i++) {
            if (rows[i]) { rows[i].style.display = yes.checked ? '' : 'none'; }
        }
    }

    yes.addEventListener('change', update);
    no.addEventListener('change', update);
    update();
})();

(function () {
    var yes = document.getElementById('preapproval_enabled_yes');
    var no = document.getElementById('preapproval_enabled_no');
    var row = document.getElementById('row_preapproval_post');
    if (!yes || !no || !row) { return; }

    function update() { row.style.display = yes.checked ? '' : 'none'; }

    yes.addEventListener('change', update);
    no.addEventListener('change', update);
    update();
})();

// A pasted link is turned into the post's id as soon as it is pasted (or thread-N for a
// thread, whose first post only the server can look up), and again as the form is sent,
// so it never reaches the server as a web address: ModSecurity refuses a POST carrying
// one with a 406. Read the same way as events_admin_preapproval_post_id(); an address
// that names no post is left alone for the server to reject.
(function () {
    var box = document.getElementById('preapproval_post');
    if (!box || !box.form) { return; }

    function toId() {
        var value = box.value.replace(/^\s+|\s+$/g, '');
        var match;
        if ((match = /(?:[?&;]pid=|#pid|\bpost-)(\d+)/i.exec(value))) {
            box.value = match[1];
        } else if ((match = /(?:[?&;]tid=|\bthread-)(\d+)/i.exec(value))) {
            box.value = 'thread-' + match[1];
        }
    }

    // Not on every keystroke, which would cut a link typed by hand off at its first digit.
    box.addEventListener('paste', function () { setTimeout(toId, 0); });
    box.addEventListener('change', toId);
    box.form.addEventListener('submit', toId);
})();
</script>
HTML;

    // After the form is closed: it carries a form of its own, and HTML has no nested
    // forms.
    events_admin_output_region_modals($region_rows, $region_counts);
}

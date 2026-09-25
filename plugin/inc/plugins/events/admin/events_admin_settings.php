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

    return sha1(json_encode($values));
}

function events_admin_settings()
{
    global $mybb, $db, $page, $lang;

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

        if($region_plan !== false && empty($errors))
        {
            $settings = array(
                'events_costume_field' => $mybb->input['costume_field'],
                'events_tk_id_field' => $mybb->input['tk_id_field'],
                'events_wwcc_field' => $mybb->input['wwcc_field'],
                'events_mobile_field' => $mybb->input['mobile_field'],
                'events_emergency_contact_field' => $mybb->input['emergency_contact_field'],
                'events_preferred_name_field' => $mybb->input['preferred_name_field'],
                'events_event_coordinator_groups' => implode(',', array_filter(array_map('intval', (array)$mybb->get_input('event_coordinator_groups', MyBB::INPUT_ARRAY)))),
                'events_garrison_members_group' => $mybb->input['garrison_members_group'],
                'events_501st_members_group' => $mybb->input['501st_members_group'],
                'events_troop_report_forum' => $mybb->input['troop_report_forum'],
                'events_timezone' => $timezone,
                'events_event_forum' => $mybb->get_input('event_forum'),
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
    
    // Get all forums
    $forums = array();
    $query = $db->simple_select("forums", "fid, name", "", array("order_by" => "name", "order_dir" => "ASC"));
    while($forum = $db->fetch_array($query))
    {
        $forums[$forum['fid']] = $forum['name'];
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
    
    // TK ID field
    $form_container->output_row("TK ID Profile Field",
        "Select the custom profile field that contains TK IDs",
        $form->generate_select_box("tk_id_field", $profile_fields, events_admin_settings_value('tk_id_field', 'events_tk_id_field')));
    
    // WWCC field
    $form_container->output_row("WWCC Profile Field",
        "Select the custom profile field that contains WWCC numbers",
        $form->generate_select_box("wwcc_field", $profile_fields, events_admin_settings_value('wwcc_field', 'events_wwcc_field')));
    
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
        $form->generate_select_box("troop_report_forum", $forums, events_admin_settings_value('troop_report_forum', 'events_troop_report_forum')));
    
    // Event announcement forums. An event's thread is generated and posted by the
    // plugin, so the board has to say where - and a garrison running regions across
    // several states wants each region's events in that region's forum rather than all
    // of them in one. The per-region choice is on the region's own row, below; this is
    // the fallback for the regions that have not made one.
    $forum_choices = array('' => 'None') + $forums;

    $form_container->output_row("Default Event Forum",
        "Forum where event threads are posted when the region they belong to has None beside it in the list below. Leave this unset too and those events are not announced at all.",
        $form->generate_select_box("event_forum", $forum_choices, events_admin_settings_value('event_forum', 'events_event_forum')));

    $form_container->end();

    // The regions, each with the forum its announcements go to on the row beside it.
    // Which forum a region posts to is a property of that region, so it belongs on the
    // region rather than in a parallel list of "<Region> Event Forum" rows that the two
    // would have to be read side by side to make sense of.
    events_admin_output_region_rows($form, $region_rows, $region_counts, $forum_choices);

    $buttons = array($form->generate_submit_button("Save Settings"));
    $form->output_submit_wrapper($buttons);
    $form->end();

    // After the form is closed: it carries a form of its own, and HTML has no nested
    // forms.
    events_admin_output_region_modals($region_rows, $region_counts);
}

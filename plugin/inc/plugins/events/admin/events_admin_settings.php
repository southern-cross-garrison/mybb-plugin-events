<?php
/**
 * MyBB Event Plugin - Admin Settings
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

function events_admin_settings()
{
    global $mybb, $db, $page, $lang;
    
    $page->output_nav_tabs($sub_tabs, 'settings');
    
    if($mybb->request_method == "post")
    {
        // Update settings
        $settings = array(
            'events_costume_field' => $mybb->input['costume_field'],
            'events_tk_id_field' => $mybb->input['tk_id_field'],
            'events_wwcc_field' => $mybb->input['wwcc_field'],
            'events_mobile_field' => $mybb->input['mobile_field'],
            'events_emergency_contact_field' => $mybb->input['emergency_contact_field'],
            'events_event_coordinator_groups' => $mybb->input['event_coordinator_groups'],
            'events_scg_members_group' => $mybb->input['scg_members_group'],
            'events_501st_members_group' => $mybb->input['501st_members_group'],
            'events_troop_report_forum' => $mybb->input['troop_report_forum']
        );
        
        foreach($settings as $name => $value)
        {
            $db->update_query("settings", array("value" => $db->escape_string($value)), "name = '" . $db->escape_string($name) . "'");
        }
        
        rebuild_settings();
        
        flash_message("Settings updated successfully.", "success");
        admin_redirect("index.php?module=events&action=settings");
    }
    
    // Get all custom profile fields
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
    
    $form_container = new FormContainer("Event Management Settings");
    
    // Costume field
    $form_container->output_row("Costume Profile Field", 
        "Select the custom profile field that contains user costumes",
        $form->generate_select_box("costume_field", $profile_fields, $mybb->settings['events_costume_field']));
    
    // TK ID field
    $form_container->output_row("TK ID Profile Field",
        "Select the custom profile field that contains TK IDs",
        $form->generate_select_box("tk_id_field", $profile_fields, $mybb->settings['events_tk_id_field']));
    
    // WWCC field
    $form_container->output_row("WWCC Profile Field",
        "Select the custom profile field that contains WWCC numbers",
        $form->generate_select_box("wwcc_field", $profile_fields, $mybb->settings['events_wwcc_field']));
    
    // Mobile field
    $form_container->output_row("Mobile Number Profile Field",
        "Select the custom profile field that contains mobile numbers",
        $form->generate_select_box("mobile_field", $profile_fields, $mybb->settings['events_mobile_field']));
    
    // Emergency contact field
    $form_container->output_row("Emergency Contact Profile Field",
        "Select the custom profile field that contains emergency contact information",
        $form->generate_select_box("emergency_contact_field", $profile_fields, $mybb->settings['events_emergency_contact_field']));
    
    // Event Coordinator groups
    $form_container->output_row("Event Coordinator User Groups",
        "Select user groups that have Event Coordinator permissions",
        $form->generate_text_box("event_coordinator_groups", $mybb->settings['events_event_coordinator_groups']));
    
    // SCG Members group
    $form_container->output_row("SCG Members Group",
        "User group for SCG Members (required for TK ID validation)",
        $form->generate_select_box("scg_members_group", $user_groups, $mybb->settings['events_scg_members_group']));
    
    // 501st Members group
    $form_container->output_row("501st Members Group",
        "User group for 501st Members (required for TK ID validation)",
        $form->generate_select_box("501st_members_group", $user_groups, $mybb->settings['events_501st_members_group']));
    
    // Troop report forum
    $form_container->output_row("Troop Report Forum",
        "Forum where troop reports should be posted",
        $form->generate_select_box("troop_report_forum", $forums, $mybb->settings['events_troop_report_forum']));
    
    $form_container->end();
    
    $buttons[] = $form->generate_submit_button("Save Settings");
    $form->output_submit_wrapper($buttons);
    $form->end();
    
    $page->output_footer();
}

<?php
/**
 * MyBB Event Plugin - The event card
 *
 * An event is shown in two places, and they are meant to read as one thing: on event.php,
 * for an event that has no announcement thread yet (a pending draft, a region with no
 * forum configured), and in place of the first post of its announcement thread, which is
 * where every live event is read from. The card is built here so the two cannot drift -
 * the only thing that differs between them is where the signup list's filter posts back
 * to, because that is whichever page the card is sitting on.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

/**
 * The event card: details, signup actions, who is attending and the coordinator controls.
 *
 * Reads the signup list's filters from the request, since the filter form posts back to
 * whichever page the card is on.
 *
 * @param array $event Event row
 * @param int $thread_id The announcement thread the card is rendered into, or 0 on event.php
 * @return string HTML
 */
function events_render_event_card(array $event, $thread_id = 0)
{
    global $mybb, $templates, $theme;

    $event_id = (int)$event['id'];
    $thread_id = (int)$thread_id;
    $is_gec = events_is_event_gec($event_id);
    $event_days = events_get_event_days($event_id);

    // Read defensively: an event written before the column existed has no key at all until
    // the board has been re-activated.
    $event_address = isset($event['address']) ? trim((string)$event['address']) : '';
    $filter_costume = $mybb->get_input('filter_costume');
    $filter_day = $mybb->get_input('filter_day', MyBB::INPUT_INT);

    // Where the signup list's filter form goes back to: the page the card is on. In a
    // thread that is page one of the thread, which is the only page the card is on.
    if($thread_id)
    {
        $event_card_action = 'showthread.php';
        $event_card_hidden = '<input type="hidden" name="tid" value="' . $thread_id . '" />';
        $event_card_url = 'showthread.php?tid=' . $thread_id;
    }
    else
    {
        $event_card_action = 'event.php';
        $event_card_hidden = '<input type="hidden" name="id" value="' . $event_id . '" />';
        $event_card_url = 'event.php?id=' . $event_id;
    }

    // The stored value, for data-event-status on the wrapper - see events_status_label()
    // for why what the page *says* is not always this.
    $event_status = htmlspecialchars_uni($event['status']);
    $event_status_label = htmlspecialchars_uni(events_status_label($event));
    // The one label that is a job outstanding rather than a state, coloured the same way
    // the listing colours it.
    $event_status_class = events_needs_troop_report($event) ? 'event_status_needs_report' : '';
    $event_region = htmlspecialchars_uni($event['region']);
    $event_start_date = events_format_date($event['start_date']);
    $event_end_date = events_format_date($event['end_date']);
    $event_description = events_parse_description($event['description']);
    $rsvp_count = events_rsvp_count($event_id, 'trooper');
    $wrangler_count = events_rsvp_count($event_id, 'wrangler');

    // Built here rather than sat in the template, because an event with no address has no
    // row at all and a MyBB template cannot ask.
    $event_address_row = '';
    $event_address_link = events_address_link($event_address, 'event_address_link');
    if($event_address_link !== '')
    {
        $event_address_row = '<p><strong>Address:</strong> <span id="event_address">' . $event_address_link . '</span></p>';
    }

    // The point of contact is optional, so like the address it is a whole row or nothing. A
    // member who has since been deleted leaves a uid that names nobody, which reads the same
    // as never having been set rather than as a row with a blank name in it.
    $event_poc_row = '';
    $poc_user = !empty($event['poc_user_id']) ? events_get_user($event['poc_user_id']) : null;
    if(!empty($poc_user['uid']))
    {
        $event_poc_row = '<p><strong>Point of Contact:</strong> <span id="event_poc">'
            . build_profile_link(htmlspecialchars_uni($poc_user['username']), (int)$poc_user['uid']) . '</span></p>';
    }

    $event_cutoff_row = '';
    if(!empty($event['signup_cutoff']) && $event['signup_cutoff'] !== '0000-00-00 00:00:00')
    {
        $event_cutoff_row = '<p><strong>Signups close:</strong> <span id="event_cutoff">' . events_format_date($event['signup_cutoff']) . '</span></p>';
    }

    // Both counts as the listing's own lozenges, rather than a bold "Troopers:" row and a
    // bold "Wranglers:" row. The listing has room for "T 1 / W 0" and no room to say what
    // that means; this is where it gets said, in the same colours and the same order, so
    // the abbreviation is readable by the time anyone meets it.
    //
    // A tab across the card's top right corner rather than one more line in the meta list:
    // the turnout is the one fact on this page a member scans for before they read anything
    // else, and in the list it sat below the dates reading as another detail. It is written
    // here and placed by the template outside the table, because it is positioned against
    // the card rather than against a cell - see .event_counts_tab in the stylesheet.
    $event_counts_row = '<div id="event_signup_counts" class="event_counts event_counts_tab">'
        . events_signup_counts($rsvp_count, $wrangler_count, true, true)
        . '</div>';

    $event_capacity_row = '';
    $event_capacity = events_capacity_text($event, !empty($event_days));
    if($event_capacity !== '')
    {
        $event_capacity_row = '<p><strong>Places:</strong> <span id="event_capacity">' . htmlspecialchars_uni($event_capacity) . '</span></p>';
    }

    $event_wwcc_row = '';
    if(!empty($event['requires_wwcc']))
    {
        $event_wwcc_row = '<p id="event_requires_wwcc"><strong>Requires WWCC:</strong> Yes</p>';
    }

    $event_days_block = '';
    if(!empty($event_days))
    {
        $items = '';
        foreach($event_days as $day)
        {
            $items .= '<li class="event_day" data-day-id="' . (int)$day['id'] . '">' . events_day_label($day) . '</li>';
        }
        $event_days_block = '<div id="event_days"><h3 class="events_section_heading">Event Days</h3><ul>' . $items . '</ul></div>';
    }

    $signup = events_get_user_signup($event_id);
    $has_signup = !empty($signup);
    $lock_reason = events_signup_lock_reason($event);
    $queues = events_signup_queues($event_id);

    // The signup call to action is styled as a button (see the events_event_card template)
    // with the primary colour matching the trooper dot on the events listing. Everything
    // that is not the signup is a secondary button, so signing up stays the obvious thing
    // to do.
    $event_actions = '';
    if($has_signup)
    {
        // One pill per role held, each naming the days it covers, so a mixed signup reads
        // back as what it is rather than as a single "you are attending". The days a role
        // is waiting for get a pill of their own, in the waitlist's colours, so a place
        // and a place in the queue can never be read as the same thing.
        foreach(events_rsvp_roles() as $role)
        {
            if(!isset($signup[$role]))
            {
                continue;
            }

            $held = $signup[$role];
            $attending_days = array();
            $waiting = array();

            if(empty($held['days']))
            {
                if($held['status'] === 'waitlisted')
                {
                    $place = events_place_status($event, $role, 0, $mybb->user['uid'], $queues);
                    $waiting[] = '#' . $place['position'];
                }
            }
            else
            {
                foreach($held['days'] as $day_id)
                {
                    if($held['day_status'][$day_id] === 'waitlisted')
                    {
                        $place = events_place_status($event, $role, $day_id, $mybb->user['uid'], $queues);
                        $label = events_day_labels($event_days, array($day_id), 'short');
                        $waiting[] = (empty($label) ? '' : $label[0] . ' ') . '#' . $place['position'];
                    }
                    else
                    {
                        $attending_days[] = $day_id;
                    }
                }
            }

            if($held['status'] === 'attending' && (empty($held['days']) || !empty($attending_days)))
            {
                // Days are only spelled out when the role covers some of them. "Trooping"
                // says everything there is to say about a signup that covers the whole event.
                $label = events_role_verb($role);
                $day_labels = events_day_labels($event_days, $attending_days, 'short');
                if(!empty($day_labels) && count($day_labels) < count($event_days))
                {
                    $label .= ': ' . implode(', ', $day_labels);
                }

                $event_actions .= '<span class="event_action_status event_signup_status event_action_status_' . $role . '" id="event_signup_status_' . $role . '">'
                                . '<span class="event_signup_tick">&#10003;</span> ' . htmlspecialchars_uni($label) . '</span>';
            }

            if(!empty($waiting))
            {
                $event_actions .= '<span class="event_action_status event_signup_status event_action_status_waitlisted" id="event_signup_waitlist_' . $role . '" data-role="' . $role . '">'
                                . 'Waitlisted: ' . htmlspecialchars_uni(events_role_verb($role) . ' (' . implode(', ', $waiting) . ')') . '</span>';
            }
        }

        if($lock_reason === null)
        {
            $event_actions .= '<a class="event_action event_action_secondary" href="rsvp.php?id=' . $event_id . '" id="event_signup_update">Update Your Signup</a>';
        }
    }
    elseif($lock_reason === null)
    {
        // A full event is still one to sign up to - the waitlist is how its places are
        // given out again - but the button has to say that is what it does. "Sign Up to
        // Attend" on an event with no room left reads as a promise of a place.
        $full_roles = events_full_roles($event, $queues);

        if(count($full_roles) === count(events_rsvp_roles()))
        {
            $event_actions .= '<a class="event_action event_action_primary event_action_waitlist" href="rsvp.php?id=' . $event_id . '" id="event_signup" data-waitlist="1">Join the Waitlist</a>'
                            . '<span class="event_signup_full_note" id="event_signup_full_note">Every place is taken. Signing up puts you on the waitlist, and places are given out in signup order as they free up.</span>';
        }
        else
        {
            $event_actions .= '<a class="event_action event_action_primary" href="rsvp.php?id=' . $event_id . '" id="event_signup">Sign Up to Attend</a>';

            if(!empty($full_roles))
            {
                $role = reset($full_roles);
                $event_actions .= '<span class="event_signup_full_note" id="event_signup_full_note">'
                                . events_role_label($role) . ' places are full - new ' . strtolower(events_role_label($role)) . ' signups join the waitlist.</span>';
            }
        }
    }
    else
    {
        $event_actions .= '<span class="event_action event_action_locked" id="event_signup_locked" data-lock-reason="' . htmlspecialchars_uni($lock_reason) . '">'
                        . htmlspecialchars_uni(events_signup_lock_message($lock_reason)) . '</span>';
    }

    // A wrangler is attending too, so any signup with a place gets the calendar file. A
    // place in the queue is not one yet: the calendar gets it once it is.
    if($has_signup && events_signup_has_place($signup))
    {
        $event_actions .= '<a class="event_action event_action_secondary" href="ical.php?id=' . $event_id . '" id="event_ical">Add to Calendar</a>';
    }

    // No "View Discussion Thread" button: an event with a thread the viewer can open is
    // shown *in* that thread, and event.php only renders the card itself when there is no
    // such thread to send them to.

    if(events_can_create_troop_report($event))
    {
        $event_actions .= '<a class="event_action event_action_secondary" href="troop_report.php?id=' . $event_id . '" id="event_troop_report">Create Troop Report</a>';
    }

    $report = events_get_troop_report($event_id);
    if($report && !empty($report['posted_at']) && !empty($report['thread_id']))
    {
        $event_actions .= '<a class="event_action event_action_secondary" href="showthread.php?tid=' . (int)$report['thread_id'] . '" id="event_troop_report_posted">View Troop Report</a>';
    }

    // -----------------------------------------------------------------------
    // Coordinator controls
    // -----------------------------------------------------------------------
    // On the same bar as the signup actions rather than in a block of their own: they are
    // two more buttons, and only the people who can use them ever see them. Grouped so the
    // stylesheet can push them to the far end of the bar, away from the signup.
    if($is_gec)
    {
        $event_actions .= '<span id="gec_controls" class="gec_actions">'
            . '<a class="event_action event_action_secondary" href="manage_event.php?id=' . $event_id . '" id="gec_edit">Edit Event</a>'
            . '<a class="event_action event_action_secondary" href="event.php?id=' . $event_id . '&amp;action=attendance" id="gec_attendance">View Attendance Sheet</a>'
            . '</span>';
    }

    // -----------------------------------------------------------------------
    // Signup list
    // -----------------------------------------------------------------------
    // Anyone who can see the event can see who is going, so the list is part of the card
    // rather than something to go and fetch. It carries no contact details - mobile and
    // emergency contact live on the attendance sheet, which stays behind
    // events_is_event_gec().
    // The costume filter can only ever match troopers, so wranglers drop out of a
    // filtered list by definition. That is intended, not an oversight.
    $attendees = array_merge(
        events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day, 'role' => 'trooper')),
        events_get_attendees($event_id, array('costume' => $filter_costume, 'day' => $filter_day, 'role' => 'wrangler'))
    );

    $filter_day_select = '';
    if(!empty($event_days))
    {
        $options = '<option value="0">All days</option>';
        foreach($event_days as $day)
        {
            $selected = ($filter_day === (int)$day['id']) ? ' selected="selected"' : '';
            $options .= '<option value="' . (int)$day['id'] . '"' . $selected . '>' . events_day_label($day) . '</option>';
        }
        $filter_day_select = '<label>Day: <select name="filter_day" id="filter_day" class="events_select">' . $options . '</select></label> ';
    }

    $rsvp_rows = '';
    foreach($attendees as $attendee)
    {
        $attended_day_ids = array();
        foreach($attendee['days'] as $day)
        {
            $attended_day_ids[] = (int)$day['id'];
        }
        $day_labels = events_day_labels($event_days, $attended_day_ids, 'short');

        // Only the parts a person actually has. A wrangler carries no Legion ID and no
        // costume, and an event with no days has no days to name - an empty span each time
        // would leave the separator dots hanging off the end of the line.
        $details = array(
            'rsvp_tkid'     => htmlspecialchars_uni($attendee['tk_id']),
            'rsvp_costumes' => htmlspecialchars_uni(implode(', ', $attendee['costumes'])),
            'rsvp_days'     => htmlspecialchars_uni(implode(', ', $day_labels)),
            'rsvp_date'     => events_format_date($attendee['rsvp_date']),
        );

        $rsvp_rows .= '<li class="rsvp_row" data-uid="' . $attendee['uid'] . '">';
        $rsvp_rows .= '<span class="rsvp_username">' . htmlspecialchars_uni($attendee['username']) . '</span>';
        $rsvp_rows .= '<span class="rsvp_role event_pill event_pill_' . $attendee['role'] . '">'
                    . events_role_label($attendee['role']) . '</span>';

        foreach($details as $class => $value)
        {
            if($value === '')
            {
                continue;
            }

            $rsvp_rows .= '<span class="rsvp_detail ' . $class . '">' . $value . '</span>';
        }

        $rsvp_rows .= '</li>';
    }

    $rsvp_list_count = count($attendees);

    if($rsvp_rows === '')
    {
        $rsvp_rows = '<li id="rsvp_list_empty">Nobody has signed up yet.</li>';
    }

    // A filter that is doing something stays on show, so a short list is never a mystery:
    // the panel that explains why it is short is already open above it.
    $rsvp_filter_open = ($filter_costume !== '' || $filter_day) ? ' open' : '';

    $rsvp_waitlist = events_render_card_waitlist($event_id, $event_days, $filter_costume, $filter_day);

    $filter_costume = htmlspecialchars_uni($filter_costume);

    eval("\$rsvp_list = \"" . $templates->get("events_rsvp_list") . "\";");

    $events_print_header = events_print_header($event['title'], array(
        $event['region'],
        $event_address,
        events_format_date($event['start_date']),
    ));

    eval("\$event_card = \"" . $templates->get("events_event_card") . "\";");

    return $event_card;
}

/**
 * The card's waitlist: who is waiting for a place, in the order they will get one.
 *
 * Under the attendance list and filtered the same way, but in signup order rather than
 * by name, because the order is the point: it is who gets the next place. Nothing at all
 * when nobody is waiting.
 *
 * @param int $event_id
 * @param array $event_days
 * @param string $filter_costume
 * @param int $filter_day
 * @return string HTML
 */
function events_render_card_waitlist($event_id, array $event_days, $filter_costume, $filter_day)
{
    $waiting = array();
    foreach(events_rsvp_roles() as $role)
    {
        $waiting = array_merge($waiting, events_get_attendees($event_id, array(
            'costume' => $filter_costume,
            'day'     => $filter_day,
            'role'    => $role,
            'status'  => 'waitlisted',
        )));
    }

    if(empty($waiting))
    {
        return '';
    }

    // The two roles are fetched apart and put back into one queue order.
    usort($waiting, function($a, $b) {
        $compared = strcmp($a['queued_at'], $b['queued_at']);
        return $compared !== 0 ? $compared : $a['rsvp_id'] - $b['rsvp_id'];
    });

    $rows = '';
    foreach($waiting as $member)
    {
        $day_ids = array();
        foreach($member['days'] as $day)
        {
            $day_ids[] = (int)$day['id'];
        }
        $day_labels = events_day_labels($event_days, $day_ids, 'short');

        $rows .= '<li class="waitlist_row" data-uid="' . $member['uid'] . '" data-role="' . $member['role'] . '">'
            . '<span class="rsvp_username">' . htmlspecialchars_uni($member['username']) . '</span>'
            . '<span class="rsvp_role event_pill event_pill_' . $member['role'] . '">' . events_role_label($member['role']) . '</span>'
            . '<span class="event_pill event_pill_waitlisted">Waitlisted</span>';

        if(!empty($day_labels))
        {
            $rows .= '<span class="rsvp_detail rsvp_days">' . htmlspecialchars_uni(implode(', ', $day_labels)) . '</span>';
        }

        $rows .= '<span class="rsvp_detail rsvp_date">' . events_format_date($member['queued_at']) . '</span>'
            . '</li>';
    }

    return '<div id="waitlist_list">'
        . '<h3 id="waitlist_heading" class="events_section_heading">Waitlist <span id="waitlist_count">(' . count($waiting) . ')</span></h3>'
        . '<p class="events_hint" id="waitlist_hint">In signup order. When a place frees up it goes to the first person waiting for that role and day.</p>'
        . '<ol id="waitlist_rows">' . $rows . '</ol>'
        . '</div>';
}

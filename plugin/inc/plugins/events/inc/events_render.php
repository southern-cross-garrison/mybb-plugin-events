<?php
/**
 * MyBB Event Plugin - Shared HTML building helpers
 *
 * MyBB templates are eval'd double-quoted strings: they can interpolate variables but
 * have no conditionals or loops. Anything repeated or conditional is therefore built
 * here and handed to the template as a single variable.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

define('EVENTS_REGIONS', 'Sydney,Hunter,Canberra,Other');

/**
 * @return array
 */
function events_regions()
{
    return explode(',', EVENTS_REGIONS);
}

/**
 * <option> markup for the region filter.
 *
 * @param string $selected
 * @return string
 */
function events_region_options($selected)
{
    $html = '<option value="">All Regions</option>';
    foreach(events_regions() as $region)
    {
        $is_selected = ($region === $selected) ? ' selected="selected"' : '';
        $html .= '<option value="' . htmlspecialchars_uni($region) . '"' . $is_selected . '>' . htmlspecialchars_uni($region) . '</option>';
    }

    return $html;
}

/**
 * Neutralise BBCode in a value interpolated into a generated post.
 *
 * The troop report draft is a BBCode document that a human then edits and posts, so the
 * document itself has to stay authorable - only the data interpolated into it is
 * neutralised. Usernames, TK IDs and costumes are all user-controlled, and a value
 * containing "[/b]" or "[url=...]" would otherwise be parsed as markup in the posted
 * thread.
 *
 * MyBB's parser leaves numeric character references alone (see parse_html()), so &#91;
 * survives to render as a literal bracket instead of opening a tag. Note that the draft
 * must then be written into the textarea with a plain htmlspecialchars(), which escapes
 * the ampersand - MyBB's own htmlspecialchars_uni() preserves &#91; and the browser
 * would decode it straight back to "[" before the form was submitted.
 *
 * @param string $value
 * @return string
 */
function events_escape_bbcode($value)
{
    return str_replace(array('[', ']'), array('&#91;', '&#93;'), (string)$value);
}

/**
 * Human label for a single event day.
 *
 * @param array $day
 * @return string
 */
function events_day_label($day)
{
    $label = my_date('D j M Y', strtotime($day['date']), 0, 0);

    if(!empty($day['start_time']) && !empty($day['end_time']))
    {
        $label .= ' (' . my_date('H:i', strtotime($day['date'] . ' ' . $day['start_time']), 0, 0)
                . ' - ' . my_date('H:i', strtotime($day['date'] . ' ' . $day['end_time']), 0, 0) . ')';
    }

    return $label;
}

/**
 * Short label used in dense tables.
 *
 * @param array $day
 * @return string
 */
function events_day_short_label($day)
{
    return my_date('j M', strtotime($day['date']), 0, 0);
}

/**
 * Build a month grid for the calendar view.
 *
 * @param int $month_start Unix timestamp of the first day of the month
 * @param array $events Events keyed in display order
 * @param array $user_rsvps Event ids the viewer has RSVPed to
 * @return string table rows
 */
function events_calendar_grid($month_start, array $events, array $user_rsvps)
{
    $month = (int)my_date('n', $month_start, 0, 0);
    $year = (int)my_date('Y', $month_start, 0, 0);
    $days_in_month = (int)date('t', $month_start);

    // Bucket events by every date they span so multi-day events appear on each day.
    $by_date = array();
    foreach($events as $event)
    {
        $cursor = strtotime(my_date('Y-m-d', strtotime($event['start_date']), 0, 0));
        $last = strtotime(my_date('Y-m-d', strtotime($event['end_date']), 0, 0));
        $guard = 0;
        while($cursor <= $last && $guard++ < 400)
        {
            $by_date[date('Y-m-d', $cursor)][] = $event;
            $cursor = strtotime('+1 day', $cursor);
        }
    }

    // Monday-first grid.
    $lead = ((int)date('N', $month_start)) - 1;
    $cells = array();
    for($i = 0; $i < $lead; $i++)
    {
        $cells[] = '<td class="other_month"></td>';
    }

    for($day = 1; $day <= $days_in_month; $day++)
    {
        $date = sprintf('%04d-%02d-%02d', $year, $month, $day);
        $content = '<strong>' . $day . '</strong>';

        if(isset($by_date[$date]))
        {
            foreach($by_date[$date] as $event)
            {
                $class = in_array($event['id'], $user_rsvps) ? 'calendar_event rsvped' : 'calendar_event';
                $content .= '<a class="' . $class . '" data-event-id="' . (int)$event['id'] . '" href="event.php?id=' . (int)$event['id'] . '">'
                          . htmlspecialchars_uni($event['title']) . '</a>';
            }
        }

        $cells[] = '<td data-date="' . $date . '">' . $content . '</td>';
    }

    while(count($cells) % 7 !== 0)
    {
        $cells[] = '<td class="other_month"></td>';
    }

    $rows = '';
    foreach(array_chunk($cells, 7) as $week)
    {
        $rows .= '<tr>' . implode('', $week) . '</tr>';
    }

    return $rows;
}

/**
 * The wizard steps that still apply, in order, given what has been chosen so far.
 *
 * The sequence is recomputed on every request rather than fixed up front, because the
 * attendance step is what decides the rest of it: a signup with no trooping day never
 * shows the costumes step, and the TK ID only becomes a prerequisite once one day is
 * being trooped. Attendance therefore always comes first and is always shown - it is
 * where the member chooses what they are signing up to.
 *
 * @param array $roles The roles the signup currently holds
 * @param array $missing Prerequisite fields still missing for those roles
 * @return array
 */
function events_signup_steps(array $roles, array $missing)
{
    $steps = array('attendance');

    if(!empty($missing))
    {
        $steps[] = 'prerequisites';
    }

    if(in_array('trooper', $roles, true))
    {
        $steps[] = 'costumes';
    }

    $steps[] = 'confirm';

    return $steps;
}

/**
 * The step that follows $step, or 'confirm' at the end of the sequence.
 *
 * @param string $step
 * @param array $steps
 * @return string
 */
function events_signup_step_after($step, array $steps)
{
    $index = array_search($step, $steps, true);

    return ($index === false || !isset($steps[$index + 1])) ? 'confirm' : $steps[$index + 1];
}

/**
 * How a role reads as an activity rather than as a job title.
 *
 * @param string $role
 * @return string
 */
function events_role_verb($role)
{
    return $role === 'wrangler' ? 'Wrangling' : 'Trooping';
}

/**
 * Labels for the subset of an event's days a signup covers, in the event's own order.
 *
 * @param array $event_days
 * @param array $day_ids
 * @param bool $short
 * @return array
 */
function events_day_labels(array $event_days, array $day_ids, $short = false)
{
    $day_ids = array_map('intval', $day_ids);

    $labels = array();
    foreach($event_days as $day)
    {
        if(in_array((int)$day['id'], $day_ids, true))
        {
            $labels[] = $short ? events_day_short_label($day) : events_day_label($day);
        }
    }

    return $labels;
}

/**
 * The "what you are signing up to" block shared by the confirmation step, the success
 * page and the coordinator-facing summaries.
 *
 * An event with no configured days has nothing to list per role, so it collapses to the
 * single "Attending as" line.
 *
 * @param array $event_days
 * @param array $role_days role => array of event_day_id
 * @param string $id_prefix Element id prefix, so the confirm and success pages stay distinguishable
 * @return string
 */
function events_signup_summary_html(array $event_days, array $role_days, $id_prefix)
{
    $roles = array();
    foreach(events_rsvp_roles() as $role)
    {
        if(isset($role_days[$role]))
        {
            $roles[] = $role;
        }
    }

    $html = '<p><strong>Attending as:</strong> <span id="' . $id_prefix . '_roles">'
          . htmlspecialchars_uni(implode(', ', array_map('events_role_label', $roles))) . '</span></p>';

    if(empty($event_days))
    {
        return $html;
    }

    foreach($roles as $role)
    {
        $labels = events_day_labels($event_days, $role_days[$role]);
        $html .= '<p class="signup_summary_days"><strong>' . events_role_verb($role) . ':</strong> '
               . '<span id="' . $id_prefix . '_days_' . $role . '">' . htmlspecialchars_uni(implode(', ', $labels)) . '</span></p>';
    }

    return $html;
}

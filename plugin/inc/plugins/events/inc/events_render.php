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
 * The <img> for the print ribbon, or nothing when the board has no logo to use.
 *
 * The Print Logo setting comes first so a board can put something on paper that is not
 * what it puts on screen - a mono mark, or a logo with the garrison's name in it, since
 * the ribbon has no room for a wordmark. It falls back to $theme['logo'], which is where
 * MyBB keeps a theme's own logo, so a theme that fills that in needs no configuration at
 * all. A theme that hardcodes its logo into the header template (as the garrison's does)
 * leaves it empty, which is what the setting is for.
 *
 * @return string
 */
function events_print_logo()
{
    global $mybb, $theme;

    $logo = trim(events_get_setting('print_logo'));
    if($logo === '' && !empty($theme['logo']))
    {
        $logo = trim($theme['logo']);
    }

    if($logo === '')
    {
        return '';
    }

    // Theme logos are conventionally stored relative to the board root.
    if(!preg_match('#^(?:https?:)?//#', $logo))
    {
        $logo = $mybb->settings['bburl'] . '/' . ltrim($logo, '/');
    }

    // Anything that could close the url() and start a new declaration. The value is
    // admin-set rather than member-set, but it is interpolated into CSS and an
    // htmlspecialchars() does nothing about that.
    $logo = str_replace(array('"', "'", '(', ')', '\\', ';', '{', '}'), '', $logo);
    if(trim($logo) === '')
    {
        return '';
    }

    // An empty element carrying the URL as a custom property, not an <img>.
    //
    // The ribbon is display:none on screen, but a browser fetches an <img> in a hidden
    // element anyway - loading="lazy" included - so every visit to every page of the
    // plugin would pay for a garrison logo that only a printout ever shows. A background
    // image declared inside @media print is only fetched when the print styles apply,
    // which is exactly the behaviour wanted. The mark is decorative: the board's name is
    // spelled out beside it, so nothing is lost by it being absent.
    return '<span class="events_print_logo" style="--events-print-logo:url(&quot;'
         . htmlspecialchars_uni(trim($logo)) . '&quot;)" aria-hidden="true"></span>';
}

/**
 * The masthead the plugin's pages carry into print.
 *
 * Printing a plugin page strips the board's own header, navigation and footer (see the
 * @media print block in events.css), so the sheet would otherwise come off the printer
 * with nothing on it saying which board or which event it belongs to. This block is
 * hidden on screen and shown in print, and lives inside .events_page_wrap because that
 * wrapper is the only thing print keeps.
 *
 * @param string $title The subject of the sheet, e.g. the event's name
 * @param array $meta Plain-text facts to run along one line under the title
 * @param string $kind What kind of document this is, appended to the board line
 * @return string
 */
function events_print_header($title, array $meta = array(), $kind = '')
{
    global $mybb;

    $board = $mybb->settings['bbname'];
    if($kind !== '')
    {
        $board .= ' - ' . $kind;
    }

    $html = '<div class="events_print_header">'
          . '<div class="events_print_ribbon">' . events_print_logo()
          . '<span class="events_print_board">' . htmlspecialchars_uni($board) . '</span></div>'
          . '<span class="events_print_title">' . htmlspecialchars_uni($title) . '</span>';

    $meta = array_filter($meta, 'strlen');
    if(!empty($meta))
    {
        // Escaped a value at a time so the separator stays markup rather than becoming
        // a literal "&middot;" in the middle of the line.
        $html .= '<span class="events_print_meta">'
               . implode(' &middot; ', array_map('htmlspecialchars_uni', $meta)) . '</span>';
    }

    return $html . '</div>';
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
 * The next step that applies after $step.
 *
 * Walking the canonical order rather than the applicable list is what lets a step drop
 * out from under the caller: saving the prerequisites is the act that removes the
 * prerequisites step from the sequence, so "the step after prerequisites" has to stay
 * answerable once prerequisites is no longer in it.
 *
 * @param string $step
 * @param array $roles
 * @param array $missing
 * @return string
 */
function events_signup_next_step($step, array $roles, array $missing)
{
    $order = array('attendance', 'prerequisites', 'costumes', 'confirm');
    $applicable = events_signup_steps($roles, $missing);

    $index = array_search($step, $order, true);
    if($index === false)
    {
        return 'confirm';
    }

    for($next = $index + 1; $next < count($order); $next++)
    {
        if(in_array($order[$next], $applicable, true))
        {
            return $order[$next];
        }
    }

    return 'confirm';
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
 * Three styles: 'full' spells the day out with its times, 'short' is the date alone for
 * dense tables, and 'weekday' is the day's name - which is how people talk about the days
 * of a weekend event, and what the attendance sheet reads best in.
 *
 * @param array $event_days
 * @param array $day_ids
 * @param string $style full|short|weekday
 * @return array
 */
function events_day_labels(array $event_days, array $day_ids, $style = 'full')
{
    $day_ids = array_map('intval', $day_ids);

    // A date can carry more than one session - a morning and an afternoon - and neither
    // the short nor the weekday label mentions the time, so two of them would read as the
    // same day twice. Count the dates first and qualify the ones that repeat.
    $per_date = array();
    foreach($event_days as $day)
    {
        $per_date[$day['date']] = isset($per_date[$day['date']]) ? $per_date[$day['date']] + 1 : 1;
    }

    $labels = array();
    foreach($event_days as $day)
    {
        if(!in_array((int)$day['id'], $day_ids, true))
        {
            continue;
        }

        if($style === 'full')
        {
            $labels[] = events_day_label($day);
            continue;
        }

        $label = ($style === 'weekday')
            ? my_date('l', strtotime($day['date']), 0, 0)
            : events_day_short_label($day);

        if($per_date[$day['date']] > 1 && !empty($day['start_time']))
        {
            $label .= ' ' . my_date('H:i', strtotime($day['date'] . ' ' . $day['start_time']), 0, 0);
        }

        $labels[] = $label;
    }

    return $labels;
}

/**
 * What the attendance sheet says about when somebody is turning up.
 *
 * Reads the way a coordinator would say it out loud: the whole event is "All Days", part
 * of it names the days, and a signup that troops one day and wrangles another names the
 * role against each so the sheet says which hat they are wearing when.
 *
 * @param array $event_days Every day the event has
 * @param array $role_days role => array of event_day_id the person holds in that role
 * @return array display strings, one per line
 */
function events_attendance_day_items(array $event_days, array $role_days)
{
    $attending = array();
    foreach($role_days as $role => $day_ids)
    {
        foreach($day_ids as $day_id)
        {
            $attending[(int)$day_id] = $role;
        }
    }

    if(empty($attending))
    {
        return array();
    }

    $mixed = count($role_days) > 1;

    // Only worth collapsing when there is more than one day to collapse, and when the
    // whole event is being attended the same way round.
    if(!$mixed && count($event_days) > 1 && count($attending) === count($event_days))
    {
        return array('All Days');
    }

    $items = array();
    foreach($event_days as $day)
    {
        $day_id = (int)$day['id'];
        if(!isset($attending[$day_id]))
        {
            continue;
        }

        $label = events_day_labels($event_days, array($day_id), 'weekday');
        $label = isset($label[0]) ? $label[0] : '';

        if($mixed)
        {
            $label .= ' (' . events_role_verb($attending[$day_id]) . ')';
        }

        $items[] = $label;
    }

    return $items;
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

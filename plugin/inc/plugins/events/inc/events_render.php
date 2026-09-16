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

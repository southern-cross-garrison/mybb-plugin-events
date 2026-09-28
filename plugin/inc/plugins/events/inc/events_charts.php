<?php
/**
 * MyBB Event Plugin - Charts for the attendance reports.
 *
 * Drawn as HTML and CSS rather than SVG or a script: the same charts appear in the Admin
 * CP and the User CP, they read with the script off, and their text stays at text size
 * on a phone where a scaled SVG's would shrink with it. Each mark carries a title, which
 * is the hover tooltip, and every chart sits above a table that holds the same numbers.
 *
 * Styled by jscripts/events/events-charts.css, which both roots link (events_chart_assets()).
 * A mark's size is the one thing the markup says about how it looks, and it says it the
 * way the print ribbon passes its logo: as a value, in --events-chart-at, which the sheet
 * turns into a height, a width or a position.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

/**
 * The <link> that styles the charts.
 *
 * @param string $base 'jscripts/events/' on the front end, '../jscripts/events/' in the ACP
 * @return string
 */
function events_chart_assets($base)
{
    return '<link rel="stylesheet" href="' . $base . 'events-charts.css" />';
}

/**
 * A round top for an axis, and the step between its ticks: 1, 2 or 5 times a power of
 * ten, so the ticks read as 0 / 5 / 10 / 15 rather than 0 / 4.25 / 8.5.
 *
 * @param int $max
 * @return array array(top, step)
 */
function events_chart_scale($max)
{
    $max = max(1, (int)$max);
    $rough = $max / 4;
    $magnitude = pow(10, floor(log10($rough)));

    $step = $magnitude;
    foreach(array(1, 2, 5, 10) as $multiple)
    {
        if($magnitude * $multiple >= $rough)
        {
            $step = $magnitude * $multiple;
            break;
        }
    }
    $step = max(1, (int)$step);

    return array((int)(ceil($max / $step) * $step), $step);
}

/**
 * A row of headline numbers.
 *
 * @param array $tiles id => array(label, value, note) - the note, optional, is the small
 *                     line under the value ("of the garrison")
 * @return string HTML
 */
function events_chart_tiles(array $tiles)
{
    $html = '<div class="events_stat_tiles">';
    foreach($tiles as $id => $tile)
    {
        $value = is_int($tile[1]) || is_float($tile[1]) ? my_number_format($tile[1]) : htmlspecialchars_uni($tile[1]);
        $html .= '<div class="events_stat_tile" id="events_stat_' . htmlspecialchars_uni($id) . '">'
            . '<span class="events_stat_label">' . htmlspecialchars_uni($tile[0]) . '</span>'
            . '<span class="events_stat_value">' . $value . '</span>'
            . (isset($tile[2]) && $tile[2] !== '' ? '<span class="events_stat_note">' . htmlspecialchars_uni($tile[2]) . '</span>' : '')
            . '</div>';
    }
    $html .= '</div>';

    return $html;
}

/**
 * Troops per month, as columns stacked trooper under wrangler.
 *
 * @param array $series 'Y-m' => array('trooper' => int, 'wrangler' => int), oldest first
 * @param string $title
 * @param string $id
 * @return string HTML, empty when there is nothing to chart
 */
function events_chart_months(array $series, $title, $id)
{
    if(empty($series))
    {
        return '';
    }

    $max = 0;
    $total = 0;
    foreach($series as $counts)
    {
        $max = max($max, $counts['trooper'] + $counts['wrangler']);
        $total += $counts['trooper'] + $counts['wrangler'];
    }

    if($total === 0)
    {
        return '';
    }

    list($top, $step) = events_chart_scale($max);

    $grid = '';
    for($tick = 0; $tick <= $top; $tick += $step)
    {
        $grid .= '<span class="events_chart_gridline" style="--events-chart-at: ' . round($tick / $top * 100, 3) . '%"><span class="events_chart_tick">' . my_number_format($tick) . '</span></span>';
    }

    // At most a dozen month labels however long the range, the first of the range and
    // each January carrying its year.
    $every = max(1, (int)ceil(count($series) / 12));

    $columns = '';
    $index = 0;
    $first_year = null;
    foreach($series as $month => $counts)
    {
        $date = DateTime::createFromFormat('!Y-m', $month);
        $name = $date->format('M Y');

        $tip = $name . ': ' . events_chart_count($counts['trooper'], 'trooper') . ', ' . events_chart_count($counts['wrangler'], 'wrangler');

        $segments = '';
        foreach(array('trooper', 'wrangler') as $role)
        {
            if($counts[$role] > 0)
            {
                $segments .= '<span class="events_chart_segment events_chart_' . $role . '" style="--events-chart-at: ' . round($counts[$role] / $top * 100, 3) . '%"></span>';
            }
        }

        $label = '';
        if($index % $every === 0)
        {
            $label = $date->format('M');
            if($first_year === null || $date->format('n') === '1')
            {
                $label .= '<br />' . $date->format('Y');
                $first_year = true;
            }
        }

        $columns .= '<div class="events_chart_column" title="' . htmlspecialchars_uni($tip) . '" data-month="' . $month . '">'
            . '<div class="events_chart_stack">' . $segments . '</div>'
            . '<span class="events_chart_label">' . $label . '</span>'
            . '</div>';
        $index++;
    }

    $legend = '<div class="events_chart_legend">'
        . '<span class="events_chart_key"><span class="events_chart_swatch events_chart_trooper"></span>Troopers</span>'
        . '<span class="events_chart_key"><span class="events_chart_swatch events_chart_wrangler"></span>Wranglers</span>'
        . '</div>';

    return '<figure class="events_chart events_chart_months" id="' . htmlspecialchars_uni($id) . '">'
        . '<figcaption class="events_chart_title">' . htmlspecialchars_uni($title) . '</figcaption>'
        . $legend
        . '<div class="events_chart_plot" role="img" aria-label="' . htmlspecialchars_uni($title . ': ' . my_number_format($total) . ' in all, busiest month ' . my_number_format($max)) . '">'
        . '<div class="events_chart_grid">' . $grid . '</div>'
        . '<div class="events_chart_columns">' . $columns . '</div>'
        . '</div>'
        . '</figure>';
}

/**
 * The top of a ranking, as horizontal bars with the value at each tip.
 *
 * @param array $rows array(label, value, href) - label unescaped, href already a URL or ''
 * @param string $title
 * @param string $id
 * @return string HTML, empty when there is nothing to chart
 */
function events_chart_bars(array $rows, $title, $id)
{
    if(empty($rows))
    {
        return '';
    }

    $max = 0;
    foreach($rows as $row)
    {
        $max = max($max, (int)$row[1]);
    }
    $max = max(1, $max);

    $bars = '';
    foreach($rows as $row)
    {
        $label = htmlspecialchars_uni($row[0]);
        if(!empty($row[2]))
        {
            $label = '<a href="' . $row[2] . '">' . $label . '</a>';
        }

        $bars .= '<li class="events_chart_bar_row" title="' . htmlspecialchars_uni($row[0] . ': ' . my_number_format((int)$row[1])) . '">'
            . '<span class="events_chart_bar_label">' . $label . '</span>'
            . '<span class="events_chart_bar_track">'
            . '<span class="events_chart_bar" style="--events-chart-at: ' . round((int)$row[1] / $max * 100, 3) . '%"></span>'
            . '<span class="events_chart_bar_value">' . my_number_format((int)$row[1]) . '</span>'
            . '</span>'
            . '</li>';
    }

    return '<figure class="events_chart events_chart_bars" id="' . htmlspecialchars_uni($id) . '">'
        . '<figcaption class="events_chart_title">' . htmlspecialchars_uni($title) . '</figcaption>'
        . '<ol class="events_chart_bar_list">' . $bars . '</ol>'
        . '</figure>';
}

/**
 * "3 troopers", "1 wrangler".
 *
 * @param int $count
 * @param string $role
 * @return string
 */
function events_chart_count($count, $role)
{
    return my_number_format($count) . ' ' . $role . ($count === 1 ? '' : 's');
}

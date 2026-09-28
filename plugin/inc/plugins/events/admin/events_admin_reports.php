<?php
/**
 * MyBB Event Plugin - Attendance reports in the Admin CP
 *
 * Who troops the most and the least, which events draw the biggest turnout, how the
 * regions compare and which costumes come out - all counted from posted troop reports
 * (events_attendance.php).
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_form.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_attendance.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_charts.php";
require_once MYBB_ROOT . "inc/plugins/events/admin/events_admin_nudge.php";

/**
 * @return array view => label
 */
function events_admin_report_views()
{
    return array(
        'people'   => 'People',
        'events'   => 'Events',
        'regions'  => 'Regions',
        'costumes' => 'Costumes',
    );
}

function events_admin_reports()
{
    global $mybb;

    if(!events_is_gec())
    {
        flash_message("You do not have permission to access this page.", "error");
        admin_redirect("index.php");
    }

    $views = events_admin_report_views();
    $view = $mybb->get_input('view');
    if(!isset($views[$view]))
    {
        $view = 'people';
    }

    $ascending = $mybb->get_input('order') === 'least';
    $filters = events_attendance_filters(array(
        'from'   => $mybb->get_input('from'),
        'to'     => $mybb->get_input('to'),
        'region' => $mybb->get_input('region'),
        'role'   => $mybb->get_input('role'),
    ));

    $per_page = 20;
    $page_num = max(1, $mybb->get_input('page', MyBB::INPUT_INT));
    $start = ($page_num - 1) * $per_page;

    // A nudge comes back to the report it was sent from, filtered and paged as it was.
    if(events_admin_nudge_action(events_admin_report_url($view, $ascending, $filters, $page_num)))
    {
        return;
    }

    // The filter form
    // MyBB's select box writes each key into value="" as it is and compares the selection
    // with it the same way, so the key is escaped here and so is what is selected - as the
    // event form does. The browser decodes the value, so the region is submitted as typed.
    $regions = array('' => 'All regions');
    foreach(events_regions() as $region)
    {
        $regions[htmlspecialchars_uni($region)] = htmlspecialchars_uni($region);
    }

    // Folded away until asked for, with what it is set to on the bar: the report is what the
    // page is for, and the form is visited once to set it up. A <details> rather than a
    // script, so it opens with the script off, and never open on load - a report changed
    // from it comes back folded, saying what it now shows.
    echo '<details class="events_report_filters" id="events_report_filters">'
        . '<summary><span class="events_report_filters_label">Filters</span>'
        . '<span class="events_report_filters_summary" id="events_report_filter_summary">'
        . htmlspecialchars_uni(events_admin_report_filter_summary($views[$view], $ascending, $filters))
        . '</span></summary>';

    $form = new Form("index.php?module=events&amp;action=reports", "get");
    echo $form->generate_hidden_field("module", "events");
    echo $form->generate_hidden_field("action", "reports");

    // Untitled: the bar above is its title.
    $container = new FormContainer("");
    $container->output_row("Report", "", $form->generate_select_box("view", $views, $view, array("id" => "report_view")), "report_view");
    $container->output_row("Order", "", $form->generate_select_box("order", array('most' => 'Most first', 'least' => 'Least first'), $ascending ? 'least' : 'most', array("id" => "report_order")), "report_order");
    $container->output_row("From", "Events starting on or after", $form->generate_text_box("from", $filters['from'], array("id" => "report_from", "class" => "events_datepicker")), "report_from");
    $container->output_row("To", "Events starting on or before", $form->generate_text_box("to", $filters['to'], array("id" => "report_to", "class" => "events_datepicker")), "report_to");
    $container->output_row("Region", "", $form->generate_select_box("region", $regions, htmlspecialchars_uni($filters['region']), array("id" => "report_region")), "report_region");
    $container->output_row("Role", "", $form->generate_select_box("role", array('' => 'Any role', 'trooper' => 'Trooper', 'wrangler' => 'Wrangler'), $filters['role'], array("id" => "report_role")), "report_role");
    $container->end();

    $form->output_submit_wrapper(array($form->generate_submit_button("Show Report")));
    $form->end();
    echo '</details>';

    echo events_datepicker_assets('../jscripts/events/');
    echo events_datepicker_script();

    // The headline cards and the month-by-month chart are the view's own: the People
    // view counts members, the Costumes view counts costumes. All of it covers the whole
    // filter, not the page of the table below.
    $summary = events_attendance_summary($filters);

    echo '<div id="events_reports">';
    echo events_chart_tiles(events_attendance_headline($view, $filters, $summary));

    if($summary['troops'] === 0)
    {
        $table = new Table;
        $table->construct_cell("No troops have been counted for this selection. Troops are counted from posted troop reports.", array("id" => "events_reports_empty"));
        $table->construct_row();
        $table->output($views[$view]);
        echo '</div>';
        return;
    }

    $by_month = events_attendance_by_month($view, $filters);
    echo events_chart_months($by_month['series'], $by_month['keys'], $by_month['title'], 'events_chart_by_month');

    $total = events_attendance_count($view, $filters);
    $rows = events_attendance_report($view, $filters, $ascending, $start, $per_page);

    $chart_rows = events_attendance_report($view, $filters, $ascending, 0, 10);
    echo events_admin_report_chart($view, $chart_rows, $ascending);

    $function = 'events_admin_report_table_' . $view;
    $function($rows, htmlspecialchars_uni(events_admin_report_url($view, $ascending, $filters, $page_num)));

    echo draw_admin_pagination($page_num, $per_page, $total, htmlspecialchars_uni(events_admin_report_url($view, $ascending, $filters)) . "&amp;page=");
    echo '</div>';
}

/**
 * The report as it is filtered, for paging it and for coming back to it.
 *
 * @param string $view
 * @param bool $ascending
 * @param array $filters from events_attendance_filters()
 * @param int $page_num 1 leaves the page off
 * @return string Unescaped
 */
function events_admin_report_url($view, $ascending, array $filters, $page_num = 1)
{
    $query = array('view' => $view, 'order' => $ascending ? 'least' : 'most') + array_filter($filters, 'strlen');
    if($page_num > 1)
    {
        $query['page'] = (int)$page_num;
    }

    $url = "index.php?module=events&action=reports";
    foreach($query as $key => $value)
    {
        $url .= "&" . $key . "=" . urlencode($value);
    }

    return $url;
}

/**
 * What the filters are set to, in a line: "People, most first · All dates · All regions ·
 * Any role".
 *
 * @param string $view_label
 * @param bool $ascending
 * @param array $filters from events_attendance_filters()
 * @return string Unescaped
 */
function events_admin_report_filter_summary($view_label, $ascending, array $filters)
{
    global $mybb;

    $date = function($value) use ($mybb)
    {
        return events_date($mybb->settings['dateformat'], events_strtotime($value . ' 00:00:00'));
    };

    if($filters['from'] !== '' && $filters['to'] !== '')
    {
        $dates = $date($filters['from']) . ' to ' . $date($filters['to']);
    }
    elseif($filters['from'] !== '')
    {
        $dates = 'From ' . $date($filters['from']);
    }
    elseif($filters['to'] !== '')
    {
        $dates = 'Up to ' . $date($filters['to']);
    }
    else
    {
        $dates = 'All dates';
    }

    return implode(' · ', array(
        $view_label . ', ' . ($ascending ? 'least first' : 'most first'),
        $dates,
        $filters['region'] !== '' ? $filters['region'] : 'All regions',
        $filters['role'] !== '' ? events_role_label($filters['role']) . 's' : 'Any role',
    ));
}

/**
 * The ranking chart above a view's table: its first ten rows, in its order.
 *
 * @param string $view
 * @param array $rows
 * @param bool $ascending
 * @return string
 */
function events_admin_report_chart($view, array $rows, $ascending)
{
    global $mybb;

    $bars = array();
    foreach($rows as $row)
    {
        switch($view)
        {
            case 'events':
                $bars[] = array($row['title'], (int)$row['attended'], $mybb->settings['bburl'] . "/event.php?id=" . (int)$row['id']);
                break;
            case 'regions':
                $bars[] = array($row['region'], (int)$row['troops'], '', events_attendance_series_class('regions', $row['region']));
                break;
            case 'costumes':
                $bars[] = array($row['costume'], (int)$row['worn'], '', events_attendance_series_class('costumes', $row['costume']));
                break;
            default:
                $bars[] = array(events_admin_report_member_name($row), (int)$row['troops'], '');
        }
    }

    $titles = array(
        'people'   => array('Most active members', 'Least active members'),
        'events'   => array('Best attended events', 'Least attended events'),
        'regions'  => array('Troops by region', 'Troops by region'),
        'costumes' => array('Most worn costumes', 'Least worn costumes'),
    );

    return events_chart_bars($bars, $titles[$view][$ascending ? 1 : 0], 'events_chart_ranking');
}

/**
 * A member's name as the reports show it: their username, or "[deleted user]" once the
 * account is gone and only the troops are left.
 *
 * @param array $row user_id, username
 * @return string Unescaped
 */
function events_admin_report_member_name(array $row)
{
    return isset($row['username']) && $row['username'] !== null && $row['username'] !== '' ? $row['username'] : '[deleted user]';
}

/**
 * @param array $rows
 * @param string $report_url The report as it is filtered, escaped for HTML
 */
function events_admin_report_table_people(array $rows, $report_url)
{
    global $mybb;

    $nudges = events_admin_nudge_links($rows, $report_url);

    $table = new Table;
    $table->construct_header("Member", array("width" => "20%"));
    $table->construct_header("Troops", array("width" => "9%", "class" => "align_center"));
    $table->construct_header("As Trooper", array("width" => "9%", "class" => "align_center"));
    $table->construct_header("As Wrangler", array("width" => "9%", "class" => "align_center"));
    $table->construct_header("Most Worn", array("width" => "20%"));
    $table->construct_header("Last Troop", array("width" => "25%"));
    $table->construct_header("", array("width" => "8%", "class" => "align_center"));

    foreach($rows as $row)
    {
        $name = htmlspecialchars_uni(events_admin_report_member_name($row));
        if($row['username'] !== null && $row['username'] !== '')
        {
            $name = "<a href=\"index.php?module=user-users&amp;action=edit&amp;uid=" . (int)$row['user_id'] . "\">" . $name . "</a>";
        }

        $last = '';
        if(!empty($row['last_event']))
        {
            $last = "<a href=\"" . $mybb->settings['bburl'] . "/event.php?id=" . (int)$row['last_event']['id'] . "\">" . htmlspecialchars_uni($row['last_event']['title']) . "</a>"
                . " <span class=\"smalltext\">" . events_format_date($row['last_event']['start_date'], $mybb->settings['dateformat']) . "</span>";
        }

        $table->construct_cell($name, array("class" => "events_report_member"));
        $table->construct_cell((int)$row['troops'], array("class" => "align_center events_report_count"));
        $table->construct_cell((int)$row['as_trooper'], array("class" => "align_center"));
        $table->construct_cell((int)$row['as_wrangler'], array("class" => "align_center"));
        $table->construct_cell(htmlspecialchars_uni($row['top_costume']));
        $table->construct_cell($last);
        $table->construct_cell(isset($nudges[(int)$row['user_id']]) ? $nudges[(int)$row['user_id']] : '', array("class" => "align_center"));
        $table->construct_row(array("class" => "events_report_row"));
    }

    $table->output("People");

    if($nudges)
    {
        events_admin_output_nudge_modal($report_url);
    }
}

/**
 * @param array $rows
 */
function events_admin_report_table_events(array $rows)
{
    global $mybb;

    $table = new Table;
    $table->construct_header("Event", array("width" => "34%"));
    $table->construct_header("Date", array("width" => "16%"));
    $table->construct_header("Region", array("width" => "14%"));
    $table->construct_header("Attended", array("width" => "12%", "class" => "align_center"));
    $table->construct_header("Signed Up", array("width" => "12%", "class" => "align_center"));
    $table->construct_header("Turnout", array("width" => "12%", "class" => "align_center"));

    foreach($rows as $row)
    {
        $signups = (int)$row['signups'];
        $turnout = $signups > 0 ? round((int)$row['attended'] / $signups * 100) . '%' : '-';

        $table->construct_cell("<a href=\"" . $mybb->settings['bburl'] . "/event.php?id=" . (int)$row['id'] . "\">" . htmlspecialchars_uni($row['title']) . "</a>", array("class" => "events_report_member"));
        $table->construct_cell(events_format_date($row['start_date'], $mybb->settings['dateformat']));
        $table->construct_cell(htmlspecialchars_uni($row['region']));
        $table->construct_cell((int)$row['attended'], array("class" => "align_center events_report_count"));
        $table->construct_cell($signups, array("class" => "align_center"));
        $table->construct_cell($turnout, array("class" => "align_center"));
        $table->construct_row(array("class" => "events_report_row"));
    }

    $table->output("Events");
}

/**
 * @param array $rows
 */
function events_admin_report_table_regions(array $rows)
{
    $table = new Table;
    $table->construct_header("Region", array("width" => "32%"));
    $table->construct_header("Troops", array("width" => "17%", "class" => "align_center"));
    $table->construct_header("Events", array("width" => "17%", "class" => "align_center"));
    $table->construct_header("Average per Event", array("width" => "17%", "class" => "align_center"));
    $table->construct_header("Members", array("width" => "17%", "class" => "align_center"));

    foreach($rows as $row)
    {
        $events = (int)$row['events'];

        $table->construct_cell(htmlspecialchars_uni($row['region']), array("class" => "events_report_member"));
        $table->construct_cell((int)$row['troops'], array("class" => "align_center events_report_count"));
        $table->construct_cell($events, array("class" => "align_center"));
        $table->construct_cell($events > 0 ? my_number_format(round((int)$row['troops'] / $events, 1)) : '-', array("class" => "align_center"));
        $table->construct_cell((int)$row['members'], array("class" => "align_center"));
        $table->construct_row(array("class" => "events_report_row"));
    }

    $table->output("Regions");
}

/**
 * @param array $rows
 */
function events_admin_report_table_costumes(array $rows)
{
    global $mybb;

    $table = new Table;
    $table->construct_header("Costume", array("width" => "40%"));
    $table->construct_header("Times Worn", array("width" => "20%", "class" => "align_center"));
    $table->construct_header("Members", array("width" => "20%", "class" => "align_center"));
    $table->construct_header("Last Worn", array("width" => "20%"));

    foreach($rows as $row)
    {
        $table->construct_cell(htmlspecialchars_uni($row['costume']), array("class" => "events_report_member"));
        $table->construct_cell((int)$row['worn'], array("class" => "align_center events_report_count"));
        $table->construct_cell((int)$row['members'], array("class" => "align_center"));
        $table->construct_cell(events_format_date($row['last_date'], $mybb->settings['dateformat']));
        $table->construct_row(array("class" => "events_report_row"));
    }

    $table->output("Costumes");
}

<?php
/**
 * MyBB Event Plugin - Troop attendance: who a troop report says turned out, and the
 * statistics built from that.
 *
 * A member signed up to an event who is named in its posted troop report is counted as
 * having done the role they signed up for, once per event whatever days they held. The
 * rows are rewritten from the report when it is posted and whenever its first post is
 * edited (events_troop_report_edited()), so the report is the only thing to correct.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";

/**
 * Does the report name this signup?
 *
 * The username has to appear as a word of its own, in its own case: the draft writes it
 * exactly as stored, and a username that happens to be an ordinary word ("Rex") would
 * otherwise be found in the mission write-up. A trooper who has a Legion ID recorded has
 * to be named by its number as well, with or without the prefix ("TK-12345", "TK12345",
 * "12345") - a number alone could be a postcode or a head count, and a name alone could
 * be a mention of somebody who did not come. A wrangler holds no ID, so the name is it.
 *
 * @param string $text The report as plain text (events_attendance_text())
 * @param array $attendee username, role, legion_id
 * @return bool
 */
function events_attendance_matches($text, array $attendee)
{
    $text = (string)$text;
    $username = (string)$attendee['username'];

    if($username === '' || !preg_match('/(?<![\p{L}\p{N}_])' . preg_quote($username, '/') . '(?![\p{L}\p{N}_])/u', $text))
    {
        return false;
    }

    if($attendee['role'] !== 'trooper')
    {
        return true;
    }

    $number = ltrim(preg_replace('/\D/', '', (string)$attendee['legion_id']), '0');
    if($number === '')
    {
        return true;
    }

    return (bool)preg_match('/(?<!\d)0*' . $number . '(?!\d)/', $text);
}

/**
 * A report's post as the text a reader sees: BBCode rendered and stripped, and entities
 * decoded, so a name inside [b] or written with events_escape_bbcode()'s &#91; still
 * reads as the name.
 *
 * @param string $message BBCode
 * @return string
 */
function events_attendance_text($message)
{
    return html_entity_decode(events_description_text($message), ENT_QUOTES, 'UTF-8');
}

/**
 * Take the report's lock and rewrite the event's attendance from it.
 *
 * @param int $event_id
 * @return int Members counted, -1 if the lock could not be had
 */
function events_record_troop_attendance($event_id)
{
    $lock = events_troop_report_lock($event_id);
    if(!events_acquire_lock($lock))
    {
        return -1;
    }

    $counted = events_write_troop_attendance($event_id);

    events_release_lock($lock);

    return $counted;
}

/**
 * Rewrite an event's attendance from its posted troop report. The caller holds the
 * report's lock (events_record_troop_attendance(), events_post_troop_report()).
 *
 * The rows of members who have since been deleted are kept rather than rewritten: their
 * signups went with them, so there is nothing left to recount them from, and the troop
 * still happened. Everybody else's rows are replaced with what the report says now.
 *
 * @param int $event_id
 * @return int Members counted
 */
function events_write_troop_attendance($event_id)
{
    global $db;

    $event_id = (int)$event_id;

    // Files deployed ahead of the activation that runs the upgrade creating the table.
    if(!$db->table_exists("event_plugin_attendance"))
    {
        return 0;
    }

    // Trooping credit is a troop's alone. A social event cannot have a report posted, so
    // this only matters for one whose report was somehow left behind.
    if(events_is_social(events_get_event($event_id)))
    {
        return 0;
    }

    $report = events_get_troop_report($event_id);
    if(!$report || empty($report['posted_at']) || empty($report['thread_id']))
    {
        return 0;
    }

    $post = $db->fetch_array($db->query("
        SELECT p.message
        FROM " . TABLE_PREFIX . "threads t
        INNER JOIN " . TABLE_PREFIX . "posts p ON p.pid = t.firstpost
        WHERE t.tid = " . (int)$report['thread_id'] . "
    "));
    if(!$post)
    {
        return 0;
    }

    $text = events_attendance_text($post['message']);

    // Waitlisted signups are candidates too: somebody who came off the waitlist on the
    // day is named in the report without the signup sheet ever having caught up. A
    // signup attending one day and waiting on another comes back from both lists.
    $signups = array();
    foreach(array('attending', 'waitlisted') as $status)
    {
        foreach(events_get_attendees($event_id, array('status' => $status)) as $attendee)
        {
            if(!isset($signups[$attendee['rsvp_id']]))
            {
                $signups[$attendee['rsvp_id']] = $attendee;
            }
        }
    }

    $existing = array();
    $query = $db->query("
        SELECT a.id
        FROM " . TABLE_PREFIX . "event_plugin_attendance a
        INNER JOIN " . TABLE_PREFIX . "users u ON u.uid = a.user_id
        WHERE a.event_id = " . $event_id . "
    ");
    while($row = $db->fetch_array($query))
    {
        $existing[] = (int)$row['id'];
    }

    if($existing)
    {
        $in = implode(',', $existing);
        $db->delete_query("event_plugin_attendance_costumes", "attendance_id IN (" . $in . ")");
        $db->delete_query("event_plugin_attendance", "id IN (" . $in . ")");
    }

    $now = events_date('Y-m-d H:i:s');
    $counted = 0;

    foreach($signups as $attendee)
    {
        if(!events_attendance_matches($text, $attendee))
        {
            continue;
        }

        $attendance_id = (int)$db->insert_query("event_plugin_attendance", array(
            'event_id'    => $event_id,
            'user_id'     => (int)$attendee['uid'],
            'role'        => $db->escape_string(events_rsvp_role($attendee['role'])),
            'recorded_at' => $db->escape_string($now),
        ));

        foreach(array_unique($attendee['costumes']) as $costume)
        {
            $db->insert_query("event_plugin_attendance_costumes", array(
                'attendance_id' => $attendance_id,
                'costume'       => $db->escape_string($costume),
            ));
        }

        $counted++;
    }

    return $counted;
}

/**
 * Drop an event's attendance. Called when the event itself is deleted.
 *
 * @param int $event_id
 * @return void
 */
function events_delete_event_attendance($event_id)
{
    global $db;

    $event_id = (int)$event_id;

    $db->write_query("
        DELETE c FROM " . TABLE_PREFIX . "event_plugin_attendance_costumes c
        INNER JOIN " . TABLE_PREFIX . "event_plugin_attendance a ON a.id = c.attendance_id
        WHERE a.event_id = " . $event_id . "
    ");
    $db->delete_query("event_plugin_attendance", "event_id = " . $event_id);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Normalise the report filters from a request.
 *
 * @param array $input from (Y-m-d), to (Y-m-d), region, role
 * @return array The same keys, each '' when not filtering
 */
function events_attendance_filters(array $input)
{
    $filters = array('from' => '', 'to' => '', 'region' => '', 'role' => '');

    foreach(array('from', 'to') as $key)
    {
        $value = isset($input[$key]) ? trim((string)$input[$key]) : '';
        $date = DateTime::createFromFormat('!Y-m-d', $value);
        if($date && $date->format('Y-m-d') === $value)
        {
            $filters[$key] = $value;
        }
    }

    $region = isset($input['region']) ? (string)$input['region'] : '';
    if(in_array($region, events_regions(), true))
    {
        $filters['region'] = $region;
    }

    $role = isset($input['role']) ? (string)$input['role'] : '';
    if(in_array($role, events_rsvp_roles(), true))
    {
        $filters['role'] = $role;
    }

    return $filters;
}

/**
 * The WHERE clause the filters make, over attendance `a` joined to its event `e`.
 *
 * Dates are the event's start, compared as wall clocks: both sides are in the event
 * timezone already, which is what the columns mean.
 *
 * @param array $filters from events_attendance_filters()
 * @return string
 */
function events_attendance_where(array $filters)
{
    global $db;

    $where = array("1 = 1");

    if(!empty($filters['from']))
    {
        $where[] = "e.start_date >= '" . $db->escape_string($filters['from']) . " 00:00:00'";
    }
    if(!empty($filters['to']))
    {
        $where[] = "e.start_date <= '" . $db->escape_string($filters['to']) . " 23:59:59'";
    }
    if(!empty($filters['region']))
    {
        $where[] = "e.region = '" . $db->escape_string($filters['region']) . "'";
    }
    if(!empty($filters['role']))
    {
        $where[] = "a.role = '" . $db->escape_string($filters['role']) . "'";
    }

    return implode(" AND ", $where);
}

/**
 * @return string The FROM clause every statistic is read over
 */
function events_attendance_from()
{
    return TABLE_PREFIX . "event_plugin_attendance a
        INNER JOIN " . TABLE_PREFIX . "event_plugin_events e ON e.id = a.event_id";
}

/**
 * The totals every view's headline is drawn from.
 *
 * A troop is one member at one event, so a member who both trooped and wrangled the same
 * event is one troop, not two. A costume is counted once per signup that listed it - a
 * member who brought two to one troop wore both.
 *
 * @param array $filters
 * @return array troops, events, members, regions, costumes (distinct), worn (times),
 *               costumed (members with a costume counted)
 */
function events_attendance_summary(array $filters)
{
    global $db;

    $where = events_attendance_where($filters);

    $row = $db->fetch_array($db->query("
        SELECT COUNT(DISTINCT a.event_id, a.user_id) AS troops,
               COUNT(DISTINCT a.event_id) AS events,
               COUNT(DISTINCT a.user_id) AS members,
               COUNT(DISTINCT e.region) AS regions
        FROM " . events_attendance_from() . "
        WHERE {$where}
    "));

    $costumes = $db->fetch_array($db->query("
        SELECT COUNT(DISTINCT c.costume) AS costumes, COUNT(*) AS worn, COUNT(DISTINCT a.user_id) AS costumed
        FROM " . events_attendance_from() . "
        INNER JOIN " . TABLE_PREFIX . "event_plugin_attendance_costumes c ON c.attendance_id = a.id
        WHERE {$where}
    "));

    return array(
        'troops'   => (int)$row['troops'],
        'events'   => (int)$row['events'],
        'members'  => (int)$row['members'],
        'regions'  => (int)$row['regions'],
        'costumes' => (int)$costumes['costumes'],
        'worn'     => (int)$costumes['worn'],
        'costumed' => (int)$costumes['costumed'],
    );
}

/**
 * The headline cards for a report view: what that view counts, how much of it there is,
 * the average and the one at the top.
 *
 * "At the top" is always the most, whichever way round the view is sorted - it is the
 * headline, and the least is the first row of the table anyway.
 *
 * @param string $view people|events|regions|costumes
 * @param array $filters
 * @param array $summary from events_attendance_summary()
 * @return array id => array(label, value, note), for events_chart_tiles()
 */
function events_attendance_headline($view, array $filters, array $summary)
{
    $top = events_attendance_report($view, $filters, false, 0, 1);
    $top = $top ? $top[0] : null;

    $average = function($of, $per)
    {
        return $per > 0 ? round($of / $per, 1) : 0;
    };

    switch($view)
    {
        case 'events':
            return array(
                'events'  => array('Events reported', $summary['events']),
                'troops'  => array('Troops', $summary['troops']),
                'average' => array('Average turnout', $average($summary['troops'], $summary['events']), 'per event'),
                'top'     => array('Best attended', $top ? $top['title'] : '-', $top ? events_attendance_noun((int)$top['attended'], 'attended', 'attended') : ''),
            );

        case 'regions':
            return array(
                'regions' => array('Regions', $summary['regions']),
                'events'  => array('Events reported', $summary['events']),
                'troops'  => array('Troops', $summary['troops']),
                'top'     => array('Busiest region', $top ? $top['region'] : '-', $top ? events_attendance_noun((int)$top['troops'], 'troop', 'troops') : ''),
            );

        case 'costumes':
            return array(
                'costumes' => array('Costumes worn', $summary['costumes']),
                'worn'     => array('Times worn', $summary['worn']),
                'members'  => array('Members in costume', $summary['costumed']),
                'top'      => array('Most worn', $top ? $top['costume'] : '-', $top ? events_attendance_noun((int)$top['worn'], 'time', 'times') : ''),
            );

        default:
            return array(
                'members' => array('Members trooping', $summary['members']),
                'troops'  => array('Troops', $summary['troops']),
                'average' => array('Average', $average($summary['troops'], $summary['members']), 'troops per member'),
                'top'     => array('Most active', $top ? (($top['username'] !== null && $top['username'] !== '') ? $top['username'] : '[deleted user]') : '-',
                                   $top ? events_attendance_noun((int)$top['troops'], 'troop', 'troops') : ''),
            );
    }
}

/**
 * "1 troop", "4 troops".
 *
 * @param int $count
 * @param string $one
 * @param string $many
 * @return string
 */
function events_attendance_noun($count, $one, $many)
{
    return my_number_format($count) . ' ' . ($count === 1 ? $one : $many);
}

/**
 * How many named series a stacked month chart carries before the rest fold into "Other".
 * Five is as many as the chart palette separates on a stack.
 */
define('EVENTS_ATTENDANCE_CHART_SERIES', 5);

/**
 * A report view's month-by-month chart: what it stacks, and the counts.
 *
 * - people:   members trooping each month, one series
 * - events:   troops each month, troopers under wranglers
 * - regions:  troops each month, one series per region
 * - costumes: costumes worn each month, one series per costume
 *
 * Every month in the range is returned, empty ones included, so the chart has no gaps
 * to misread. The range is the filter's where it has one and the data's where it does
 * not, cut to the latest $max_months so a long history stays legible.
 *
 * A series keeps its colour whatever the filter: regions are coloured in the order the
 * region list has them, and costumes by how often each has been worn across everything
 * counted - not by where they rank in the selection, which would repaint a costume when
 * a filter took the one above it out. Past the first few, the rest share one series.
 *
 * @param string $view
 * @param array $filters
 * @param int $max_months
 * @return array title, keys (key => array(label, class)), series ('Y-m' => key => int)
 */
function events_attendance_by_month($view, array $filters, $max_months = 24)
{
    global $db;

    $month = "DATE_FORMAT(e.start_date, '%Y-%m')";
    $where = events_attendance_where($filters);
    $from = events_attendance_from();

    switch($view)
    {
        case 'people':
            $title = 'Members trooping per month';
            $keys = array('members' => array('Members', 'events_chart_trooper'));
            $sql = "SELECT {$month} AS month, 'members' AS series, COUNT(DISTINCT a.user_id) AS n FROM {$from} WHERE {$where} GROUP BY {$month}";
            $classify = null;
            break;

        case 'regions':
            $title = 'Troops per month by region';
            $keys = events_attendance_series_keys(events_regions(), 'Other regions');
            $sql = "SELECT {$month} AS month, e.region AS series, COUNT(DISTINCT a.event_id, a.user_id) AS n FROM {$from} WHERE {$where} GROUP BY {$month}, e.region";
            $classify = events_attendance_series_classifier('regions');
            break;

        case 'costumes':
            $title = 'Costumes worn per month';
            $keys = events_attendance_series_keys(events_attendance_leading_costumes(EVENTS_ATTENDANCE_CHART_SERIES), 'Other costumes');
            $sql = "SELECT {$month} AS month, c.costume AS series, COUNT(*) AS n FROM {$from}
                INNER JOIN " . TABLE_PREFIX . "event_plugin_attendance_costumes c ON c.attendance_id = a.id
                WHERE {$where} GROUP BY {$month}, c.costume";
            $classify = events_attendance_series_classifier('costumes');
            break;

        default:
            $title = 'Troops per month';
            $keys = array(
                'trooper'  => array('Troopers', 'events_chart_trooper'),
                'wrangler' => array('Wranglers', 'events_chart_wrangler'),
            );
            $sql = "SELECT {$month} AS month, a.role AS series, COUNT(*) AS n FROM {$from} WHERE {$where} GROUP BY {$month}, a.role";
            $classify = null;
    }

    $counts = array();
    $totals = array();
    $query = $db->query($sql);
    while($row = $db->fetch_array($query))
    {
        $key = $classify ? $classify($row['series']) : $row['series'];
        $counts[$row['month']][$key] = (isset($counts[$row['month']][$key]) ? $counts[$row['month']][$key] : 0) + (int)$row['n'];
        $totals[$key] = (isset($totals[$key]) ? $totals[$key] : 0) + (int)$row['n'];
    }

    // A stacked series with nothing in the selection has no business in the legend. Its
    // class stays with it, so the rest keep their colours.
    if($classify)
    {
        foreach(array_keys($keys) as $key)
        {
            if(empty($totals[$key]))
            {
                unset($keys[$key]);
            }
        }
    }

    $first = !empty($filters['from']) ? substr($filters['from'], 0, 7) : ($counts ? min(array_keys($counts)) : '');
    $last = !empty($filters['to']) ? substr($filters['to'], 0, 7) : ($counts ? max(array_keys($counts)) : '');

    return array(
        'title'  => $title,
        'keys'   => $keys,
        'series' => events_attendance_month_series($counts, $first, $last, $max_months, array_keys($keys)),
    );
}

/**
 * The series of a stacked chart: the named ones in the order given, each on its own
 * palette slot, then the rest folded together.
 *
 * The fold is labelled with what it holds ("Other regions") rather than a bare "Other",
 * because the default region list has a region called Other.
 *
 * @param string[] $names
 * @param string $other_label
 * @return array key => array(label, class)
 */
function events_attendance_series_keys(array $names, $other_label)
{
    $keys = array();
    foreach(array_slice(array_values($names), 0, EVENTS_ATTENDANCE_CHART_SERIES) as $index => $name)
    {
        $keys['s' . ($index + 1)] = array($name, 'events_chart_series_' . ($index + 1));
    }
    $keys['other'] = array($other_label, 'events_chart_series_other');

    return $keys;
}

/**
 * Which series a region or a costume is drawn in: 's1' to 's5' for the named ones, 'other'
 * for the rest.
 *
 * The month chart and the ranking chart both ask this, so a costume is the same colour in
 * both. Costumes are matched without regard to case, as the costume column compares them:
 * GROUP BY may hand back a different casing than the ranking did.
 *
 * @param string $view regions|costumes
 * @return callable name => series key
 */
function events_attendance_series_classifier($view)
{
    static $classifiers = array();

    if(!isset($classifiers[$view]))
    {
        $named = $view === 'regions'
            ? array_slice(events_regions(), 0, EVENTS_ATTENDANCE_CHART_SERIES)
            : events_attendance_leading_costumes(EVENTS_ATTENDANCE_CHART_SERIES);

        $lookup = array();
        foreach(array_values($named) as $index => $name)
        {
            $lookup[$view === 'regions' ? $name : mb_strtolower($name)] = 's' . ($index + 1);
        }

        $classifiers[$view] = function($name) use ($lookup, $view)
        {
            $name = $view === 'regions' ? (string)$name : mb_strtolower((string)$name);
            return isset($lookup[$name]) ? $lookup[$name] : 'other';
        };
    }

    return $classifiers[$view];
}

/**
 * The CSS class that colours a region or a costume, as events_attendance_series_classifier()
 * files it.
 *
 * @param string $view regions|costumes
 * @param string $name
 * @return string
 */
function events_attendance_series_class($view, $name)
{
    $classify = events_attendance_series_classifier($view);
    $key = $classify($name);

    return $key === 'other' ? 'events_chart_series_other' : 'events_chart_series_' . substr($key, 1);
}

/**
 * The costumes worn most across everything counted, most first.
 *
 * Deliberately unfiltered: it decides which costumes get a colour of their own on the
 * costume chart, and a colour that moved with the filter would say a different costume
 * was the blue one from one selection to the next.
 *
 * @param int $limit
 * @return string[]
 */
function events_attendance_leading_costumes($limit)
{
    global $db;

    $names = array();
    $query = $db->query("
        SELECT c.costume, COUNT(*) AS worn
        FROM " . TABLE_PREFIX . "event_plugin_attendance_costumes c
        GROUP BY c.costume
        ORDER BY worn DESC, c.costume ASC
        LIMIT " . (int)$limit . "
    ");
    while($row = $db->fetch_array($query))
    {
        $names[] = $row['costume'];
    }

    return $names;
}

/**
 * Fill in the months between two, oldest first, with a count for every series in each.
 *
 * @param array $counts 'Y-m' => array(series => int)
 * @param string $first Y-m
 * @param string $last Y-m
 * @param int $max_months
 * @param string[] $keys The series each month carries
 * @return array
 */
function events_attendance_month_series(array $counts, $first, $last, $max_months, array $keys)
{
    $series = array();
    if($first === '' || $last === '' || $first > $last)
    {
        return $series;
    }

    $month = DateTime::createFromFormat('!Y-m', $first);
    $end = DateTime::createFromFormat('!Y-m', $last);
    if(!$month || !$end)
    {
        return $series;
    }

    while($month <= $end)
    {
        $key = $month->format('Y-m');
        foreach($keys as $name)
        {
            $series[$key][$name] = isset($counts[$key][$name]) ? $counts[$key][$name] : 0;
        }
        $month->modify('+1 month');
    }

    return array_slice($series, -max(1, (int)$max_months), null, true);
}

/**
 * How many rows a report view has, for paging it.
 *
 * @param string $view people|events|regions|costumes
 * @param array $filters
 * @return int
 */
function events_attendance_count($view, array $filters)
{
    global $db;

    $where = events_attendance_where($filters);

    switch($view)
    {
        case 'events':
            $select = "COUNT(DISTINCT a.event_id)";
            $from = events_attendance_from();
            break;
        case 'regions':
            $select = "COUNT(DISTINCT e.region)";
            $from = events_attendance_from();
            break;
        case 'costumes':
            $select = "COUNT(DISTINCT c.costume)";
            $from = events_attendance_from() . " INNER JOIN " . TABLE_PREFIX . "event_plugin_attendance_costumes c ON c.attendance_id = a.id";
            break;
        default:
            $select = "COUNT(DISTINCT a.user_id)";
            $from = events_attendance_from();
    }

    return (int)$db->fetch_field($db->query("SELECT {$select} AS total FROM {$from} WHERE {$where}"), 'total');
}

/**
 * One page of a report view.
 *
 * Every view counts what it lists and is ordered by that count - most first, or least
 * first when $ascending - with ties broken the same way either way round, so paging
 * through a view never shows a row twice.
 *
 * @param string $view people|events|regions|costumes
 * @param array $filters
 * @param bool $ascending
 * @param int $start
 * @param int $limit
 * @return array
 */
function events_attendance_report($view, array $filters, $ascending, $start, $limit)
{
    global $db;

    $where = events_attendance_where($filters);
    $direction = $ascending ? "ASC" : "DESC";
    $limit_sql = " LIMIT " . max(0, (int)$start) . ", " . max(1, (int)$limit);
    $rows = array();

    switch($view)
    {
        case 'events':
            $role = !empty($filters['role']) ? " AND r.role = '" . $db->escape_string($filters['role']) . "'" : "";
            $query = $db->query("
                SELECT e.id, e.title, e.start_date, e.region,
                       COUNT(DISTINCT a.user_id) AS attended,
                       (SELECT COUNT(DISTINCT r.user_id) FROM " . TABLE_PREFIX . "event_plugin_rsvps r
                        WHERE r.event_id = e.id{$role}) AS signups
                FROM " . events_attendance_from() . "
                WHERE {$where}
                GROUP BY e.id, e.title, e.start_date, e.region
                ORDER BY attended {$direction}, e.start_date DESC, e.id DESC
            " . $limit_sql);
            break;

        case 'regions':
            $query = $db->query("
                SELECT e.region,
                       COUNT(DISTINCT a.event_id) AS events,
                       COUNT(DISTINCT a.event_id, a.user_id) AS troops,
                       COUNT(DISTINCT a.user_id) AS members
                FROM " . events_attendance_from() . "
                WHERE {$where}
                GROUP BY e.region
                ORDER BY troops {$direction}, e.region ASC
            " . $limit_sql);
            break;

        case 'costumes':
            $query = $db->query("
                SELECT c.costume,
                       COUNT(*) AS worn,
                       COUNT(DISTINCT a.user_id) AS members,
                       MAX(e.start_date) AS last_date
                FROM " . events_attendance_from() . "
                INNER JOIN " . TABLE_PREFIX . "event_plugin_attendance_costumes c ON c.attendance_id = a.id
                WHERE {$where}
                GROUP BY c.costume
                ORDER BY worn {$direction}, c.costume ASC
            " . $limit_sql);
            break;

        default:
            $query = $db->query("
                SELECT a.user_id, u.username,
                       COUNT(DISTINCT a.event_id) AS troops,
                       SUM(a.role = 'trooper') AS as_trooper,
                       SUM(a.role = 'wrangler') AS as_wrangler,
                       MAX(e.start_date) AS last_date
                FROM " . events_attendance_from() . "
                LEFT JOIN " . TABLE_PREFIX . "users u ON u.uid = a.user_id
                WHERE {$where}
                GROUP BY a.user_id, u.username
                ORDER BY troops {$direction}, last_date DESC, a.user_id ASC
            " . $limit_sql);
    }

    while($row = $db->fetch_array($query))
    {
        $rows[] = $row;
    }

    if(!in_array($view, array('events', 'regions', 'costumes'), true))
    {
        $rows = events_attendance_add_member_details($rows, $filters);
    }

    return $rows;
}

/**
 * Add each member's most worn costume and last troop to a page of the people view: one
 * query each for the whole page, rather than two per member.
 *
 * @param array $rows from events_attendance_report('people', ...)
 * @param array $filters
 * @return array
 */
function events_attendance_add_member_details(array $rows, array $filters)
{
    global $db;

    if(empty($rows))
    {
        return $rows;
    }

    $uids = array();
    foreach($rows as $row)
    {
        $uids[] = (int)$row['user_id'];
    }
    $in = implode(',', $uids);
    $where = events_attendance_where($filters) . " AND a.user_id IN (" . $in . ")";

    $costumes = array();
    $query = $db->query("
        SELECT a.user_id, c.costume, COUNT(*) AS worn
        FROM " . events_attendance_from() . "
        INNER JOIN " . TABLE_PREFIX . "event_plugin_attendance_costumes c ON c.attendance_id = a.id
        WHERE {$where}
        GROUP BY a.user_id, c.costume
        ORDER BY worn DESC, c.costume ASC
    ");
    while($row = $db->fetch_array($query))
    {
        if(!isset($costumes[(int)$row['user_id']]))
        {
            $costumes[(int)$row['user_id']] = $row['costume'];
        }
    }

    $last = array();
    $query = $db->query("
        SELECT a.user_id, e.id, e.title, e.start_date
        FROM " . events_attendance_from() . "
        WHERE {$where}
        ORDER BY e.start_date DESC, e.id DESC
    ");
    while($row = $db->fetch_array($query))
    {
        if(!isset($last[(int)$row['user_id']]))
        {
            $last[(int)$row['user_id']] = $row;
        }
    }

    foreach($rows as &$row)
    {
        $uid = (int)$row['user_id'];
        $row['top_costume'] = isset($costumes[$uid]) ? $costumes[$uid] : '';
        $row['last_event'] = isset($last[$uid]) ? $last[$uid] : null;
    }
    unset($row);

    return $rows;
}

// ---------------------------------------------------------------------------
// One member's own figures
// ---------------------------------------------------------------------------

/**
 * Everything the User CP's My Troops page shows about one member.
 *
 * @param int $uid
 * @return array troops, as_trooper, as_wrangler, last (event row or null), top_costumes
 *               (every costume tied for most worn), costumes (costume => times),
 *               history (one row per troop, newest first), months (last 12)
 */
function events_attendance_member($uid)
{
    global $db;

    $uid = (int)$uid;

    $history = array();
    $query = $db->query("
        SELECT a.id, a.role, e.id AS event_id, e.title, e.start_date, e.region, e.status, e.thread_id
        FROM " . events_attendance_from() . "
        WHERE a.user_id = " . $uid . "
        ORDER BY e.start_date DESC, e.id DESC, a.role ASC
    ");
    while($row = $db->fetch_array($query))
    {
        $row['costumes'] = array();
        $history[(int)$row['id']] = $row;
    }

    $costumes = array();
    if($history)
    {
        $query = $db->simple_select("event_plugin_attendance_costumes", "attendance_id, costume", "attendance_id IN (" . implode(',', array_keys($history)) . ")");
        while($row = $db->fetch_array($query))
        {
            $history[(int)$row['attendance_id']]['costumes'][] = $row['costume'];
            $costumes[$row['costume']] = (isset($costumes[$row['costume']]) ? $costumes[$row['costume']] : 0) + 1;
        }
    }

    // Most worn first, and alphabetically among equals, so the order is stable.
    uksort($costumes, function($a, $b) use ($costumes)
    {
        return $costumes[$a] !== $costumes[$b] ? $costumes[$b] - $costumes[$a] : strcasecmp($a, $b);
    });

    $top = array();
    if($costumes)
    {
        $most = reset($costumes);
        foreach($costumes as $costume => $times)
        {
            if($times === $most)
            {
                $top[] = $costume;
            }
        }
    }

    $events = array();
    $as_trooper = 0;
    $as_wrangler = 0;
    $by_month = array();
    foreach($history as $row)
    {
        $events[(int)$row['event_id']] = true;
        if($row['role'] === 'wrangler')
        {
            $as_wrangler++;
        }
        else
        {
            $as_trooper++;
        }

        $month = substr($row['start_date'], 0, 7);
        $by_month[$month][$row['role']] = (isset($by_month[$month][$row['role']]) ? $by_month[$month][$row['role']] : 0) + 1;
    }

    $this_month = events_date('Y-m');
    $first = DateTime::createFromFormat('!Y-m', $this_month);
    $first->modify('-11 months');

    return array(
        'troops'       => count($events),
        'as_trooper'   => $as_trooper,
        'as_wrangler'  => $as_wrangler,
        'last'         => $history ? reset($history) : null,
        'top_costumes' => $top,
        'costumes'     => $costumes,
        'history'      => array_values($history),
        'months'       => events_attendance_month_series($by_month, $first->format('Y-m'), $this_month, 12, array('trooper', 'wrangler')),
    );
}

/**
 * Where a member's troop count puts them in the garrison: the share of everybody else
 * who has trooped fewer events than they have.
 *
 * "Everybody" is the garrison's members group, whether or not they have trooped, and
 * anybody else with a troop counted - a member from another garrison who troops with
 * this one every month is part of what "active" means here. Deleted members are left
 * out: they are nobody's peers any more.
 *
 * @param int $uid
 * @return float|null Percent, or null when there is nobody to compare with
 */
function events_attendance_percentile($uid)
{
    global $db;

    $uid = (int)$uid;

    $counts = array();
    $query = $db->query("
        SELECT a.user_id, COUNT(DISTINCT a.event_id) AS troops
        FROM " . TABLE_PREFIX . "event_plugin_attendance a
        INNER JOIN " . TABLE_PREFIX . "users u ON u.uid = a.user_id
        GROUP BY a.user_id
    ");
    while($row = $db->fetch_array($query))
    {
        $counts[(int)$row['user_id']] = (int)$row['troops'];
    }

    $garrison = (int)events_get_setting('garrison_members_group');
    if($garrison)
    {
        $query = $db->simple_select("users", "uid", "usergroup = " . $garrison . " OR CONCAT(',', additionalgroups, ',') LIKE '%," . $garrison . ",%'");
        while($row = $db->fetch_array($query))
        {
            if(!isset($counts[(int)$row['uid']]))
            {
                $counts[(int)$row['uid']] = 0;
            }
        }
    }

    $mine = isset($counts[$uid]) ? $counts[$uid] : 0;
    unset($counts[$uid]);

    if(empty($counts))
    {
        return null;
    }

    $fewer = 0;
    foreach($counts as $troops)
    {
        if($troops < $mine)
        {
            $fewer++;
        }
    }

    return $fewer / count($counts) * 100;
}

/**
 * The body of the User CP's My Troops page, for one member.
 *
 * @param int $uid
 * @return string HTML
 */
function events_usercp_troops_body($uid)
{
    global $mybb;

    $member = events_attendance_member($uid);

    if($member['troops'] === 0)
    {
        return '<p id="events_troops_none">No troops counted yet.</p>';
    }

    $percentile = events_attendance_percentile($uid);
    $date_format = $mybb->settings['dateformat'];

    $html = events_chart_tiles(array(
        'troops'     => array('Troops', $member['troops']),
        'trooper'    => array('As trooper', $member['as_trooper']),
        'wrangler'   => array('As wrangler', $member['as_wrangler']),
        'last'       => array('Last trooped', events_format_date($member['last']['start_date'], $date_format)),
        'percentile' => array('More active than', $percentile === null ? '-' : round($percentile) . '%', $percentile === null ? '' : 'of the garrison'),
    ));

    $last_url = htmlspecialchars_uni(events_event_url($member['last']));
    $html .= '<dl class="events_troops_facts">'
        . '<dt>Last troop</dt><dd id="events_troops_last"><a href="' . $last_url . '">' . htmlspecialchars_uni($member['last']['title']) . '</a></dd>';
    if($member['top_costumes'])
    {
        $html .= '<dt>Most worn</dt><dd id="events_troops_top_costume">' . htmlspecialchars_uni(implode(', ', $member['top_costumes'])) . '</dd>';
    }
    $html .= '</dl>';

    $html .= events_chart_months($member['months'], array(
        'trooper'  => array('Troopers', 'events_chart_trooper'),
        'wrangler' => array('Wranglers', 'events_chart_wrangler'),
    ), 'Troops in the last 12 months', 'events_chart_my_months');

    $bars = array();
    foreach(array_slice($member['costumes'], 0, 10, true) as $costume => $times)
    {
        $bars[] = array((string)$costume, $times, '');
    }
    $html .= events_chart_bars($bars, 'Costumes worn', 'events_chart_my_costumes');

    $rows = '';
    foreach($member['history'] as $index => $troop)
    {
        $rows .= '<tr class="events_troops_row">'
            . '<td class="trow' . ($index % 2 + 1) . '"><a href="' . htmlspecialchars_uni(events_event_url($troop)) . '">' . htmlspecialchars_uni($troop['title']) . '</a></td>'
            . '<td class="trow' . ($index % 2 + 1) . '">' . events_format_date($troop['start_date'], $date_format) . '</td>'
            . '<td class="trow' . ($index % 2 + 1) . '">' . htmlspecialchars_uni($troop['region']) . '</td>'
            . '<td class="trow' . ($index % 2 + 1) . '">' . events_role_label($troop['role']) . '</td>'
            . '<td class="trow' . ($index % 2 + 1) . '">' . htmlspecialchars_uni(implode(', ', $troop['costumes'])) . '</td>'
            . '</tr>';
    }

    $html .= '<table class="events_troops_history" id="events_troops_history">'
        . '<thead><tr><th class="tcat">Event</th><th class="tcat">Date</th><th class="tcat">Region</th><th class="tcat">Role</th><th class="tcat">Costumes</th></tr></thead>'
        . '<tbody>' . $rows . '</tbody>'
        . '</table>';

    return $html;
}

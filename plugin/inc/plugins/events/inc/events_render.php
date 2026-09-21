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

// events_regions() reads a setting, and this file is included on pages that have not
// necessarily pulled the core helpers in themselves.
require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

/**
 * The region list a board starts with, and what it falls back to if the setting is
 * ever emptied. A region is only a label the board sorts its events by, so the list is
 * configurable (Admin CP -> Event Management -> Settings) rather than the plugin's to
 * decide - a garrison in one state wants one entry, not four states it does not run.
 */
define('EVENTS_DEFAULT_REGIONS', 'Sydney,Hunter,Canberra,Other');

/**
 * The board's regions, in the order the Admin CP has them.
 *
 * @return array of string
 */
function events_regions()
{
    return events_parse_regions(events_get_setting('regions'));
}

/**
 * Split the stored region list into names.
 *
 * Stored as one comma separated setting rather than a table of its own: it is a handful
 * of labels that only ever get read as a list, and a table would mean an id on every
 * event and a join on every page that shows one.
 *
 * An empty list falls back to the default rather than leaving the board with no regions
 * at all, which would fail validation on every event form and make the plugin unusable
 * until somebody noticed the setting.
 *
 * @param string $stored
 * @return array of string
 */
function events_parse_regions($stored)
{
    $regions = array();

    foreach(explode(',', (string)$stored) as $region)
    {
        $region = trim($region);

        if($region !== '' && !in_array($region, $regions, true))
        {
            $regions[] = $region;
        }
    }

    if(!$regions)
    {
        $regions = explode(',', EVENTS_DEFAULT_REGIONS);
    }

    return $regions;
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
 * The control that swaps the events index between its list and its calendar.
 *
 * One button naming where it goes, rather than a pair of links naming both views and
 * marking one as current: which view you are looking at is obvious from the page itself,
 * so the second link only ever said "you are already here".
 *
 * A submit button in a one-line GET form rather than an anchor: a theme styles
 * button.button and input.button and never a bare .button on an <a>, so an anchor would
 * have to carry a look of its own and would drift the first time a theme restyled its
 * buttons. A <button> rather than the <input type="submit"> this used to be, because an
 * input has no inside to put the icon in - its label is an attribute.
 *
 * It sits at the far right of the toolbar, away from the filters, because which view you
 * are in is a property of the page rather than a filter on it - and is drawn as an
 * outline rather than a filled button so it reads as secondary to the Create Event
 * beside it. See .events_view_toggle in the stylesheet.
 *
 * Both filters travel across the toggle; the month deliberately does not, because the
 * list has nothing to do with it and the calendar opens on the current month.
 *
 * @param string $view The view being shown
 * @param string $region_filter Current region filter, or '' for all regions
 * @param bool $show_archived Whether archived events are being shown
 * @return string
 */
function events_view_toggle($view, $region_filter = '', $show_archived = false)
{
    $target = events_other_view($view);
    $label = $target === 'calendar' ? 'Calendar' : 'List';

    // events_filter_form for the shared one-line-form layout, events_view_form for the
    // one rule that separates this from the filters it shares the toolbar with.
    $html = '<form method="get" action="events.php" class="events_filter_form events_view_form">'
          . '<input type="hidden" name="view" value="' . $target . '" />';

    if($region_filter !== '')
    {
        $html .= '<input type="hidden" name="region" value="' . htmlspecialchars_uni($region_filter) . '" />';
    }

    if($show_archived)
    {
        $html .= '<input type="hidden" name="archived" value="1" />';
    }

    // The icon names the view the button goes to, and the word beside it says the same
    // thing - it is decoration over a label that is already there, so it is hidden from
    // a screen reader rather than described twice.
    return $html . '<button type="submit" class="button events_view_toggle" id="events_view_' . $target . '">'
         . '<span class="events_view_icon" aria-hidden="true"></span>' . $label
         . '</button></form>';
}

/**
 * The script that makes the index's filters apply as they are changed.
 *
 * Picking a region or ticking Show archived submits the form there and then, so the
 * filter bar has no button to press. The button is still in the markup inside a
 * <noscript>, because the page has to work with the script turned off - this enhances a
 * control that posts the same thing either way, and events.php validates what arrives
 * regardless of how it was sent.
 *
 * Bound on the form rather than on each control, so a filter added to the bar later is
 * picked up without touching this: change bubbles, unlike focus or blur.
 *
 * @return string
 */
function events_filter_script()
{
    return "<script type=\"text/javascript\">\n"
         . "(function() {\n"
         . "\tvar form = document.getElementById('events_filter_form');\n"
         . "\tif(!form) { return; }\n"
         . "\tform.addEventListener('change', function() { form.submit(); });\n"
         . "})();\n"
         . "</script>";
}

/**
 * The "Show archived" box in the index's filter bar.
 *
 * A checkbox beside the region select rather than another entry in it: region and status
 * are two independent questions, and folding them into one list would mean a member who
 * wanted Canberra's archived events had nothing to pick.
 *
 * Unchecked boxes are simply absent from a GET submission, which is exactly the default
 * this wants - a bare events.php, a bookmark or a link from anywhere else in the board
 * all arrive without the parameter and get the upcoming schedule.
 *
 * @param bool $show_archived
 * @return string
 */
function events_archived_filter($show_archived)
{
    $checked = $show_archived ? ' checked="checked"' : '';

    return '<label class="events_filter_check" for="events_show_archived">'
         . '<input type="checkbox" name="archived" id="events_show_archived" value="1"' . $checked . ' />'
         . ' Show archived</label>';
}

/**
 * How an event's status reads on screen.
 *
 * Title case, the same text on every page and at every screen size. The listing used to
 * print the stored value as it stands - lower-case "live", "pending", "archived",
 * because those are the enum's own spellings - and the phone cards then shouted them in
 * capitals to sit them beside a title. Three registers for one value, and none of them
 * a way a board would write it down.
 *
 * Two of the four labels are not stored anywhere, because the stored column cannot
 * express them. A live event that has been and gone is not "Live" in any sense a member
 * would recognise, and which of the two it is depends on whether its troop report has
 * been posted:
 *
 *     Needs Troop Report - it finished and nobody has written it up
 *     Complete           - it finished and somebody has
 *
 * Both only ever replace "Live". Pending and Archived are answers in their own right -
 * a pending event never happened, and archiving is how an event is closed out, so an
 * archived one is not outstanding work whatever its report says.
 *
 * The stored value stays on the page beside this, unchanged, as data-event-status - so
 * anything that needs to match on the status rather than read it still can.
 *
 * @param array $event
 * @return string
 */
function events_status_label($event)
{
    if(events_needs_troop_report($event))
    {
        return 'Needs Troop Report';
    }

    if($event['status'] === 'live' && events_has_ended($event))
    {
        return 'Complete';
    }

    return ucwords($event['status']);
}

/**
 * The control that folds the index's filters away on a phone.
 *
 * The toolbar carries the filters, Create Event and the list/calendar switch, and on a
 * phone all of that will not sit on one row - the switch wrapped onto a line of its own
 * below everything else, which read as a stray button rather than as the view control
 * it is. So on a narrow screen the filters go behind this button and the row has room
 * for the three controls that say what the page *is*; from 700px up the button is not
 * rendered at all (`display: none`) and the filters are the inline row they always were.
 *
 * A checkbox and its label rather than a <details>, which is what #rsvp_filter on the
 * event page uses for the same job. A <details> holds its state in the DOM, and a closed
 * one cannot be made to show its contents from CSS - modern engines hide the content with
 * content-visibility on ::details-content, which no author rule reaches - so the desktop
 * half would need the disclosure taken out of the markup. A checkbox keeps the state in
 * CSS's reach, where a media query can simply ignore it, and the same sibling-selector
 * trick the signup wizard's per-day drawer uses opens the panel with no script at all.
 *
 * It carries no name attribute, so it is not a field: it sits outside the filter form
 * and nothing about it reaches the server either way.
 *
 * Rendered already open when something is filtered, so a member who arrives on a
 * filtered page can see what it is filtered to without hunting for the button - the same
 * reason event.php opens its RSVP filter panel when that page is filtered.
 *
 * @param string $region_filter
 * @param bool $show_archived
 * @return string
 */
function events_filter_disclosure($region_filter = '', $show_archived = false)
{
    $checked = ($region_filter !== '' || $show_archived) ? ' checked="checked"' : '';

    // The funnel is decoration over a word that is already the label, so it is hidden
    // from a screen reader rather than described twice - the same way the view toggle's
    // icon is.
    return '<input type="checkbox" id="events_filter_open" class="events_filter_disclosure"' . $checked . ' />'
         . '<label class="events_filter_button" for="events_filter_open">'
         . '<span class="events_filter_icon" aria-hidden="true"></span>Filter</label>';
}

/**
 * The index's filters as a query string fragment, for the links that are not forms.
 *
 * The calendar's Previous and Next are plain anchors, so paging October to November would
 * drop whatever the member had filtered to and hand back a month of everything unless the
 * filters are spelled out on the link.
 *
 * Returned with escaped ampersands because every caller interpolates it into an href in a
 * template; urlencode() on the region covers the value itself.
 *
 * @param string $region_filter
 * @param bool $show_archived
 * @return string '' when nothing is filtered
 */
function events_index_filter_params($region_filter, $show_archived = false)
{
    $params = '';

    if($region_filter !== '')
    {
        $params .= '&amp;region=' . urlencode($region_filter);
    }

    if($show_archived)
    {
        $params .= '&amp;archived=1';
    }

    return $params;
}

/**
 * A Google Maps search for an event's address.
 *
 * A search rather than a pin: the address is typed by a coordinator, not picked off a map,
 * so there is no place id or pair of coordinates to point at - and a search copes with
 * "Sydney Showground, Olympic Park" in a way that a lookup demanding a full postal address
 * would not. The Maps URL API is the documented, key-free entry point for exactly that.
 *
 * @param string $address
 * @return string empty when the event has no address
 */
function events_map_url($address)
{
    $address = trim((string)$address);

    if($address === '')
    {
        return '';
    }

    // rawurlencode, so a space becomes %20 rather than a '+' that Maps would show as part
    // of the search text.
    return 'https://www.google.com/maps/search/?api=1&query=' . rawurlencode($address);
}

/**
 * An event's address as a link to the map, for the plugin's HTML pages.
 *
 * Opened in a new tab: the board is where the member is signing up, and sending them off
 * to Maps in the same one loses the event page they were reading. rel goes with it - a
 * target="_blank" link hands the opened page a window.opener on older browsers.
 *
 * @param string $address
 * @param string $class Class on the anchor
 * @return string empty when the event has no address
 */
function events_address_link($address, $class = 'events_address_link')
{
    $url = events_map_url($address);

    if($url === '')
    {
        return '';
    }

    return '<a class="' . $class . '" href="' . htmlspecialchars_uni($url) . '"'
         . ' target="_blank" rel="noopener noreferrer">' . htmlspecialchars_uni(trim((string)$address)) . '</a>';
}

/**
 * An event's signup counts as a pair of coloured lozenges.
 *
 * Two lozenges rather than one number, so an event with only wranglers still reads as
 * "0 troopers, 1 wrangler" instead of an unexplained 0. The dot is always backed up by
 * a word or a letter, so the breakdown never depends on colour alone.
 *
 * The same markup serves both pages on purpose. The listing is a narrow column a dozen
 * rows deep, so it wears the initials; the event page has one event and a whole line to
 * spend, so it spells them out - which is where a member learns what the T and the W on
 * the listing meant, and why the colours have to match.
 *
 * @param int $trooper_count
 * @param int $wrangler_count
 * @param bool $spell_out Names the roles in full instead of abbreviating to T / W
 * @param bool $with_ids Adds the ids the event page addresses its own counts by; the
 *                       listing repeats the pair once per row and so cannot have them
 * @return string
 */
function events_signup_counts($trooper_count, $wrangler_count, $spell_out = false, $with_ids = false)
{
    $counts = array(
        'trooper' => (int)$trooper_count,
        'wrangler' => (int)$wrangler_count,
    );
    $ids = array(
        'trooper' => 'event_rsvp_count',
        'wrangler' => 'event_wrangler_count',
    );

    $out = '';
    foreach($counts as $role => $count)
    {
        $label = events_role_label($role);
        // Plural only where the word is spelled out: "1 Troopers" is a typo the eye
        // catches, and the initials are a key rather than a noun to be agreed with.
        // A real space before the spelled-out word, not a margin: "2 Troopers" is a
        // phrase, and it has to survive being copied, read aloud or printed.
        $named = $spell_out
            ? ' <span class="event_count_label">' . $label . ($count === 1 ? '' : 's') . '</span>'
            : '<span class="event_count_key">' . $label[0] . '</span>';
        // A tooltip repeating a word already on the page is noise, so it is only there
        // to explain the initials.
        $title = $spell_out ? '' : ' title="' . $label . 's"';
        $id = $with_ids ? ' id="' . $ids[$role] . '"' : '';

        $out .= '<span class="event_count event_count_' . $role . '"' . $title . '>'
              . '<span class="event_count_dot"></span>'
              . '<span' . $id . ' class="event_' . ($role === 'trooper' ? 'rsvp' : 'wrangler') . '_count">' . $count . '</span>'
              . $named
              . '</span>';
    }

    return $out;
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
 * MyBB's post parser, created on first use.
 *
 * MyBB builds $parser on the pages that need it and leaves the global unset everywhere
 * else, so a plugin page cannot assume it is there - and building a second one of its
 * own would miss whatever a parser plugin has hooked onto the first.
 *
 * @return postParser
 */
function events_parser()
{
    global $parser;

    if(!is_object($parser))
    {
        require_once MYBB_ROOT . "inc/class_parser.php";
        $parser = new postParser;
    }

    return $parser;
}

/**
 * An event's description, rendered the way a post is.
 *
 * A description is written in the board's own editor and in the board's own BBCode, so
 * it is parsed by MyBB's parser rather than by anything of the plugin's: a coordinator
 * who can write a post can write a description, and a board that has turned a MyCode off
 * has turned it off here too.
 *
 * HTML stays off. Coordinators are trusted with BBCode exactly as every poster is, which
 * is a long way from being trusted with a <script> tag, and nothing an event needs to say
 * wants raw markup.
 *
 * @param string $description Raw, as stored
 * @return string HTML, empty for an empty description
 */
function events_parse_description($description)
{
    $description = (string)$description;

    if(trim($description) === '')
    {
        return '';
    }

    return events_parser()->parse_message($description, array(
        // allow_html is passed as 0 rather than left out: parse_message() reads the key
        // directly on its way into parse_smilies(), so an absent one is a PHP warning.
        'allow_html'      => 0,
        'allow_mycode'    => 1,
        'allow_smilies'   => 1,
        'allow_imgcode'   => 1,
        'allow_videocode' => 1,
        'filter_badwords' => 1,
    ));
}

/**
 * An event's description as plain text.
 *
 * For the iCal feed, whose DESCRIPTION is a text property that a calendar app shows
 * verbatim - so BBCode has to come out rather than be rendered. text_parse_message() is
 * MyBB's own plain-text pass, the one its feeds and its search index use, and strip_tags
 * catches the handful of places it still leaves a tag behind.
 *
 * @param string $description Raw, as stored
 * @return string
 */
function events_description_text($description)
{
    return strip_tags(events_parser()->text_parse_message((string)$description, array(
        'filter_badwords' => 1,
    )));
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
    $label = events_date('D j M Y', events_strtotime($day['date']));

    if(!empty($day['start_time']) && !empty($day['end_time']))
    {
        $label .= ' (' . events_date('H:i', events_strtotime($day['date'] . ' ' . $day['start_time']))
                . ' - ' . events_date('H:i', events_strtotime($day['date'] . ' ' . $day['end_time'])) . ')';
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
    return events_date('j M', events_strtotime($day['date']));
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
    $month = (int)events_date('n', $month_start);
    $year = (int)events_date('Y', $month_start);
    $days_in_month = (int)events_date('t', $month_start);

    // Bucket events by every date they span so multi-day events appear on each day.
    //
    // The cursor walks dates rather than timestamps, in UTC: a date has no hours to be
    // moved by a daylight saving change, and stepping a midnight in a zone that has one
    // skips or repeats a day of the calendar.
    $utc = new DateTimeZone('UTC');
    $by_date = array();
    foreach($events as $event)
    {
        $cursor = new DateTime(events_date('Y-m-d', events_strtotime($event['start_date'])), $utc);
        $last = new DateTime(events_date('Y-m-d', events_strtotime($event['end_date'])), $utc);
        $guard = 0;
        while($cursor <= $last && $guard++ < 400)
        {
            $by_date[$cursor->format('Y-m-d')][] = $event;
            $cursor->modify('+1 day');
        }
    }

    // Monday-first grid.
    $lead = ((int)events_date('N', $month_start)) - 1;
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

                // The address sits under the event rather than inside its link, because a
                // cell is small and one anchor cannot go to two places: tapping the event
                // has to open the event, and tapping the address has to open the map.
                if(isset($event['address']))
                {
                    $content .= events_address_link($event['address'], 'calendar_event_address');
                }
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
function events_role_verb($role, $past = false)
{
    if($past)
    {
        return $role === 'wrangler' ? 'Wrangled' : 'Trooped';
    }

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
            ? events_date('l', events_strtotime($day['date']))
            : events_day_short_label($day);

        if($per_date[$day['date']] > 1 && !empty($day['start_time']))
        {
            $label .= ' ' . events_date('H:i', events_strtotime($day['date'] . ' ' . $day['start_time']));
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
 * The script that keeps the attendance step's two questions from contradicting each other.
 *
 * "How are you attending?" and the per-day grid are two views of one answer, so the page
 * moves them together: answering above sets every day, setting the days apart clears the
 * answer above because no single chip describes them any more, and putting the days back
 * into agreement re-selects the one they agree on. That is the same state the server
 * renders from a POST, so the page and the next render always say the same thing.
 *
 * It is an enhancement rather than a requirement. With no script the leading answer still
 * governs while the grid is closed, and the grid still speaks for itself while it is open
 * - the two just stop updating each other as they are touched.
 *
 * Inline for the same reason the day grid's script is: the plugin deploys PHP, templates
 * and a stylesheet, and a file would be a fourth thing to get onto the board.
 *
 * @return string
 */
function events_signup_days_script()
{
    return <<<'SCRIPT'
<script type="text/javascript">
(function() {
	var days = document.getElementById('signup_days');
	var toggle = document.getElementById('signup_per_day');
	if(!days || !toggle) { return; }

	var primary = document.querySelectorAll('input.signup_role_radio');
	var rows = days.querySelectorAll('.signup_day');
	if(!primary.length || !rows.length) { return; }

	function selected(radios) {
		for(var i = 0; i < radios.length; i++) {
			if(radios[i].checked) { return radios[i].value; }
		}
		return '';
	}

	function rowRadios(row) {
		return row.querySelectorAll('input.day_role_radio');
	}

	// The last answer the leading question held, so that closing the grid has something to
	// fall back on: closing it says "the same thing every day", which needs an answer, and
	// the member may well have cleared it by setting the days apart before changing their
	// mind. Empty only when the page was opened on a signup that was already mixed.
	var remembered = selected(primary);

	function apply(value) {
		for(var i = 0; i < rows.length; i++) {
			var radios = rowRadios(rows[i]);
			for(var j = 0; j < radios.length; j++) {
				radios[j].checked = (radios[j].value === value);
			}
		}
	}

	function selectPrimary(value) {
		for(var i = 0; i < primary.length; i++) {
			primary[i].checked = (value !== '' && primary[i].value === value);
		}
	}

	// Days that agree are that agreement stated twice, so it is shown above as well. Days
	// that disagree have no answer above: "Not attending on Sunday" is not trooping the
	// event, and leaving the chip lit would say it was.
	function syncFromDays() {
		var agreed = selected(rowRadios(rows[0]));
		for(var i = 1; i < rows.length; i++) {
			if(selected(rowRadios(rows[i])) !== agreed) { agreed = ''; break; }
		}

		// 'none' agreed on every day is not an answer to the question above either - it is
		// a signup to nothing, which the server turns away.
		selectPrimary(agreed);
		if(selected(primary) !== '') { remembered = agreed; }
	}

	for(var i = 0; i < primary.length; i++) {
		primary[i].addEventListener('change', function() {
			if(!this.checked) { return; }
			remembered = this.value;
			apply(this.value);
		});
	}

	days.addEventListener('change', function(event) {
		var target = event.target;
		if(target && target.classList && target.classList.contains('day_role_radio')) {
			syncFromDays();
		}
	});

	toggle.addEventListener('change', function() {
		// Closing the grid hands the whole event back to the answer above, so the days are
		// put back on it rather than left holding what they were last set to - the member
		// is signed up to what the page is showing them.
		if(this.checked || remembered === '') { return; }
		selectPrimary(remembered);
		apply(remembered);
	});
})();
</script>
SCRIPT;
}

/**
 * One row of radio chips - the attendance step's way of asking a single question.
 *
 * The radio itself is left in the document at full size and painted out by the
 * stylesheet rather than hidden, so the whole chip is the hit target while the control
 * keeps its place in the tab order, its arrow-key behaviour and its accessible name.
 * Hiding it would cost all three.
 *
 * @param string $name Input name, e.g. "day_role[7]"
 * @param array $choices value => label, in display order; labels are plain text
 * @param string $current The value to pre-select
 * @param string $id_prefix Each chip's id is "$id_prefix_$value"
 * @param string $class Class on each input, for the tests to select on
 * @return string
 */
function events_signup_choices($name, array $choices, $current, $id_prefix, $class)
{
    $html = '<span class="signup_choices">';

    foreach($choices as $value => $label)
    {
        $id = $id_prefix . '_' . $value;
        $checked = ((string)$current === (string)$value) ? ' checked="checked"' : '';

        $html .= '<label class="signup_choice">'
               . '<input type="radio" id="' . $id . '" name="' . htmlspecialchars_uni($name) . '"'
               . ' value="' . $value . '" class="' . $class . '"' . $checked . ' />'
               . '<span class="signup_choice_text">' . htmlspecialchars_uni($label) . '</span>'
               . '</label>';
    }

    return $html . '</span>';
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

/**
 * One field of a front-end form: its label, its control, and the hint under it.
 *
 * The plugin's forms are stacks rather than MyBB's .form_row, which lays the label, the
 * control and the hint out on one line and leaves the control unstyled. The hint is wired
 * to the control with aria-describedby so a screen reader reads it as part of the field
 * rather than as loose text after it.
 *
 * The wrapper carries "field_" + the control's id, so a field that needs to break out of
 * the column the others sit in - the description, whose editor wants the full width - can
 * be reached from the stylesheet without the caller having to wrap it in anything.
 *
 * @param string $id The control's id; the hint gets "hint_" + this and the wrapper "field_"
 * @param string $label Plain text
 * @param string $control Markup for the control itself
 * @param string $hint Plain text, or empty for no hint
 * @param bool $required Marks the label, for the eye only - the control carries its own
 * @return string
 */
function events_form_field($id, $label, $control, $hint = '', $required = false)
{
    $html = '<div class="events_field" id="field_' . $id . '">'
          . '<label class="events_label" for="' . $id . '">' . htmlspecialchars_uni($label);

    if($required)
    {
        $html .= '<span class="events_required">*</span>';
    }

    $html .= '</label>' . $control;

    if($hint !== '')
    {
        $html .= '<span class="events_hint" id="hint_' . $id . '">' . htmlspecialchars_uni($hint) . '</span>';
    }

    return $html . '</div>';
}

/**
 * A text input for a front-end form.
 *
 * @param string $name
 * @param string $id
 * @param string $value Raw; escaped here
 * @param array $attributes Extra HTML attributes, e.g. array('required' => 'required')
 * @param bool $described Whether a hint with the matching id exists to point at
 * @return string
 */
function events_form_text($name, $id, $value, array $attributes = array(), $described = false)
{
    $html = '<input type="text" class="events_input" name="' . $name . '" id="' . $id . '"'
          . ' value="' . htmlspecialchars_uni((string)$value) . '"';

    if($described)
    {
        $html .= ' aria-describedby="hint_' . $id . '"';
    }

    foreach($attributes as $attribute => $attribute_value)
    {
        $html .= ' ' . $attribute . '="' . htmlspecialchars_uni((string)$attribute_value) . '"';
    }

    return $html . ' />';
}

/**
 * A select box for a front-end form.
 *
 * @param string $name
 * @param string $id
 * @param array $options value => label
 * @param string|int $selected
 * @param bool $described
 * @return string
 */
function events_form_select($name, $id, array $options, $selected, $described = false)
{
    $html = '<select class="events_select" name="' . $name . '" id="' . $id . '"'
          . ($described ? ' aria-describedby="hint_' . $id . '"' : '') . '>';

    foreach($options as $value => $label)
    {
        // Compared as strings: option keys arrive from the database as strings and are
        // matched against ints as often as not, and PHP 8 no longer makes '' == 0 true.
        $is_selected = ((string)$value === (string)$selected) ? ' selected="selected"' : '';
        $html .= '<option value="' . htmlspecialchars_uni((string)$value) . '"' . $is_selected . '>'
               . htmlspecialchars_uni((string)$label) . '</option>';
    }

    return $html . '</select>';
}

/**
 * The error box a front-end form shows above itself after a failed submit.
 *
 * @param array $errors Plain-text messages
 * @param string $id
 * @return string empty when there is nothing to report
 */
function events_form_errors(array $errors, $id)
{
    if(empty($errors))
    {
        return '';
    }

    $html = '<div class="error" id="' . $id . '"><ul>';
    foreach($errors as $error)
    {
        $html .= '<li>' . htmlspecialchars_uni($error) . '</li>';
    }

    return $html . '</ul></div>';
}

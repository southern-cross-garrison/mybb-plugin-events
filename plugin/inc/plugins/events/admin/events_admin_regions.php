<?php
/**
 * MyBB Event Plugin - Region list editing
 *
 * A region is the label an event is filed under: the events listing filters by it, and
 * the announcement thread is posted to that region's forum. Which regions exist is the
 * board's business rather than the plugin's - a garrison covering one state wants one
 * entry, not the four this plugin happened to ship with - so the list is editable from
 * Admin CP -> Event Management -> Settings.
 *
 * Editing it has to answer one question the rest of the settings page never does: an
 * event stores its region as text, so deleting a region that events are filed under
 * would leave those events pointing at something that no longer exists - invisible to
 * the region filter, and rejected by the event form the next time anybody saved one. A
 * deletion therefore asks where those events should go and moves them, and refuses to
 * go ahead until it has an answer.
 *
 * The three operations are deliberately not the same shape:
 *
 * - Renaming is a text box saved with the rest of the settings, because it is an edit
 *   like any other on that page and its events follow it automatically.
 * - Adding and deleting each have their own action, confirmed in a modal and applied on
 *   the spot, because neither is an edit to the form the admin is looking at - deleting
 *   in particular has a question of its own to ask, and asking it inside a form the
 *   admin has not submitted yet would mean carrying every other setting through the
 *   confirmation with it.
 *
 * Both of those work with the script turned off: the controls are ordinary links to a
 * confirmation page that asks the same questions and posts the same fields, and the
 * modal is an enhancement over the top. The server validates what arrives either way.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_render.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_thread.php";

// The `region` column is varchar(64).
define('EVENTS_REGION_MAX_LENGTH', 64);

/**
 * How many events are filed under each region.
 *
 * Grouped over the whole table rather than counted per region, because this is only
 * ever needed for all of them at once.
 *
 * @return array region => int
 */
function events_admin_region_event_counts()
{
    global $db;

    $counts = array();

    $query = $db->write_query("SELECT region, COUNT(*) AS total
        FROM `" . TABLE_PREFIX . "event_plugin_events` GROUP BY region");

    while($row = $db->fetch_array($query))
    {
        $counts[$row['region']] = (int)$row['total'];
    }

    return $counts;
}

/**
 * "3 events are" / "1 event is", for a sentence about a region's events.
 *
 * @param int $count
 * @return string
 */
function events_admin_region_event_phrase($count)
{
    return $count . ' ' . ($count === 1 ? 'event is' : 'events are');
}

/**
 * Whether a name is usable as a region.
 *
 * Commas and equals signs are out because both the region list and the region => forum
 * map are stored as flat settings ("Sydney,Hunter" and "Sydney=2,Hunter=5"); a region
 * carrying either character would corrupt every entry after it.
 *
 * @param string $name
 * @param array $taken Names already in use, compared case-insensitively
 * @return string the complaint, or '' when the name is fine
 */
function events_admin_region_name_error($name, array $taken = array())
{
    if($name === '')
    {
        return "A region needs a name.";
    }

    if(strpos($name, ',') !== false || strpos($name, '=') !== false)
    {
        return "\"" . htmlspecialchars_uni($name) . "\" cannot be used as a region name: a region name cannot contain a comma or an equals sign.";
    }

    if(strlen($name) > EVENTS_REGION_MAX_LENGTH)
    {
        return "\"" . htmlspecialchars_uni($name) . "\" is too long for a region name (" . EVENTS_REGION_MAX_LENGTH . " characters at most).";
    }

    // Case only, and not accents: "Cafe" and "Café" are different names to the region
    // column (see events_install_database()), but two regions a letter's case apart would
    // just be the same place typed twice.
    foreach($taken as $other)
    {
        if(mb_strtolower($other, 'UTF-8') === mb_strtolower($name, 'UTF-8'))
        {
            return "\"" . htmlspecialchars_uni($name) . "\" is already a region.";
        }
    }

    return '';
}

/**
 * Refile events onto their new regions.
 *
 * One statement rather than an UPDATE per region, because sequential updates cannot
 * express a swap: renaming Sydney to Hunter and Hunter to Sydney would run the first,
 * and then the second would drag the rows it had just moved straight back. A CASE reads
 * every row's old value once, so the mapping is applied as written.
 *
 * @param array $moves old region => new region
 * @return int rows moved
 */
function events_admin_apply_region_moves(array $moves)
{
    global $db;

    if(!$moves)
    {
        return 0;
    }

    $cases = '';
    $from = array();

    foreach($moves as $old => $new)
    {
        // write_query() escapes nothing, and these are values a human typed.
        $old = $db->escape_string($old);
        $cases .= " WHEN '" . $old . "' THEN '" . $db->escape_string($new) . "'";
        $from[] = "'" . $old . "'";
    }

    $db->write_query("UPDATE `" . TABLE_PREFIX . "event_plugin_events`
        SET region = CASE region" . $cases . " ELSE region END
        WHERE region IN (" . implode(',', $from) . ")");

    return (int)$db->affected_rows();
}

/**
 * The events a set of region moves will refile that have an announcement thread.
 *
 * Read before the moves are applied, since afterwards nothing says which events they
 * touched.
 *
 * @param array $moves old region => new region
 * @return array of int event id
 */
function events_admin_announced_event_ids(array $moves)
{
    global $db;

    if(!$moves)
    {
        return array();
    }

    $from = array();
    foreach(array_keys($moves) as $old)
    {
        $from[] = "'" . $db->escape_string($old) . "'";
    }

    $ids = array();
    $query = $db->write_query("SELECT id FROM `" . TABLE_PREFIX . "event_plugin_events`
        WHERE thread_id > 0 AND region IN (" . implode(',', $from) . ")");

    while($row = $db->fetch_array($query))
    {
        $ids[] = (int)$row['id'];
    }

    return $ids;
}

/**
 * Bring refiled events' announcement threads up to date with their new regions.
 *
 * The post names the region and links to its listing, and the thread belongs in the new
 * region's forum - neither of which the UPDATE over the events table can see to. Run
 * after the new region settings are written, since that is what the sync resolves the
 * forum from.
 *
 * @param array $event_ids From events_admin_announced_event_ids()
 * @param array $former_forum_ids events_announcement_forum_ids() as it was before the
 *        change: a deleted region's forum is no longer on the map, and its threads have
 *        to be allowed out of it
 * @return array of string, one per thread that could not be updated
 */
function events_admin_sync_region_threads(array $event_ids, array $former_forum_ids)
{
    $errors = array();

    foreach($event_ids as $event_id)
    {
        $error = null;
        events_sync_event_thread($event_id, $error, $former_forum_ids);

        if($error !== null)
        {
            $event = events_get_event($event_id);
            $errors[] = "The announcement for \"" . htmlspecialchars_uni($event ? $event['title'] : '#' . $event_id)
                . "\" could not be updated: " . $error;
        }
    }

    return $errors;
}

/**
 * Write the region list and the per-region forum map, and refresh MyBB's settings cache.
 *
 * The two always move together: the forum map is keyed by region name, so a list written
 * without it is a board whose announcements quietly stop being routed.
 *
 * @param array $regions Ordered region names
 * @param array $forums  region => forum id
 */
function events_admin_save_region_settings(array $regions, array $forums)
{
    global $db;

    $values = array(
        'events_regions'      => implode(',', $regions),
        'events_event_forums' => events_build_region_forums_setting($forums),
    );

    foreach($values as $name => $value)
    {
        $db->update_query("settings", array("value" => $db->escape_string($value)), "name = '" . $db->escape_string($name) . "'");
    }

    // MyBB reads its settings from the generated inc/settings.php, not from the table,
    // so the rows alone would leave every page on the old list.
    rebuild_settings();
}

/**
 * Add a region to the end of the list.
 *
 * @param string $name
 * @param array $errors Appended to
 * @return bool
 */
function events_admin_add_region($name, array &$errors)
{
    $regions = events_regions();

    $error = events_admin_region_name_error($name, $regions);
    if($error !== '')
    {
        $errors[] = $error;
        return false;
    }

    $regions[] = $name;
    events_admin_save_region_settings($regions, events_region_forums());

    return true;
}

/**
 * Delete a region, moving any events filed under it somewhere else.
 *
 * @param string $region
 * @param string $move_to Where its events go; ignored when it has none
 * @param array $errors Appended to
 * @param array|null $thread_errors Set to the announcements that could not follow their
 *        events, which does not stop the deletion
 * @return int|false events moved, or false when nothing was done
 */
function events_admin_delete_region($region, $move_to, array &$errors, &$thread_errors = null)
{
    $thread_errors = array();

    $regions = events_regions();

    if(!in_array($region, $regions, true))
    {
        $errors[] = "There is no region called \"" . htmlspecialchars_uni($region) . "\". It may already have been deleted.";
        return false;
    }

    if(count($regions) < 2)
    {
        $errors[] = "The board needs at least one region: every event has to be filed under one.";
        return false;
    }

    $counts = events_admin_region_event_counts();
    $count = isset($counts[$region]) ? (int)$counts[$region] : 0;

    if($count > 0 && (!in_array($move_to, $regions, true) || $move_to === $region))
    {
        $errors[] = "Choose a region to move " . events_admin_region_event_phrase($count)
            . " filed under \"" . htmlspecialchars_uni($region) . "\" to.";
        return false;
    }

    $former_forum_ids = events_announcement_forum_ids();
    $announced = $count > 0 ? events_admin_announced_event_ids(array($region => $move_to)) : array();

    // The events move first, so that an interruption between the two leaves them filed
    // under a region the board can still see rather than under one it cannot.
    $moved = $count > 0 ? events_admin_apply_region_moves(array($region => $move_to)) : 0;

    $forums = events_region_forums();
    // The deleted region's announcement forum goes with it; its events are now in
    // another region and are announced wherever that region is.
    unset($forums[$region]);

    $remaining = array();
    foreach($regions as $other)
    {
        if($other !== $region)
        {
            $remaining[] = $other;
        }
    }

    events_admin_save_region_settings($remaining, $forums);

    // A thread failing to update does not undo the deletion: the events are already
    // refiled, and the next save of each event retries its thread.
    $thread_errors = events_admin_sync_region_threads($announced, $former_forum_ids);

    return $moved;
}

/**
 * The region rows the settings form should render, and the renames it submitted.
 *
 * On a GET that is the stored list. On a POST it is what was submitted, so a form coming
 * back with an error still shows the edits that caused it rather than silently reverting.
 *
 * The original name travels in a hidden field rather than being looked up by position.
 * Position would be enough right up until two admins had the settings page open at once,
 * at which point the second save would rename regions it was never shown.
 *
 * The forum comes back under the row's index, the same as its name box, and never under
 * the region's name: PHP ends an array key at the first "]", so a dropdown called
 * event_forums[North]Coast] arrives as event_forums[North] and the region loses its
 * forum to a name the board does not have.
 *
 * @return array of array('original' => string, 'name' => string, 'forum' => string)
 */
function events_admin_region_rows()
{
    global $mybb;

    $rows = array();

    if($mybb->request_method != "post")
    {
        $forums = events_region_forums();

        foreach(events_regions() as $region)
        {
            $rows[] = array(
                'original' => $region,
                'name'     => $region,
                'forum'    => isset($forums[$region]) ? (string)$forums[$region] : '',
            );
        }

        return $rows;
    }

    $originals = (array)$mybb->get_input('region_original', MyBB::INPUT_ARRAY);
    $names     = (array)$mybb->get_input('region_name', MyBB::INPUT_ARRAY);
    $forums    = (array)$mybb->get_input('event_forums', MyBB::INPUT_ARRAY);

    foreach($originals as $index => $original)
    {
        $rows[] = array(
            'original' => trim((string)$original),
            'name'     => isset($names[$index]) ? trim((string)$names[$index]) : '',
            'forum'    => isset($forums[$index]) ? trim((string)$forums[$index]) : '',
        );
    }

    return $rows;
}

/**
 * Work out what the submitted rows rename, without writing anything.
 *
 * Separated from applying it so that the settings form can be re-rendered with the
 * submitted values when something does not add up, and so that a bad region name aborts
 * the whole settings save rather than leaving the regions half-changed.
 *
 * @param array $rows   From events_admin_region_rows()
 * @param array $errors Appended to
 * @return array|false  array('list' => string, 'moves' => array, 'renames' => array),
 *                      or false when $errors was added to
 */
function events_admin_plan_regions(array $rows, array &$errors)
{
    $current = events_regions();

    $final   = array();
    $renames = array();  // original => the name it now has
    $seen    = array();  // names claimed by the rows so far

    foreach($rows as $row)
    {
        // A submitted row naming a region the board does not currently have means the
        // list moved under this form - almost always a second admin, or this admin in
        // another tab, adding or deleting one first. Every original is checked rather
        // than trusted, because each one is about to be used as the WHERE of an UPDATE
        // over the events table.
        if(!in_array($row['original'], $current, true))
        {
            $errors[] = "The region list changed while this page was open. Nothing was saved - reload the settings and try again.";
            return false;
        }

        $error = events_admin_region_name_error($row['name'], $seen);
        if($error !== '')
        {
            $errors[] = $error;
            continue;
        }

        $seen[] = $row['name'];
        $final[] = $row['name'];
        $renames[$row['original']] = $row['name'];
    }

    if($errors)
    {
        return false;
    }

    // Renames move their events with them, which is the whole reason renaming is an
    // operation of its own rather than a deletion and an addition.
    $moves = array();
    foreach($renames as $original => $name)
    {
        if($original !== $name)
        {
            $moves[$original] = $name;
        }
    }

    return array(
        'list'    => implode(',', $final),
        'moves'   => $moves,
        'renames' => $renames,
    );
}

/**
 * The per-region announcement forums the submitted rows ask for, under the names the
 * regions now have.
 *
 * Each dropdown sits on the row of the region it belongs to, so a renamed region's forum
 * follows it to its new name rather than the board silently losing the routing it just
 * had.
 *
 * @param array $rows    From events_admin_region_rows()
 * @param array $renames original => final name
 * @return array region => forum id
 */
function events_admin_region_forums_from_rows(array $rows, array $renames)
{
    $mapped = array();

    foreach($rows as $row)
    {
        $region = isset($renames[$row['original']]) ? $renames[$row['original']] : $row['original'];
        $mapped[$region] = $row['forum'];
    }

    return $mapped;
}

/**
 * The URL of an add or delete confirmation.
 *
 * It is a real page, reached by a real link: that is what the controls fall back to with
 * the script turned off, and what the modal posts to when it is confirmed.
 *
 * @param string $action 'add' or 'delete'
 * @param string $region
 * @return string
 */
function events_admin_region_action_url($action, $region = '')
{
    $url = "index.php?module=events&amp;action=settings&amp;region_action=" . $action;

    if($region !== '')
    {
        $url .= "&amp;region=" . urlencode($region);
    }

    return $url;
}

/**
 * Handle an add or delete, or render the page that asks for confirmation.
 *
 * @return bool true when this request was an add or a delete, and the settings form
 *              should not be rendered
 */
function events_admin_region_action()
{
    global $mybb, $page;

    $action = $mybb->get_input('region_action');

    if($action !== 'add' && $action !== 'delete')
    {
        return false;
    }

    $errors = array();

    if($mybb->request_method == "post")
    {
        // Both of these change data from a link the admin followed, so the post key is
        // checked rather than taken on trust.
        if(!verify_post_check($mybb->get_input('my_post_key'), true))
        {
            $errors[] = "That form has expired. Please try again.";
        }
        elseif($action === 'add')
        {
            $name = trim($mybb->get_input('region_add_name'));

            if(events_admin_add_region($name, $errors))
            {
                flash_message("\"" . htmlspecialchars_uni($name) . "\" added.", "success");
                admin_redirect("index.php?module=events&action=settings");
            }
        }
        else
        {
            $region = $mybb->get_input('region');
            $moved = events_admin_delete_region($region, $mybb->get_input('region_move_to'), $errors, $thread_errors);

            if($moved !== false)
            {
                $message = "\"" . htmlspecialchars_uni($region) . "\" deleted.";
                if($moved > 0)
                {
                    $message .= " " . $moved . " " . ($moved === 1 ? "event was" : "events were") . " moved to \""
                        . htmlspecialchars_uni($mybb->get_input('region_move_to')) . "\".";
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
        }
    }

    if($errors)
    {
        $page->output_inline_error($errors);
    }

    if($action === 'add')
    {
        events_admin_output_region_add_page();
    }
    else
    {
        events_admin_output_region_delete_page($mybb->get_input('region'));
    }

    return true;
}

/**
 * The scriptless "add a region" page, and where a modal that failed validation lands.
 */
function events_admin_output_region_add_page()
{
    global $mybb;

    $form = new Form("index.php?module=events&amp;action=settings", "post");
    echo $form->generate_hidden_field("region_action", "add");

    $container = new FormContainer("Add Region");
    $container->output_row("Region Name",
        "Events filed under it can be created as soon as it exists. Which forum its announcements go to is set on the settings page.",
        $form->generate_text_box("region_add_name", $mybb->get_input('region_add_name'), array("id" => "region_add_name")),
        "region_add_name");
    $container->end();

    $form->output_submit_wrapper(array(
        $form->generate_submit_button("Add Region"),
        '<a href="index.php?module=events&amp;action=settings" class="button">Cancel</a>',
    ));
    $form->end();
}

/**
 * The scriptless "delete a region" page, and where a modal that failed validation lands.
 *
 * It asks both questions at once - are you sure, and where do its events go - rather
 * than stepping through them the way the modal does, because without a script each step
 * is another page load and the second question is the whole point of the first.
 *
 * @param string $region
 */
function events_admin_output_region_delete_page($region)
{
    $regions = events_regions();

    if(!in_array($region, $regions, true))
    {
        flash_message("There is no region by that name. It may already have been deleted.", "error");
        admin_redirect("index.php?module=events&action=settings");
    }

    $counts = events_admin_region_event_counts();
    $count = isset($counts[$region]) ? (int)$counts[$region] : 0;

    $form = new Form("index.php?module=events&amp;action=settings", "post");
    echo $form->generate_hidden_field("region_action", "delete");
    echo $form->generate_hidden_field("region", $region);

    $container = new FormContainer("Delete " . htmlspecialchars_uni($region));
    $container->output_row("Are you sure?",
        $count === 0
            ? "No events are associated with this region, so nothing else changes."
            : events_admin_region_event_phrase($count) . " associated with this region, and will move to the region chosen below.",
        "Deleting \"" . htmlspecialchars_uni($region) . "\" cannot be undone.");

    if($count > 0)
    {
        $choices = array();
        foreach($regions as $other)
        {
            if($other !== $region)
            {
                // generate_select_box() interpolates both the value and the label
                // straight into the markup, and a region name is free text.
                $choices[htmlspecialchars_uni($other)] = htmlspecialchars_uni($other);
            }
        }

        $container->output_row("Move Its Events To", "",
            $form->generate_select_box("region_move_to", $choices, '', array("id" => "region_move_to")),
            "region_move_to");
    }

    $container->end();

    $form->output_submit_wrapper(array(
        $form->generate_submit_button($count > 0 ? "Move Them and Delete" : "Delete Region"),
        '<a href="index.php?module=events&amp;action=settings" class="button">Cancel</a>',
    ));
    $form->end();
}

/**
 * Render the region list onto the settings form.
 *
 * A region is one row: its name, the forum its events are announced in, and an X that
 * starts a deletion. The name and the forum are saved with the rest of the settings;
 * the X is its own action.
 *
 * The forum sits on the row rather than in a list of "<Region> Event Forum" rows of its
 * own, because it is a property of the region and reads as one - and because the two
 * lists could otherwise drift apart on screen the moment a board had more than a
 * handful of regions.
 *
 * The count of events filed under the region is on the row too: "delete this" is a very
 * different decision with eleven events behind it than with none, and the admin should
 * not have to go and count them.
 *
 * @param Form $form
 * @param array $rows          From events_admin_region_rows()
 * @param array $counts        From events_admin_region_event_counts()
 * @param array $forum_choices forum id => name, with '' => 'None' at the front
 */
function events_admin_output_region_rows($form, array $rows, array $counts, array $forum_choices)
{
    $container = new FormContainer("Regions");

    foreach($rows as $index => $row)
    {
        $original = $row['original'];
        $count = isset($counts[$original]) ? (int)$counts[$original] : 0;

        $delete = '<a href="' . events_admin_region_action_url('delete', $original) . '"'
            . ' class="events_region_delete" id="events_region_delete_' . $index . '"'
            . ' data-region="' . htmlspecialchars_uni($original) . '" data-events="' . $count . '"'
            . ' title="Delete ' . htmlspecialchars_uni($original) . '"'
            . ' aria-label="Delete ' . htmlspecialchars_uni($original) . '">&times;</a>';

        // Keyed by the row, like the name box beside it, and not by the region's name:
        // see events_admin_region_rows().
        $forum = $form->generate_select_box("event_forums[" . $index . "]",
            $forum_choices, $row['forum'], array("id" => "region_forum_" . $index));

        $content = '<span class="events_region_row">'
            . $form->generate_hidden_field("region_original[" . $index . "]", $original)
            . $form->generate_text_box("region_name[" . $index . "]", $row['name'], array("id" => "region_name_" . $index))
            . '<span class="events_region_forum">' . $forum . '</span>'
            . $delete
            . '</span>';

        // Only the count goes on the row. What the forum beside it does is explained
        // once, on the default it falls back to - repeating it under every region turns
        // the list into a wall of the same sentence.
        // output_row() writes its title into the markup as-is.
        $container->output_row(htmlspecialchars_uni($original),
            $count === 0 ? "No events are associated with this region." : events_admin_region_event_phrase($count) . " associated with this region.",
            $content, "region_name_" . $index);
    }

    $container->output_row("", "",
        '<a href="' . events_admin_region_action_url('add') . '" class="button events_region_add" id="events_region_add">Add Region</a>');

    $container->end();
}

/**
 * The confirmation dialog the X and the Add Region button open, and the script that
 * drives it.
 *
 * Emitted after the settings form has been closed, because it carries a form of its own
 * and HTML has no nested forms - and because what it posts has nothing to do with the
 * settings the admin may have half-edited above it.
 *
 * With no script none of this runs: `hidden` keeps the dialog out of the page, and the
 * controls that would have opened it are the links they always were.
 *
 * @param array $rows   From events_admin_region_rows()
 * @param array $counts From events_admin_region_event_counts()
 */
function events_admin_output_region_modals(array $rows, array $counts)
{
    global $mybb;

    $regions = array();
    foreach($rows as $row)
    {
        $regions[] = $row['original'];
    }

    $names = json_encode($regions);
    $post_key = htmlspecialchars_uni($mybb->post_code);
    $action = "index.php?module=events&amp;action=settings";

    echo <<<HTML
<div class="events_modal" id="events_region_modal" hidden>
<div class="events_modal_backdrop" data-events-modal-dismiss="1"></div>
<form class="events_modal_card" method="post" action="{$action}" id="events_region_modal_form"
      role="dialog" aria-modal="true" aria-labelledby="events_region_modal_title">
<input type="hidden" name="my_post_key" value="{$post_key}" />
<input type="hidden" name="region_action" value="delete" id="events_region_modal_action" />
<input type="hidden" name="region" value="" id="events_region_modal_region" />
<h3 class="events_modal_title" id="events_region_modal_title">Delete region</h3>
<div class="events_modal_body">
<p class="events_modal_message" id="events_region_modal_message"></p>
<p class="events_modal_field" id="events_region_modal_move" hidden>
<label for="events_region_modal_move_to">Move its events to</label>
<select name="region_move_to" id="events_region_modal_move_to"></select>
</p>
<p class="events_modal_field" id="events_region_modal_add_field" hidden>
<label for="events_region_modal_name">Region name</label>
<input type="text" name="region_add_name" value="" id="events_region_modal_name" maxlength="64" />
</p>
</div>
<div class="events_modal_actions">
<button type="button" class="button events_modal_cancel" data-events-modal-dismiss="1">Cancel</button>
<button type="submit" class="button events_modal_submit" id="events_region_modal_submit">Yes, delete it</button>
</div>
</form>
</div>
<script type="text/javascript">
(function () {
    var modal = document.getElementById('events_region_modal');
    var form = document.getElementById('events_region_modal_form');
    if (!modal || !form) { return; }

    // The list is rendered in rather than read back off the rows, so that the
    // destination dropdown offers the regions as the server currently has them rather
    // than as the admin has half-renamed them in boxes they have not saved yet.
    var regions = {$names};

    var title = document.getElementById('events_region_modal_title');
    var message = document.getElementById('events_region_modal_message');
    var moveField = document.getElementById('events_region_modal_move');
    var moveTo = document.getElementById('events_region_modal_move_to');
    var addField = document.getElementById('events_region_modal_add_field');
    var addName = document.getElementById('events_region_modal_name');
    var actionField = document.getElementById('events_region_modal_action');
    var regionField = document.getElementById('events_region_modal_region');
    var submit = document.getElementById('events_region_modal_submit');

    var state = { action: 'delete', region: '', events: 0, step: '' };
    var opener = null;

    function open(step) {
        state.step = step;
        moveField.hidden = step !== 'move';
        addField.hidden = step !== 'add';

        modal.hidden = false;

        // Focus the thing being asked about, so the dialog is usable from the keyboard
        // and a screen reader lands inside it rather than back at the top of the page.
        var focus = step === 'move' ? moveTo : (step === 'add' ? addName : submit);
        focus.focus();
    }

    function close() {
        modal.hidden = true;
        if (opener) { opener.focus(); }
        opener = null;
    }

    function openDelete(region, events) {
        state = { action: 'delete', region: region, events: events, step: '' };
        actionField.value = 'delete';
        regionField.value = region;
        addName.value = '';

        title.textContent = 'Delete ' + region;
        message.textContent = events === 0
            ? 'Are you sure you want to delete "' + region + '"? No events are associated with this region.'
            // Worded exactly as the scriptless confirmation page this modal stands in
            // for: the two describe the same deletion, and the suite asserts both.
            : 'Are you sure you want to delete "' + region + '"? ' + events
              + (events === 1 ? ' event is' : ' events are') + ' associated with this region.';
        submit.textContent = 'Yes, delete it';

        open('confirm');
    }

    // The second step, and only for a region that has events: where they go. Nothing is
    // deleted until this has an answer, which is the whole reason the flow has two steps.
    function askWhereEventsGo() {
        moveTo.innerHTML = '';
        for (var i = 0; i < regions.length; i++) {
            if (regions[i] === state.region) { continue; }
            var option = document.createElement('option');
            option.value = regions[i];
            option.textContent = regions[i];
            moveTo.appendChild(option);
        }

        title.textContent = 'Move its events';
        message.textContent = state.events + (state.events === 1 ? ' event is' : ' events are')
            + ' filed under "' + state.region + '". Choose where ' + (state.events === 1 ? 'it goes' : 'they go') + '.';
        submit.textContent = 'Move and delete';

        open('move');
    }

    function openAdd() {
        state = { action: 'add', region: '', events: 0, step: '' };
        actionField.value = 'add';
        regionField.value = '';
        addName.value = '';

        title.textContent = 'Add region';
        message.textContent = 'Events can be filed under it as soon as it exists.';
        submit.textContent = 'Add region';

        open('add');
    }

    document.addEventListener('click', function (event) {
        var target = event.target;

        if (target.closest('[data-events-modal-dismiss]')) {
            event.preventDefault();
            close();
            return;
        }

        var remove = target.closest('.events_region_delete');
        if (remove) {
            event.preventDefault();
            opener = remove;
            openDelete(remove.getAttribute('data-region'), parseInt(remove.getAttribute('data-events'), 10) || 0);
            return;
        }

        var add = target.closest('.events_region_add');
        if (add) {
            event.preventDefault();
            opener = add;
            openAdd();
        }
    });

    form.addEventListener('submit', function (event) {
        // "Yes, delete it" on a region with events is a step forward, not the deletion:
        // the events have nowhere to go yet.
        if (state.step === 'confirm' && state.events > 0) {
            event.preventDefault();
            askWhereEventsGo();
            return;
        }

        if (state.step === 'add' && addName.value.replace(/^\s+|\s+$/g, '') === '') {
            event.preventDefault();
            addName.focus();
        }
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !modal.hidden) {
            close();
        }
    });
})();
</script>

HTML;
}

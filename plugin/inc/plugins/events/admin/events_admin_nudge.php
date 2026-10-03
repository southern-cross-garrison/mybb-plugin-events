<?php
/**
 * MyBB Event Plugin - Nudging a member from the Reports tab
 *
 * A drafted message encouraging a member back out trooping, which the admin edits and
 * then either sends as a PM or copies to post somewhere else. The draft is plain text
 * rather than MyCode so that what is copied reads the same in a chat app as it does in a
 * PM: MyBB links a bare URL by itself.
 *
 * Each People row carries a Nudge link to a page of its own, which is what the link falls
 * back to with the script off and where a dialog that failed to send lands. The dialog is
 * an enhancement that intercepts the click, as the region controls' is.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";
require_once MYBB_ROOT . "inc/plugins/events/inc/events_attendance.php";

/**
 * @return string
 */
function events_nudge_default_subject()
{
    return "Come trooping with us";
}

/**
 * Each member's last troop, over everything counted rather than the report's filters: a
 * draft that says "your last troop was" must not name one they have since outdone.
 *
 * @param array $uids
 * @return array uid => array(id, title, start_date)
 */
function events_nudge_last_troops(array $uids)
{
    global $db;

    $uids = array_filter(array_map('intval', $uids));
    if(empty($uids))
    {
        return array();
    }

    $last = array();
    $query = $db->query("
        SELECT a.user_id, e.id, e.title, e.start_date
        FROM " . events_attendance_from() . "
        WHERE a.user_id IN (" . implode(',', $uids) . ")
        ORDER BY e.start_date DESC, e.id DESC
    ");
    while($row = $db->fetch_array($query))
    {
        if(!isset($last[(int)$row['user_id']]))
        {
            $last[(int)$row['user_id']] = $row;
        }
    }

    return $last;
}

/**
 * The live events still taking signups, soonest first - read once for a page of members
 * and narrowed per member by events_nudge_events_for().
 *
 * @param int $limit
 * @return array Event rows
 */
function events_nudge_open_events($limit = 10)
{
    global $db;

    // A wall clock in the event timezone, like the columns it is compared with.
    $now = $db->escape_string(events_date('Y-m-d H:i:s', TIME_NOW));

    $events = array();
    $query = $db->simple_select("event_plugin_events", "*",
        "status = 'live' AND end_date > '{$now}'",
        array('order_by' => 'start_date', 'order_dir' => 'ASC', 'limit' => (int)$limit));
    while($event = $db->fetch_array($query))
    {
        // A nudge is a call back out trooping, and a social event is not a troop.
        if(!events_is_social($event))
        {
            $events[] = $event;
        }
    }

    return $events;
}

/**
 * Which of those events to suggest to one member: ones they can see, can still sign up
 * to, and have not signed up to already.
 *
 * @param array $events From events_nudge_open_events()
 * @param int $uid
 * @param int $limit
 * @return array
 */
function events_nudge_events_for(array $events, $uid, $limit = 3)
{
    global $db;

    if(empty($events))
    {
        return array();
    }

    $ids = array();
    foreach($events as $event)
    {
        $ids[] = (int)$event['id'];
    }

    $signed_up = array();
    $query = $db->simple_select("event_plugin_rsvps", "DISTINCT event_id",
        "user_id = " . (int)$uid . " AND event_id IN (" . implode(',', $ids) . ")");
    while($row = $db->fetch_array($query))
    {
        $signed_up[(int)$row['event_id']] = true;
    }

    $suggested = array();
    foreach($events as $event)
    {
        if(isset($signed_up[(int)$event['id']]) || !events_can_view_event($event, $uid) || !events_can_sign_up($event, $uid))
        {
            continue;
        }

        $suggested[] = $event;
        if(count($suggested) >= $limit)
        {
            break;
        }
    }

    return $suggested;
}

/**
 * The drafted message.
 *
 * @param array $user The recipient's users row
 * @param array|null $last_troop From events_nudge_last_troops()
 * @param array $events From events_nudge_events_for()
 * @param string $sender_name
 * @return string Plain text, unescaped
 */
function events_nudge_draft(array $user, $last_troop, array $events, $sender_name)
{
    global $mybb;

    $message = "Hi " . $user['username'] . ",\n\n";

    if($last_troop)
    {
        $message .= "Your last troop with us was " . $last_troop['title'] . " on "
            . events_format_date($last_troop['start_date'], $mybb->settings['dateformat'])
            . ", and we'd love to see you out with us again.\n\n";
    }
    else
    {
        $message .= "We'd love to see you out trooping with us.\n\n";
    }

    if($events)
    {
        $message .= "Here's what's coming up:\n";
        foreach($events as $event)
        {
            // Asked as the recipient: the admin may read threads in a forum they cannot.
            $message .= "- " . $event['title'] . ", "
                . events_format_date($event['start_date'], $mybb->settings['dateformat'])
                . ": " . $mybb->settings['bburl'] . "/" . events_event_url($event, (int)$user['uid']) . "\n";
        }
    }
    else
    {
        $message .= "Everything coming up is on the events page: " . $mybb->settings['bburl'] . "/events.php\n";
    }

    $message .= "\nHope to see you there!\n" . $sender_name;

    return $message;
}

/**
 * The Nudge link for each member on a page of the People view, keyed by uid. A deleted
 * member has nobody to nudge and gets none.
 *
 * @param array $rows From events_attendance_report('people', ...)
 * @param string $report_url The report as it is filtered, escaped for HTML
 * @return array uid => HTML
 */
function events_admin_nudge_links(array $rows, $report_url)
{
    global $mybb;

    $uids = array();
    foreach($rows as $row)
    {
        if($row['username'] !== null && $row['username'] !== '')
        {
            $uids[] = (int)$row['user_id'];
        }
    }

    if(empty($uids))
    {
        return array();
    }

    $last = events_nudge_last_troops($uids);
    $open = events_nudge_open_events();

    $links = array();
    foreach($uids as $uid)
    {
        $user = get_user($uid);
        if(!$user)
        {
            continue;
        }

        $draft = events_nudge_draft($user, isset($last[$uid]) ? $last[$uid] : null,
            events_nudge_events_for($open, $uid), $mybb->user['username']);

        $links[$uid] = '<a href="' . $report_url . '&amp;nudge=' . $uid . '" class="events_nudge"'
            . ' id="events_nudge_' . $uid . '"'
            . ' data-uid="' . $uid . '"'
            . ' data-username="' . htmlspecialchars_uni($user['username']) . '"'
            . ' data-draft="' . str_replace("\n", "&#10;", htmlspecialchars_uni($draft)) . '"'
            . ' data-pm-blocked="' . htmlspecialchars_uni(events_pm_block_reason($user, (int)$mybb->user['uid'])) . '"'
            . '>Nudge&hellip;</a>';
    }

    return $links;
}

/**
 * Send the nudge, or render the page that drafts it.
 *
 * @param string $return_url The report to go back to, unescaped
 * @return bool true when this request was a nudge, and the report should not be rendered
 */
function events_admin_nudge_action($return_url)
{
    global $mybb, $page;

    if(!isset($mybb->input['nudge']))
    {
        return false;
    }

    $user = get_user($mybb->get_input('nudge', MyBB::INPUT_INT));
    if(!$user)
    {
        flash_message("That member no longer exists.", "error");
        admin_redirect($return_url);
    }

    $blocked = events_pm_block_reason($user, (int)$mybb->user['uid']);
    $errors = array();

    if($mybb->request_method == "post")
    {
        $subject = trim($mybb->get_input('nudge_subject'));
        // A textarea submits CRLF, and the draft it started from is LF.
        $message = trim(str_replace("\r\n", "\n", $mybb->get_input('nudge_message')));

        if(!verify_post_check($mybb->get_input('my_post_key'), true))
        {
            $errors[] = "That form has expired. Please try again.";
        }
        // Asked again rather than trusted from the page: the member may have turned PMs
        // off since it was drawn, and the button is only disabled in the browser.
        elseif($blocked !== '')
        {
            $errors[] = htmlspecialchars_uni($blocked);
        }
        elseif(events_nudge_send_pm($user, $subject, $message, $errors))
        {
            flash_message("Private message sent to " . htmlspecialchars_uni($user['username']) . ".", "success");
            admin_redirect($return_url);
        }
    }
    else
    {
        $subject = events_nudge_default_subject();
        $last = events_nudge_last_troops(array((int)$user['uid']));
        $message = events_nudge_draft($user, isset($last[(int)$user['uid']]) ? $last[(int)$user['uid']] : null,
            events_nudge_events_for(events_nudge_open_events(), (int)$user['uid']), $mybb->user['username']);
    }

    if($errors)
    {
        $page->output_inline_error($errors);
    }

    events_admin_output_nudge_page($user, $subject, $message, $blocked, $return_url);

    return true;
}

/**
 * @param array $user
 * @param string $subject
 * @param string $message
 * @param array $errors Filled with MyBB's own reasons when it refuses the PM, escaped
 * @return bool
 */
function events_nudge_send_pm(array $user, $subject, $message, array &$errors)
{
    $pmhandler = events_member_pm($user, $subject, $message, $errors);
    if(!$pmhandler)
    {
        return false;
    }

    $pmhandler->insert_pm();
    return true;
}

/**
 * The scriptless nudge page, and where a dialog that failed to send lands.
 *
 * It has no Copy button: that needs the script, and the message is in a box the admin can
 * select and copy from without one.
 *
 * @param array $user
 * @param string $subject
 * @param string $message
 * @param string $blocked From events_pm_block_reason()
 * @param string $return_url Unescaped
 */
function events_admin_output_nudge_page(array $user, $subject, $message, $blocked, $return_url)
{
    $return = htmlspecialchars_uni($return_url);

    $form = new Form($return, "post");
    echo $form->generate_hidden_field("nudge", (int)$user['uid']);

    $container = new FormContainer("Nudge " . htmlspecialchars_uni($user['username']));

    if($blocked !== '')
    {
        $container->output_row("", "", '<div class="alert" id="events_nudge_page_blocked">' . htmlspecialchars_uni($blocked) . '</div>');
    }
    else
    {
        $container->output_row("Subject", "", $form->generate_text_box("nudge_subject", $subject, array("id" => "nudge_subject", "maxlength" => 85, "class" => "events_nudge_subject")), "nudge_subject");
    }

    $container->output_row("Message", "", $form->generate_text_area("nudge_message", $message, array("id" => "nudge_message", "rows" => 14, "class" => "events_nudge_message")), "nudge_message");
    $container->end();

    $buttons = array();
    if($blocked === '')
    {
        $buttons[] = $form->generate_submit_button("Send PM", array("id" => "nudge_send"));
    }
    $buttons[] = '<a href="' . $return . '" class="button">Cancel</a>';

    $form->output_submit_wrapper($buttons);
    $form->end();
}

/**
 * The dialog each Nudge link opens, and the script that drives it. Emitted after the
 * People table; with no script it stays `hidden` and the links go to the page above.
 *
 * @param string $report_url The report as it is filtered, escaped for HTML
 */
function events_admin_output_nudge_modal($report_url)
{
    global $mybb;

    $post_key = htmlspecialchars_uni($mybb->post_code);
    $subject = htmlspecialchars_uni(events_nudge_default_subject());

    echo <<<HTML
<div class="events_modal" id="events_nudge_modal" hidden>
<div class="events_modal_backdrop" data-events-modal-dismiss="1"></div>
<form class="events_nudge_dialog" method="post" action="{$report_url}" id="events_nudge_form"
      role="dialog" aria-modal="true" aria-labelledby="events_nudge_title">
<input type="hidden" name="my_post_key" value="{$post_key}" />
<input type="hidden" name="nudge" value="" id="events_nudge_uid" />
<div class="border_wrapper">
<div class="title" id="events_nudge_title">Nudge</div>
<table class="general form_container" cellspacing="0">
<tbody>
<tr id="events_nudge_blocked_row" hidden>
<td class="first"><div class="alert" id="events_nudge_blocked"></div></td>
</tr>
<tr id="events_nudge_subject_field">
<td class="first"><label for="events_nudge_subject">Subject</label>
<div class="form_row"><input type="text" name="nudge_subject" value="{$subject}" id="events_nudge_subject" class="text_input" maxlength="85" /></div></td>
</tr>
<tr class="alt_row">
<td class="first"><label for="events_nudge_message">Message</label>
<div class="form_row"><textarea name="nudge_message" id="events_nudge_message" class="events_nudge_message" rows="14"></textarea></div></td>
</tr>
</tbody>
</table>
</div>
<div class="form_button_wrapper">
<input type="submit" value="Send PM" class="submit_button" id="events_nudge_send" />
<input type="button" value="Copy" class="submit_button" id="events_nudge_copy" />
<input type="button" value="Cancel" class="submit_button" data-events-modal-dismiss="1" />
</div>
</form>
</div>
<script type="text/javascript">
(function () {
    var modal = document.getElementById('events_nudge_modal');
    var form = document.getElementById('events_nudge_form');
    if (!modal || !form) { return; }

    var title = document.getElementById('events_nudge_title');
    var uid = document.getElementById('events_nudge_uid');
    var blockedRow = document.getElementById('events_nudge_blocked_row');
    var blocked = document.getElementById('events_nudge_blocked');
    var subjectField = document.getElementById('events_nudge_subject_field');
    var subject = document.getElementById('events_nudge_subject');
    var message = document.getElementById('events_nudge_message');
    var copy = document.getElementById('events_nudge_copy');
    var send = document.getElementById('events_nudge_send');
    var defaultSubject = subject.value;
    var opener = null;
    var copiedTimer = null;

    function open(link) {
        opener = link;
        var reason = link.getAttribute('data-pm-blocked') || '';

        title.textContent = 'Nudge ' + link.getAttribute('data-username');
        uid.value = link.getAttribute('data-uid');
        subject.value = defaultSubject;
        message.value = link.getAttribute('data-draft');

        blocked.textContent = reason;
        blockedRow.hidden = reason === '';
        subjectField.hidden = reason !== '';
        send.disabled = reason !== '';
        copy.value = 'Copy';

        modal.hidden = false;
        message.focus();
        message.setSelectionRange(0, 0);
        message.scrollTop = 0;
    }

    function close() {
        modal.hidden = true;
        if (opener) { opener.focus(); }
        opener = null;
    }

    function copied() {
        copy.value = 'Copied';
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(function () { copy.value = 'Copy'; }, 2000);
    }

    // The clipboard API needs a secure context, and an Admin CP on plain http is not one;
    // selecting the box and copying from it works either way.
    function copyByCommand() {
        message.focus();
        message.select();
        try {
            if (document.execCommand('copy')) { copied(); }
        } catch (e) {}
    }

    copy.addEventListener('click', function () {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(message.value).then(copied, copyByCommand);
        } else {
            copyByCommand();
        }
    });

    document.addEventListener('click', function (event) {
        var target = event.target;

        if (!modal.hidden && target.closest('[data-events-modal-dismiss]')) {
            event.preventDefault();
            close();
            return;
        }

        var link = target.closest('.events_nudge');
        if (link) {
            event.preventDefault();
            open(link);
        }
    });

    form.addEventListener('submit', function (event) {
        if (send.disabled) { event.preventDefault(); }
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

<?php
/**
 * MyBB Event Plugin - A coordinator removing somebody's signup
 *
 * Each row of the card's signup list and waitlist carries an X for whoever can manage the
 * event. It opens a dialog with a drafted message to the member, which the coordinator
 * edits and then sends as a PM, copies to send some other way, or leaves unsent; any of
 * the three removes the signup, and Cancel leaves it where it is. A member who cannot be
 * sent a PM from the coordinator (events_pm_block_reason()) is offered only the other two.
 *
 * The X is a link to a page of its own, which is what it falls back to with the script
 * off and where a dialog whose PM was refused lands. The dialog is an enhancement that
 * intercepts the click, as the nudge's is. The draft is plain text for the same reason
 * the nudge's is: what is copied reads the same in a chat app as it does in a PM.
 *
 * Removing is the whole signup - every role and every day - the same write as the member
 * withdrawing themselves, so a place it frees goes to the next on the waitlist.
 */

if(!defined("IN_MYBB"))
{
    die("Direct initialization of this file is not allowed.");
}

require_once MYBB_ROOT . "inc/plugins/events/inc/events_functions.php";

/**
 * @param array $event
 * @return string Unescaped
 */
function events_remove_signup_subject(array $event)
{
    $subject = "Removed from: " . $event['title'];
    if(my_strlen($subject) > 85)
    {
        $subject = my_substr($subject, 0, 82) . "...";
    }

    return $subject;
}

/**
 * The drafted message, with a blank line for the reason in the middle of it.
 *
 * @param array $event
 * @param array $user The recipient's users row
 * @param string $sender_name
 * @return array (before, after) - plain text, unescaped, split where the reason goes
 */
function events_remove_signup_draft(array $event, array $user, $sender_name)
{
    global $mybb;

    $before = "Hi " . $user['username'] . ",\n\n"
        . "I've taken you off the signup list for " . $event['title'] . " on "
        . events_format_date($event['start_date'], $mybb->settings['dateformat']) . ".\n\n";

    return array($before, "\n\n" . $sender_name);
}

/**
 * Take a member's whole signup off an event, and PM whoever that moves up the waitlist.
 *
 * Read and written under the event's signup lock, like any other change to its signups:
 * two coordinators removing the same member, or the member updating their signup at the
 * same moment, find the signup as the other left it.
 *
 * @param int $event_id
 * @param int $user_id The member being removed
 * @param int $by_uid Who is removing them, who the waitlist PMs come from
 * @return bool|string true once removed, 'none' if they held no signup, false if the lock
 *                     could not be had
 */
function events_remove_signup($event_id, $user_id, $by_uid)
{
    $event_id = (int)$event_id;
    $lock = events_signup_lock($event_id);

    if(!events_acquire_lock($lock))
    {
        return false;
    }

    if(empty(events_get_user_signup($event_id, (int)$user_id)))
    {
        events_release_lock($lock);
        return 'none';
    }

    events_write_signup($event_id, (int)$user_id, array(), array());
    $moves = events_rebalance_waitlist($event_id);
    events_release_lock($lock);

    events_send_waitlist_pms($event_id, $moves, (int)$by_uid, (int)$user_id);

    return true;
}

/**
 * The X on a signup list row.
 *
 * @param array $event
 * @param array $user The member's users row
 * @return string HTML
 */
function events_remove_signup_link(array $event, array $user)
{
    global $mybb;

    $uid = (int)$user['uid'];
    list($before, $after) = events_remove_signup_draft($event, $user, $mybb->user['username']);
    $username = htmlspecialchars_uni($user['username']);

    return '<a href="event.php?id=' . (int)$event['id'] . '&amp;action=remove_signup&amp;uid=' . $uid . '"'
        . ' class="rsvp_remove no-print" title="Remove ' . $username . '" aria-label="Remove ' . $username . '"'
        . ' data-uid="' . $uid . '"'
        . ' data-username="' . $username . '"'
        // In two halves, so the script can leave the cursor where the reason goes.
        . ' data-draft-before="' . str_replace("\n", "&#10;", htmlspecialchars_uni($before)) . '"'
        . ' data-draft-after="' . str_replace("\n", "&#10;", htmlspecialchars_uni($after)) . '"'
        . ' data-pm-blocked="' . htmlspecialchars_uni(events_pm_block_reason($user, (int)$mybb->user['uid'])) . '"'
        . '>&times;</a>';
}

/**
 * Remove the signup a posted form asks for, or say why not.
 *
 * With 'pm', the PM is validated before anything is removed and sent after, so a PM the
 * board refuses leaves the member on the event rather than dropped without a word.
 *
 * @param array $event
 * @param array $user The member being removed
 * @param string $notify pm, copy or none
 * @param string $subject
 * @param string $message
 * @param array $errors Filled when nothing was removed, escaped
 * @return bool
 */
function events_remove_signup_submit(array $event, array $user, $notify, $subject, $message, array &$errors)
{
    global $mybb;

    $pmhandler = null;
    if($notify === 'pm')
    {
        // Asked again rather than trusted from the page: the member may have turned PMs
        // off since it was drawn.
        $blocked = events_pm_block_reason($user, (int)$mybb->user['uid']);
        if($blocked !== '')
        {
            $errors[] = htmlspecialchars_uni($blocked);
            return false;
        }

        $pmhandler = events_member_pm($user, $subject, $message, $errors);
        if(!$pmhandler)
        {
            return false;
        }
    }

    $removed = events_remove_signup($event['id'], $user['uid'], $mybb->user['uid']);
    if($removed === false)
    {
        $errors[] = "The event is busy. Please try again.";
        return false;
    }
    if($removed === 'none')
    {
        $errors[] = htmlspecialchars_uni($user['username']) . " is not signed up to this event.";
        return false;
    }

    if($pmhandler)
    {
        $pmhandler->insert_pm();
    }

    $how = array('pm' => 'sent a PM', 'copy' => 'copied a message to send', 'none' => 'without notifying them');
    events_log_action('remove_signup', array($event['id'], $event['title'], $user['username'], $how[$notify]));

    return true;
}

/**
 * The page the X falls back to with the script off, and where a refused dialog lands.
 *
 * It has no Copy: that needs the script, and the message is in a box the coordinator can
 * select and copy from without one.
 *
 * @param array $event
 * @param array $user
 * @param string $subject
 * @param string $message
 * @param array $errors Escaped
 * @return string HTML for the events_remove_signup template's form
 */
function events_remove_signup_page_form(array $event, array $user, $subject, $message, array $errors)
{
    global $mybb;

    $event_id = (int)$event['id'];
    $blocked = events_pm_block_reason($user, (int)$mybb->user['uid']);

    $html = '';
    if($errors)
    {
        $html .= inline_error($errors);
    }

    $html .= '<form method="post" action="event.php?id=' . $event_id . '&amp;action=remove_signup" id="remove_signup_form">'
        . '<input type="hidden" name="my_post_key" value="' . htmlspecialchars_uni($mybb->post_code) . '" />'
        . '<input type="hidden" name="uid" value="' . (int)$user['uid'] . '" />';

    if($blocked !== '')
    {
        $html .= '<p class="events_notice" id="remove_signup_blocked">' . htmlspecialchars_uni($blocked) . '</p>';
    }
    else
    {
        $html .= '<label class="events_label" for="remove_signup_subject">Subject</label>'
            . '<input type="text" class="events_input" name="remove_subject" id="remove_signup_subject" maxlength="85" value="' . htmlspecialchars_uni($subject) . '" />';
    }

    $html .= '<label class="events_label" for="remove_signup_message">Message</label>'
        . '<textarea class="events_input events_textarea" name="remove_message" id="remove_signup_message" rows="10">' . htmlspecialchars_uni($message) . '</textarea>'
        . '<div class="events_remove_actions">';

    if($blocked === '')
    {
        $html .= '<span class="events_split">'
            . '<button type="submit" class="events_split_main" name="notify" value="pm" id="remove_signup_send">Send PM &amp; Remove</button>'
            . '<details class="events_split_menu"><summary class="events_split_toggle" aria-label="More ways to remove"></summary>'
            . '<span class="events_split_list">'
            . '<button type="submit" name="notify" value="none" id="remove_signup_silent">Remove Without Notifying</button>'
            . '</span></details></span>';
    }
    else
    {
        $html .= '<button type="submit" class="event_action event_action_primary" name="notify" value="none" id="remove_signup_silent">Remove Without Notifying</button>';
    }

    $html .= '<a href="' . events_event_url($event) . '" class="event_action event_action_secondary" id="remove_signup_cancel">Cancel</a>'
        . '</div></form>';

    return $html;
}

/**
 * The dialog each X opens, and the script that drives it. Rendered once under the signup
 * list; with no script it stays `hidden` and the links go to the page above.
 *
 * @param array $event
 * @return string HTML
 */
function events_remove_signup_dialog(array $event)
{
    global $mybb;

    $action = 'event.php?id=' . (int)$event['id'] . '&amp;action=remove_signup';
    $post_key = htmlspecialchars_uni($mybb->post_code);
    $subject = htmlspecialchars_uni(events_remove_signup_subject($event));

    return <<<HTML
<div class="events_modal no-print" id="events_remove_modal" hidden>
<div class="events_modal_backdrop" data-events-modal-dismiss="1"></div>
<form class="events_modal_card" method="post" action="{$action}" id="events_remove_form"
      role="dialog" aria-modal="true" aria-labelledby="events_remove_title">
<input type="hidden" name="my_post_key" value="{$post_key}" />
<input type="hidden" name="uid" value="" id="events_remove_uid" />
<div class="events_modal_head">
<h3 class="events_modal_title" id="events_remove_title">Remove</h3>
<button type="button" class="events_modal_close" id="events_remove_close" aria-label="Close" data-events-modal-dismiss="1">&times;</button>
</div>
<p class="events_notice" id="events_remove_blocked" hidden></p>
<div class="events_modal_field" id="events_remove_subject_field">
<label class="events_label" for="events_remove_subject">Subject</label>
<input type="text" class="events_input" name="remove_subject" id="events_remove_subject" maxlength="85" value="{$subject}" />
</div>
<div class="events_modal_field">
<label class="events_label" for="events_remove_message">Message</label>
<textarea class="events_input events_textarea" name="remove_message" id="events_remove_message" rows="9"></textarea>
</div>
<div class="events_remove_actions">
<span class="events_split">
<button type="submit" class="events_split_main" name="notify" value="pm" id="events_remove_send">Send PM &amp; Remove</button>
<button type="button" class="events_split_main" id="events_remove_copy_main" hidden>Copy Text &amp; Remove</button>
<details class="events_split_menu" id="events_remove_menu">
<summary class="events_split_toggle" aria-label="More ways to remove"></summary>
<span class="events_split_list">
<button type="button" id="events_remove_copy">Copy Text &amp; Remove</button>
<button type="submit" name="notify" value="none" id="events_remove_silent">Remove Without Notifying</button>
</span>
</details>
</span>
<button type="submit" name="notify" value="copy" id="events_remove_copied" hidden tabindex="-1"></button>
<button type="button" class="event_action event_action_secondary" id="events_remove_cancel" data-events-modal-dismiss="1">Cancel</button>
</div>
</form>
</div>
<script type="text/javascript">
(function () {
    var modal = document.getElementById('events_remove_modal');
    var form = document.getElementById('events_remove_form');
    if (!modal || !form) { return; }

    var title = document.getElementById('events_remove_title');
    var uid = document.getElementById('events_remove_uid');
    var blocked = document.getElementById('events_remove_blocked');
    var subjectField = document.getElementById('events_remove_subject_field');
    var subject = document.getElementById('events_remove_subject');
    var message = document.getElementById('events_remove_message');
    var send = document.getElementById('events_remove_send');
    var copyMain = document.getElementById('events_remove_copy_main');
    var copyItem = document.getElementById('events_remove_copy');
    var copied = document.getElementById('events_remove_copied');
    var menu = document.getElementById('events_remove_menu');
    var defaultSubject = subject.value;
    var opener = null;

    function open(link) {
        opener = link;
        var reason = link.getAttribute('data-pm-blocked') || '';
        var before = link.getAttribute('data-draft-before');

        title.textContent = 'Remove ' + link.getAttribute('data-username');
        uid.value = link.getAttribute('data-uid');
        subject.value = defaultSubject;
        message.value = before + link.getAttribute('data-draft-after');

        // A member who cannot be sent a PM is offered the other two, with Copy in front.
        blocked.textContent = reason;
        blocked.hidden = reason === '';
        subjectField.hidden = reason !== '';
        send.hidden = reason !== '';
        send.disabled = reason !== '';
        copyMain.hidden = reason === '';
        copyItem.hidden = reason !== '';
        menu.open = false;
        copyMain.textContent = copyItem.textContent = 'Copy Text & Remove';

        modal.hidden = false;
        message.focus();
        message.setSelectionRange(before.length, before.length);
        message.scrollTop = 0;
    }

    function close() {
        modal.hidden = true;
        menu.open = false;
        if (opener) { opener.focus(); }
        opener = null;
    }

    function removeAfterCopy() {
        copied.click();
    }

    function copyFailed(button) {
        button.textContent = 'Could not copy';
    }

    // The clipboard API needs a secure context, and a board on plain http is not one;
    // selecting the box and copying from it works either way. The signup is only removed
    // once the text is on the clipboard, so a failed copy loses nothing.
    function copyByCommand(button) {
        message.focus();
        message.select();
        try {
            if (document.execCommand('copy')) { removeAfterCopy(); return; }
        } catch (e) {}
        copyFailed(button);
    }

    function copyAndRemove(event) {
        var button = event.currentTarget;
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(message.value).then(removeAfterCopy, function () { copyByCommand(button); });
        } else {
            copyByCommand(button);
        }
    }

    copyMain.addEventListener('click', copyAndRemove);
    copyItem.addEventListener('click', copyAndRemove);

    document.addEventListener('click', function (event) {
        var target = event.target;

        if (!modal.hidden && target.closest('[data-events-modal-dismiss]')) {
            event.preventDefault();
            close();
            return;
        }

        if (!modal.hidden && menu.open && !target.closest('#events_remove_menu')) {
            menu.open = false;
        }

        var link = target.closest('.rsvp_remove');
        if (link) {
            event.preventDefault();
            open(link);
        }
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !modal.hidden) {
            if (menu.open) { menu.open = false; } else { close(); }
        }
    });
})();
</script>

HTML;
}

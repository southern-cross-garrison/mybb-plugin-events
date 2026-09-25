# Working on this repo

## Layout

- `plugin/` is the source of truth for the plugin. Nothing is edited inside `test-forum/`.
  It mirrors a MyBB forum root, which is how MyBB expects a plugin package to be laid out:
  deploying to real hosting is copying the contents of `plugin/` over the forum's root
  directory, and `scripts/deploy.sh` does exactly that. Anything that must not be uploaded
  to a web root (docs, tooling) stays out of `plugin/` - the plugin's documentation is
  `PLUGIN.md` for that reason.
  - `plugin/inc/plugins/events.php` - plugin metadata, install/activate/uninstall.
  - `plugin/inc/plugins/events/inc/` - shared functions, hooks, installers, render helpers.
  - `plugin/inc/plugins/events/admin/` - Admin CP module.
  - `plugin/inc/plugins/events/templates/` - templates as `.html` files; they are synced
    into MyBB's `templates` table on install/activate.
  - `plugin/inc/tasks/` - MyBB scheduled task entry points (MyBB requires a real file here).
  - `plugin/*.php` - front-end pages. MyBB pages `require ./global.php`, so these sit at
    the forum root, not under `inc/`.
  - `plugin/jscripts/events/` - assets the front end and the Admin CP share.
  - `plugin/admin/modules/events/` - Admin CP module registration.
- `test-forum/` is a disposable MyBB tree (gitignored). `scripts/bootstrap.sh` downloads the
  pinned MyBB release into it, `scripts/deploy.sh` copies the plugin in, and
  `scripts/install-theme.sh` imports the garrison's custom theme and makes it the default.
- `tests/` is the Playwright end-to-end suite; `scripts/` holds the environment tooling.

## Everyday commands

```bash
./scripts/bootstrap.sh          # bring the environment up (first run, or after a wipe)
./scripts/bootstrap.sh --fresh  # wipe test-forum/ and the database and rebuild
./scripts/deploy.sh                     # push plugin/ changes into test-forum/
npx playwright test             # run the suite
npx playwright test --ui        # run it interactively
```

After changing anything under `plugin/`, run `./scripts/deploy.sh`. After changing a template,
the stylesheet, or anything in `events_install()`/`events_activate()`, also re-run
`docker compose exec -T web php /dev/stdin < scripts/provision.php` so the plugin is
re-activated and the templates are re-synced, then `./scripts/db-snapshot.sh` so the suite's
baseline picks the change up.

## Things worth knowing

- `scripts/db-snapshot.sh` is a plain dump: it records whatever the faked clock was when
  it ran. Taking a snapshot straight after a test run bakes that run's forward clock into
  `users.lastactive`, and every later restore then starts with timestamps in the future -
  which surfaces as page views failing at random with "BIGINT UNSIGNED value is out of
  range", not as anything that points at the snapshot. Run `scripts/db-restore.sh` first
  (it resets the clock and realigns the timestamps), then re-provision, then snapshot. It
  records the run's *content* as well: the last test's threads, posts and PMs are still on
  the board when the run ends, so a snapshot taken after a run bakes them into the
  baseline that every later run starts from. Restoring first is what clears them.
- Everything runs in Docker. Log and file paths in debugging code must be container paths
  (`/var/www/html/...`); `test-forum/` on the host is the same directory.
- MyBB's `insert_query()`/`update_query()` quote values but do **not** escape them. Every
  string value must go through `$db->escape_string()` - an apostrophe in a description is
  enough to break an install.
- MyBB has no way to express SQL `NULL` through those helpers, and an empty string is not a
  valid `DATETIME` under strict mode. Nullable columns are cleared with a follow-up
  `write_query`.
- MyBB templates are eval'd double-quoted strings. `{$var}` interpolates; there are no
  conditionals or loops. Anything repeated or conditional is built in PHP and passed to the
  template as one variable.
- Front-end hooks are registered at the top of `inc/plugins/events.php` (MyBB includes active
  plugin files on every request). Registering them in `_activate()` only ever runs once.
- Front-end styling goes in `plugin/inc/plugins/events/stylesheets/events.css`, never in a
  `<style>` block in a template. It is installed as a real theme stylesheet on the master
  theme so themes inherit and can override it; an inline block would out-specify them.
- The plugin's own JavaScript is emitted inline, from `events_form.php`:
  `events_event_days_script()` keeps the event form's day rows in step with the start and
  end dates, `events_datepicker_script()` turns the date boxes into calendars, and
  `events_tag_field_script()` turns the excluded members box into a tag input that searches
  the board's members through MyBB's `xmlhttp.php?action=get_users`. Inline rather than
  served as files because the same scripts run on the front-end form and the Admin CP one,
  which are served from two different roots. Everything else is rendered by PHP, and a page
  must still work with the script turned off - each of those three enhances a control that
  posts the same thing either way, and the server validates what arrives regardless.
- An event's description is BBCode, written in MyBB's own editor on both forms
  (`build_mycode_inserter()` via `events_description_editor()`), and rendered with MyBB's
  own parser (`events_parse_description()`). The front end gets the whole editor from the
  `codebuttons` template, which carries its own stylesheet and scripts; the Admin CP half
  returns only the configuration script, so `events_admin.php` has to put sceditor in
  `$page->extra_header` *before* `output_header()` runs. Miss that and the box is a plain
  textarea with no error anywhere. Anything that shows a description has to go through the
  parser - `events_description_text()` is the plain-text pass the iCal feed needs - and the
  announcement thread carries it unescaped, unlike every other value it interpolates.
- The Preview button on both event forms is an ordinary submit that posts the form and
  comes back with it, and it carries `formnovalidate`. Without that the browser refuses to
  submit a form whose required title and dates are still empty, which is precisely when a
  description is being previewed.
- Styling for a control that appears on both forms cannot live in `events.css`: that is a
  theme stylesheet, and the Admin CP loads no theme at all. Those go in
  `plugin/jscripts/events/` as a sheet both roots link
  (`events-datepicker.css`, `events-tags.css`), tinted from the same `--events-*` custom
  properties so a theme still controls them.
- Test helpers must not probe the page with `count()` or `all()` straight after a click
  that navigates - neither auto-waits, so they read the outgoing page. `tests/helpers/rsvp.ts`
  has `settleOnStep()` for this. The race only loses on slower-loading themes, so it passes
  locally and fails where it matters.
- The test forum runs the garrison's live theme (see README), not MyBB's default. Anything
  that reaches into rendered board markup - `events_nav_menu()`, which swaps the board's
  Calendar menu item for an Events one on `pre_output_page` - has to cope with a theme that
  rewrites MyBB's header wholesale, so it matches on the Calendar link rather than on any
  one theme's container markup. The plugin's own templates are safe: they sit in the master
  template set (`sid = -2`), which every theme falls back to.
- That theme depends on the Smart Thread Link plugin for `{$thread['smartlink']}`, which is
  how its thread listings link a thread. `scripts/install-smartlink.sh` installs it and
  `scripts/provision.php` activates it. Without it the board looks fine but every thread
  subject in a forum is an `<a href="">`, so nothing a test posts - an event announcement,
  a troop report - can be reached from the forum it was posted into.
- Plugin settings are created by `events_install_settings()`, which runs from *both*
  `events_install()` and `events_activate()`. MyBB gives plugins no upgrade hook, so a
  setting added to that list only reaches an already-installed board because activation
  tops it up - the same reason `events_upgrade_database()` runs there. Existing settings
  keep their values.
- Forms use the plugin's own `.events_label` / `.events_input` / `.events_hint` /
  `.events_option` classes, never MyBB's `.form_row`, which puts the label, control and
  hint on one line and leaves the control unstyled.
- The print ribbon's logo is the one place the plugin writes an inline `style` attribute,
  and it is passing a value rather than styling: the URL goes over as a
  `--events-print-logo` custom property and `events.css` paints it as a background image
  inside `@media print`. An `<img>` would be fetched on every page view even though the
  ribbon is `display: none` on screen, `loading="lazy"` included.
- Printing is handled entirely in `events.css`, and it works by keeping `.events_page_wrap`
  and the ancestors holding it in the document and hiding every other element. That is
  deliberately blind to the theme - naming a header or a footer would not survive the next
  one - so anything that has to appear on paper must be rendered *inside* that wrapper.
  `{$events_print_header}` is there for exactly that reason, and every full-page template
  opens with it.
- Two runs of the e2e suite cannot overlap. `workers: 1` serialises tests *within* a run,
  but nothing serialised the runs themselves, and global setup restores the database and
  wipes `.devenv/auth` - so a second run (another terminal, the VS Code Playwright
  extension, a second agent session) truncates tables mid-test and deletes the login state
  the first one is about to read. It surfaces as `No cached login for <user>` or as
  assertions on rows that vanished, landing on whichever tests happened to be running, so
  the suite looks flaky and no single test looks broken. `tests/helpers/suite-lock.ts`
  holds a PID lock: `playwright.config.ts` checks it (before Playwright empties
  `outputDir`, which would otherwise take the running suite's traces with it) and global
  setup claims it. A lock left by a dead process is taken over automatically. The claim is
  atomic (the file is written whole and hard-linked into place, which fails if the name is
  taken): it used to read and then write, and sessions queued on the same pid all start the
  moment it exits, so two of them read "free" in the same second and restored the database
  at once. The config only checks, never claims - an editor's test explorer loads it to
  list tests and then idles, and a claim there would hold the suite while the editor is open.

- Never delete `.devenv/suite.lock` to get a run moving. The lock takes itself over when the
  process that wrote it is gone - `assertNoRunInFlight()` checks `isAlive(pid)` before it
  honours a lock - so a lock that is blocking you is one whose owner is *still running*, and
  removing it does precisely the damage the lock exists to prevent. If a lock ever does
  outlive its process, that is a bug in `suite-lock.ts` to fix, not to route around.

- When the lock is held, find out who holds it before doing anything else. The file carries
  the pid and the start time, and `ps -p <pid> -o pid,etime,command` says what that run is
  doing and how long it has been at it. Several agent sessions are often working in this repo
  at once, so also ask `ListAgents` which peers are alive and which are busy: a lock held by a
  session that is still working is one to wait behind, and its run may already be exercising
  the change you were about to test.

- Queue behind a held lock instead of racing it. Wait on the pid from the lock file, which
  costs nothing:

      while kill -0 <pid> 2>/dev/null; do sleep 15; done

  and then start your run. Sessions that all wait this way serialise cleanly; sessions that
  each decide the lock is stale corrupt each other's runs and their own.

- Wait on that pid, and not on `pgrep -f "playwright test"`. `-f` matches whole command
  lines, and a shell sitting in a wait loop *has that string in its own command line* - so
  every waiting session sees every other one, including itself, and none of them ever starts.
  Three sessions deadlocked on exactly this, each holding a 15-minute wait for runs that had
  already finished, while the lock sat free the whole time. It shows up as a run that never
  produces output rather than as an error. If you must match a process rather than read the
  lock, match the runner itself:

      pgrep -f "node.*\.bin/playwright"

  which matches the Playwright process and not the shells queued behind it.

- The lock only guards `npx playwright test`. It does **not** guard `scripts/db-restore.sh`,
  `scripts/db-snapshot.sh` or `scripts/provision.php`, and every one of them will wreck a run
  in flight - restoring the database mid-suite empties the tables the running tests are
  asserting on. The failures land on whoever happens to be running, not on whoever ran the
  script, so it reads as flakiness rather than as interference. Check the lock before those
  three exactly as you would before a test run.

- The region list is a setting the board edits, not a constant. `events_regions()` reads
  it, the `region` column is a `varchar` rather than the enum it shipped as, and the
  Admin CP settings page owns all three ways it changes - renaming (a box saved with the
  form), adding and deleting (each its own action, confirmed in a dialog). Every one of
  them has to keep three things in step: the list, the events filed under each name, and
  the `Region=fid` announcement-forum map, which is keyed by name too. Miss the last one
  and a rename silently stops routing that region's announcements.

- Nothing may leave an event filed under a region that is not on the list. Such an event
  is invisible to the region filter and is rejected by the event form the next time
  anybody saves it, so it reads as "the event vanished" rather than as a settings bug.
  That is the whole reason deleting a region asks where its events go first.

- The events table's `region` column is `utf8mb4_bin`, unlike every other text column.
  The region list is exact strings in PHP, and under the table's `general_ci` the database
  treated `Cafe` and `Café` as one value in every GROUP BY, WHERE and CASE the region code
  runs: renaming one dragged the other's events along, and deleting one found no events of
  its own and skipped the "where do they go" step. Keep it binary - a `CONVERT TO` over
  that table would reset it. The duplicate-name check (`mb_strtolower()`) is only there to
  stop the same place being typed twice; it does not have to agree with the database.

- The settings form writes every setting on it at once, so a save from a page opened
  before someone else's change silently reverts it - and for a region added meanwhile,
  that drops it from the list while its events stay filed under it. The form carries
  `settings_version`, a fingerprint of every row in the `events` setting group
  (`events_admin_settings_version()`), and a save whose token no longer matches is
  refused whole and sent back to a fresh form. It fingerprints the rows rather than
  keeping a counter so that region add/delete and MyBB's own settings screen are covered
  without having to remember to bump anything. A form re-rendered after a validation
  error keeps the token it was *submitted* with, not a fresh one.

- Changing a setting from a test means changing it the way the Admin CP does. MyBB serves
  `$mybb->settings` from the generated `inc/settings.php`, not from the `settings` table,
  so a row written with SQL is invisible to every page until something calls
  `rebuild_settings()`. `tests/e2e/regions.spec.ts` drives the Admin CP for exactly this
  reason, and restores the list the same way in its teardown.

- The Admin CP loads no theme stylesheet at all, so a control the plugin adds there has
  nowhere to be styled from except `plugin/jscripts/events/events-admin.css`, linked
  as `../jscripts/events/` the same way the datepicker's sheet is. `events.css` is a theme
  stylesheet and never reaches the Admin CP. That sheet goes into `$page->extra_header`
  from the module dispatcher, for every action - not echoed into the body beside the
  controls it styles, the way the datepicker's and the tag field's are. It sizes the
  description box, and sceditor builds the editor at whatever size that box has resolved
  to when the page is ready, so a stylesheet still arriving further down the body is a
  race with that measurement.

- MyBB's Admin CP stylesheet sets every `textarea` to a flat `width: 400px`. Anything the
  plugin renders there that has to be bigger than a signature box has to say so itself,
  and where the box is bound to an editor, so does the editor: sceditor copies the
  textarea's rendered size once, at init. At 400px its toolbar wrapped onto three rows
  and left a 7px editing area - which reads as a broken editor rather than as a narrow
  one. `tests/e2e/admin-events.spec.ts` asserts the editor fills its cell.

- The region X and the Add Region button are ordinary links to a confirmation page that
  asks the same questions and posts the same fields; the dialog is an enhancement that
  intercepts the click. `tests/e2e/regions.spec.ts` runs a `javaScriptEnabled: false`
  describe over that fallback, because it is the half that would otherwise rot unnoticed.

- `verify_post_check()` behaves differently in the Admin CP: on the front end it calls
  `error()` and stops the request, but with `IN_ADMINCP` defined it merely *returns false*.
  Calling it bare there - `verify_post_check($mybb->get_input('my_post_key'));` - therefore
  checks nothing at all, and both `events_admin_set_status()` and `events_admin_delete_event()`
  shipped that way. They are GET links, so that was a link an administrator could be sent and
  click. Every Admin CP action guards on the return value and `flash_message()`s
  `$lang->invalid_post_verify_key2` before redirecting, the way MyBB's own modules do.

- A test cannot exercise that guard with `page.goto()`. The board runs with
  `cookiesamesiteflag = 1`, and `verify_post_check()` also refuses any request whose
  `Sec-Fetch-Site` is not `same-origin` - which a typed navigation never is. A `goto()` to one
  of those links is refused whatever key it carries, so a test written that way passes against
  code that checks nothing. `followAdminActionLink()` in `tests/helpers/auth.ts` sends the
  request with the header a click would carry, and takes `withKey: false` for the forged case.

- `events_hooks.php` is the only plugin include loaded on every request. Anything a hook
  needs from `events_functions.php` has to be `require_once`d, not assumed.

- MyBB has no per-thread permission, so hiding an event's announcement thread from a
  member excluded from that event means telling every surface that could name a thread,
  one hook at a time: `global_intermediate` (which covers every page that takes a `tid`,
  `pid` or `aid` - showthread, printthread, newreply, editpost, showpost, sendthread,
  ratethread, polls, report, moderation, attachment), `xmlhttp` and `archive_start` for
  the two entry points that never load `global.php`'s furniture,
  `forumdisplay_get_threads` for the thread list, `build_forumbits_forum` for the "last
  post" a forum row advertises, `search_do_search_process` for the search log,
  `search_results_start` for the saved query that View New Posts, Today's Posts and "Find
  threads by user" re-run instead of reading that log, `syndication_get_posts` for the
  feeds, `archive_forum_start`/`archive_forum_end` for the archive's forum listing (buffered
  and cut, since it echoes each line), `build_friendly_wol_location_end` for Who's Online
  and a profile's "Currently", `stats_end` for the top-thread lists and `reputation_vote`
  for "for post in thread". A move's "Moved:" redirect stub is in the hidden set
  (`events_hidden_thread_ids()`), and copying an announcement is refused outright
  (`class_moderation_copy_thread`), since no hook says which tid the copy got. Saving an
  event drops the hidden members' thread subscriptions, and posting its announcement takes
  their forum-subscription notices back out of the mail queue. Adding a surface means
  another hook - there is no central place to put this, and a missed one is a thread the
  excluded member can read.

- Two of those surfaces do not identify their thread the way the rest do, and a hook
  registered on them is not the same thing as a hook that fires. The archive parses its
  thread out of the URL *path* (`archive/index.php?thread-12.html`) into `archive/global.php`'s
  own `$action` and `$id`, and never touches `$mybb->input['tid']` - so
  `events_block_hidden_thread()` has to read those globals when `IN_ARCHIVE` is defined, and
  check `$action` with them because `$id` is a *fid* when the action is `forum`. On
  `xmlhttp.php` only the actions that name a `tid` or a `pid` are covered, which is why
  `tests/e2e/exclusions.spec.ts` probes `action=edit_post` rather than a quote endpoint:
  `get_multiquoted` reads its posts from a cookie, so nothing about the request says which
  thread it is for. The archive was leaking whole announcement posts to excluded members for
  exactly this reason, and it looked closed in the hook list the entire time.

- Three leaks are known and left, because closing them is not something MyBB offers a hook
  for: forumdisplay counts a forum's threads further up the page than any hook it has, so
  the count behind the page links includes a hidden thread; the board index's thread and
  post totals are cached columns on the forum; and the portal's "latest discussions" list
  runs its query with no hook anywhere near it. All three are numbers or a page the board
  need not have turned on - none of them is a subject line. If a fourth appears, check
  whether it leaks a subject before treating it the same way.

- An announced event is read *in its thread*. `events_thread_postbit()` swaps the
  `postbit`/`postbit_classic` templates for `events_postbit` while the thread's first post
  is built and restores them straight after, because MyBB gives a plugin no way to replace
  a post's output. Paging, anchors, quick reply and thread tools stay MyBB's own. The card
  itself is `events_render_event_card()` (`events_event_card.php`), shared with `event.php`,
  which now only renders it when `events_event_thread()` finds no thread the viewer can open
  (pending drafts, no forum for the region, no forum access) and otherwise 302s to the thread.
  Guests and anybody `events_can_view_event()` refuses get the generated first post, which
  is also what Tapatalk shows, so that post must stay complete. Link to an event with
  `events_event_url()`, not a hard-coded `event.php?id=`.

- Because of that, `events.css` is attached to `showthread.php` and reaches *every* thread
  on the board. Nothing in it may apply outside the plugin's own markup. The print rules
  in particular are scoped to `body:has(.events_page_wrap)`: unscoped, they hide everything
  that is not an event, so printing an ordinary thread would come out blank.
  `event-threads.spec.ts` guards this.

- Every date the plugin stores is a *wall clock* in the board's configured event timezone
  (the `events_timezone` setting, picked in Admin CP -> Event Management -> Settings). The
  columns carry no offset, so the zone is what gives them meaning, and the server's own
  timezone is deliberately not it - a garrison's events happen where the garrison is, and
  moving hosts must not walk every signup cutoff sideways. Use `events_strtotime()` to read
  one and `events_date()` to write or render one (both in `events_functions.php`); plain
  `strtotime()`, `date()` and `my_date()` read the server's zone and will be right on the
  UTC test container and wrong on the garrison's host. `gmdate()` is correct only where the
  output is an absolute instant, which is `ical.php` and nowhere else. The test container
  runs UTC and provisioning pins the setting to UTC, so a missed conversion passes every
  spec but `timezone.spec.ts`, which is the one that parks the board in Brisbane.

- An event can be created and edited from two places - the Admin CP module and
  `manage_event.php` on the front end - and only the rendering differs. Reading the POST,
  validating it and writing the rows all live in `events_form.php`, which both require.
  Anything added to the event form has to go in there, or the two forms start disagreeing
  about what a valid event is, which shows up as an event the Admin CP would have rejected.

- Removing a day from an event cancels every signup that held it, whole, and PMs those
  members from whoever saved. Removing only the claim on the day used to leave a signup
  with no days, which the event page reads as "every day" and the attendance sheet as
  none. Both forms stop at `events_day_change_to_confirm()` first and save only when its
  button is clicked. The button posts a token of the days and members it listed, so a
  form changed in between is warned about again. When an event goes back to one day, the
  day it still runs on doesn't count as removed, even though its row is deleted. A
  single-day event has no rows to diff, so its one day is a stand-in with id 0
  (`events_single_event_day()`, read from the stored dates *before* the save overwrites
  them): moving it to another date cancels and PMs every signup the same way.

- A PM to several recipients is all-or-nothing: `PMDataHandler` refuses the whole message
  if any one `toid` is not a user, even with `admin_override`. The troop-report reminder is
  one such PM, so a single signup held by a deleted member used to stop it for the whole
  event, every night, with no error anywhere. Deleting a member now drops their rows
  (`events_user_deleted()` on `datahandler_user_delete_end`, registered in both contexts
  because the pruning task runs from front-end page views), and the reminder still joins
  `users` so a stray row can never do it again. Any new multi-recipient PM must do the same.

- The plugin's tables are MyISAM, like the rest of the board, so there are no transactions,
  and a double-clicked submit is two requests racing through the same check-then-write.
  Anything that reads state to decide what to write holds a named lock
  (`events_acquire_lock()` / `events_release_lock()`, MariaDB `GET_LOCK`) around both, and
  does the read *after* taking the lock. `events_save_signup()` locks the whole event
  (`events_signup_lock()`), not one member: whether a signup gets a place depends on
  everybody else's, so two members confirming for the last place under per-member locks
  both got it. A second Confirm still becomes an update to the first. `events_save_event()`
  holds the same lock across its withdrawals, cancellations, day changes and rebalance, and
  so calls `events_write_signup()` (the unlocked body) rather than `events_save_signup()`. `troop_report.php` and the reminder
  task share a lock per event, so a second submit is told the report is posted and linked
  to it. `tests/helpers/double-submit.ts` fires overlapping submits from the page. The
  signup race only loses some of the time, so one passing run of a test like that proves
  little.
- Maximum troopers and wranglers work on one rule: a *place* is a role on one day (or on
  the whole event, for an event with no days), its queue is every claim on it ordered by
  `claimed_at`, and the first `max` of the queue are attending and the rest waitlisted.
  `events_waitlist_moves()` is that rule and nothing else; `events_rebalance_waitlist()`
  applies it and must run, under the event's signup lock, after anything that changes
  signups, days or maximums. It holds only because a claim keeps its `claimed_at` for as
  long as the member holds that day - which is why `events_write_signup()` diffs claims
  rather than deleting and re-inserting them. Re-inserting on every save would send a member
  to the back of the waitlist for changing their costume.

- On an event with days, a signup's own `rsvps.status` is kept in step with its claims
  (attending if any claim is), so every `status = 'attending'` read elsewhere means "going,
  at least in part" and needed no change. Anything that lists *days*, though, has to look at
  the claim's status: `events_get_attendees()` returns only the claims with the status it
  was asked for (attending unless told otherwise), and `events_get_user_signup()` returns
  waitlisted rows too, with `day_status`. A new place a signup is read from has to decide
  which of the two it wants. The troop report, reminders and calendar want attending only.

- A new front-end page needs three things beyond the file itself: a template file (synced
  on activate), its `THIS_SCRIPT` added to `EVENTS_STYLESHEET_ATTACHEDTO` in
  `events_stylesheets.php` - a page missing from that list renders completely unstyled -
  and a re-provision, since both of those live in the database at runtime.
  `tests/e2e/plugin-setup.spec.ts` asserts on both lists, so it fails until they match.
- The web container has libfaketime preloaded, reading `.devenv/faketime/faketime.rc`.
  Writing that file moves PHP's clock for both Apache and CLI. The database clock is *not*
  faked, so plugin code compares times in PHP rather than with SQL `NOW()`.
- Moving that clock *backwards* has to be paired with realigning MyBB's activity
  timestamps. MyBB's shutdown handler adds `now - lastactive` to `users.timeonline`, which
  is UNSIGNED, so stamps left in the future make the next page view fail with "BIGINT
  UNSIGNED value is out of range" - and it is the dev forum in a browser that breaks, long
  after the run that caused it. The suite pairs the two in `moveClock()`
  (`tests/helpers/fixtures.ts`) and once more in `tests/global-teardown.ts`;
  `scripts/db-restore.sh` is the manual repair.

- The calendar subscription feed (`ical_feed.php`) is fetched by calendar servers with no
  session, so it defines `ALLOWABLE_PAGE` and its token is the entire access check.
  Everything it renders has to be asked *as the token's member*, by passing their uid -
  `events_can_view_event($event, $uid)`, `events_get_user_signup($id, $uid)` - never
  through a helper that reads `$mybb->user`, which on that page is a guest. The VEVENTs
  are built by `events_ical_vevents()` (`events_ical.php`) for both it and `ical.php`, so
  a change to what an entry says goes there once. Only the token's SHA-256 is stored
  (`events_feed.php`), which is why `calendar_feed.php` can show a link only in the
  response that made it.

- The subscription page also lives in the User CP (`usercp.php?action=events_calendar`,
  served from the `usercp_start` hook), and both halves of that have to survive a theme
  that rebuilds the User CP - the garrison's replaces MyBB's table layout with Bootstrap
  columns. `events_usercp_nav()` copies the theme's own Forum Subscriptions nav item,
  whatever its markup, rather than writing one; `events_usercp_layout()` lifts the frame
  around `{$usercpnav}` out of the theme's `usercp` template and closes what it opened.
  Fetch that template with `$templates->get("usercp", 0, 0)`: escaped for eval and then
  eval'd again, its attributes come out as `class=\"row\"` and the page falls out of the
  theme's grid with no error. `calendar-feed.spec.ts` checks the layout on both the
  garrison theme and MyBB's Default by position, not by markup.

- Every test starts with the forums as the snapshot has them. `restoreBoardContent()`
  (`tests/helpers/db.ts`, run by the `cleanBoard` fixture) puts back the threads, posts,
  forum counters, read markers, search log and thread-derived caches that global setup
  copied with `snapshotBoardContent()`. Threads used to outlive the test that posted them,
  and since every test starts the clock at the same instant, a run's threads all shared
  timestamps within seconds and where a new one sorted came down to how long earlier
  tests took: by the exclusion tests the events forum ran to two pages, the thread a test
  had just posted was on page 2, "it is listed" failed and "it is not listed" passed
  without checking anything. A new MyBB table that holds threads, posts or anything
  counted from them belongs in `BOARD_CONTENT_TABLES`. The datacache is restored only for
  the rows built from posts: `tasks` holds each task's next run, and rewinding it sets the
  reminder task off mid-test. A test that reads a listing to prove a thread is *absent*
  should check the listing is one page first, as `openForumListing()` in
  `exclusions.spec.ts` does.

# Working on this repo

## Layout

- `plugin/` is the source of truth for the plugin. Nothing is edited inside `test-forum/`.
  - `plugin/inc/plugins/events.php` - plugin metadata, install/activate/uninstall.
  - `plugin/inc/plugins/events/inc/` - shared functions, hooks, installers, render helpers.
  - `plugin/inc/plugins/events/admin/` - Admin CP module.
  - `plugin/inc/plugins/events/templates/` - templates as `.html` files; they are synced
    into MyBB's `templates` table on install/activate.
  - `plugin/inc/tasks/` - MyBB scheduled task entry points (MyBB requires a real file here).
  - `plugin/root/` - front-end pages. MyBB pages `require ./global.php`, so these must be
    deployed to the web root, not left under `inc/`.
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
  (it resets the clock and realigns the timestamps), then re-provision, then snapshot.
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
- Styling for a control that appears on both forms cannot live in `events.css`: that is a
  theme stylesheet, and the Admin CP loads no theme at all. Those go in
  `plugin/root/jscripts/events/` as a sheet both roots link
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
  setup claims it. A lock left by a dead process is taken over automatically.

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

- Changing a setting from a test means changing it the way the Admin CP does. MyBB serves
  `$mybb->settings` from the generated `inc/settings.php`, not from the `settings` table,
  so a row written with SQL is invisible to every page until something calls
  `rebuild_settings()`. `tests/e2e/regions.spec.ts` drives the Admin CP for exactly this
  reason, and restores the list the same way in its teardown.

- The Admin CP loads no theme stylesheet at all, so a control the plugin adds there has
  nowhere to be styled from except `plugin/root/jscripts/events/events-admin.css`, linked
  as `../jscripts/events/` the same way the datepicker's sheet is. `events.css` is a theme
  stylesheet and never reaches the Admin CP.

- The region X and the Add Region button are ordinary links to a confirmation page that
  asks the same questions and posts the same fields; the dialog is an enhancement that
  intercepts the click. `tests/e2e/regions.spec.ts` runs a `javaScriptEnabled: false`
  describe over that fallback, because it is the half that would otherwise rot unnoticed.

- `events_hooks.php` is the only plugin include loaded on every request. Anything a hook
  needs from `events_functions.php` has to be `require_once`d, not assumed.

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

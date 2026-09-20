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

- `events_hooks.php` is the only plugin include loaded on every request. Anything a hook
  needs from `events_functions.php` has to be `require_once`d, not assumed.
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

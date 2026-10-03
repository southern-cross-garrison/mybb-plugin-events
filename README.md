# MyBB Event Management plugin

Event management for MyBB 1.8: events with per-day trooper and wrangler signups, prerequisite checks, multi-day support,
attendance sheets, troop reports and iCal export. See [PLUGIN.md](PLUGIN.md)
for what the plugin does; this file covers the development environment and the test suite.

## Quick start

Requires Docker and pnpm 12+, which fetches the Node version the project pins.

```bash
./scripts/bootstrap.sh     # ~2 minutes on a cold start
npx playwright test
```

`bootstrap.sh` downloads the pinned MyBB release into `test-forum/`, starts the containers,
runs MyBB's installer non-interactively, deploys the plugin, imports the garrison's custom
theme and the Smart Thread Link plugin it depends on, provisions the fixtures, and takes a
database snapshot the suite resets to.

When it finishes:

| | |
|---|---|
| Forum | <http://localhost:8080> |
| Admin CP | <http://localhost:8080/admin/> - `admin` / `adminpass123` |
| Database | `localhost:3307` - `mybb` / `mybbpassword` |
| phpMyAdmin | `docker compose --profile tools up -d phpmyadmin` then <http://localhost:8081> |

Ports come from `.env` (copy `.env.example`) if the defaults clash.

## Development loop

```bash
./scripts/deploy.sh                 # copy plugin/ into test-forum/
npx playwright test         # whole suite, about 40 seconds
npx playwright test signup  # one spec
npx playwright test --ui    # interactive
npx playwright test --headed --debug -g "cutoff"
```

`plugin/` is the source of truth. Nothing is edited directly inside `test-forum/`.

Changing a template, the stylesheet, or anything in `events_install()` /
`events_activate()`, needs the plugin re-activated and the baseline snapshot refreshed.
Templates and CSS are files in the repo but live in the database at runtime, so a plain
`deploy.sh` is not enough on its own:

```bash
./scripts/deploy.sh
docker compose exec -T web php /dev/stdin < scripts/provision.php
./scripts/db-snapshot.sh
```

If the environment gets into a strange state, `./scripts/bootstrap.sh --fresh` rebuilds it
from nothing.

## PHP versions

The plugin supports PHP 7.4 (what the garrison's host runs) through the latest 8.x. The web
container runs 7.4 unless `PHP_VERSION` says otherwise, in `.env` or on the command line:

```bash
PHP_VERSION=8.5 ./scripts/bootstrap.sh
npx playwright test
```

Each version builds its own image (`mybb-events-web:php<version>`), so switching back is
quick. A plain `./scripts/bootstrap.sh` goes back to whatever `.env` says, so put the
version there if you mean to stay on it.

## Demo data

The provisioned board has users and settings but no events, which is what the suite wants
and a poor thing to look at. `scripts/seed-demo.php` fills it in with one event for every
state the plugin can put an event in - an empty roster, a three-day convention with fifteen
troopers and two wranglers across different days, WWCC-gated, excluded members, a pending
draft, signups locked by a passed cutoff, a region announcing into its own forum, one
finished event still owing a troop report and one that has posted its report, and an
archived event - plus a year of twenty reported troops behind them, so the Admin CP's
Reports tab and the User CP's My Troops have history to rank and chart, and eighteen demo
members to sign up as:

```bash
docker compose exec -T web php /dev/stdin < scripts/seed-demo.php
```

Everything is dated relative to the run and matched by title, so re-running moves the demo
forward rather than duplicating it. Sign in as `gec` for the coordinator pages, or as any
member it lists; the password is the fixtures' `testpass123`.

The board administrator is rostered as a trooper on the finished event that still owes a
report, because writing one needs a trooper signup on an event that has ended - so the
report can be drafted and posted from the admin account without signing in as anybody else.
Posting it archives that event, and re-running the seed puts it back. The administrator is also rostered on five of
the reported troops (and a no-show at one), so My Troops has something to show from that account.

Do not run `./scripts/db-snapshot.sh` after seeding - it is a plain dump, and it would bake
the demo into the baseline every later test run starts from. Restore first if you need one.

## The custom theme

The test forum runs the garrison's live theme rather than MyBB's default, so the suite
exercises the plugin's pages against the markup they actually ship on. The theme comes
from [southern-cross-garrison/mybb-custom-theme][theme], pinned to a commit by `THEME_REF`
in [scripts/env.sh](scripts/env.sh); `scripts/install-theme.sh` imports its XML through
MyBB's own ACP import code path, copies the theme's images into `test-forum/images/`, and
sets it as the board default.

To move to a newer theme commit, bump `THEME_REF` and re-import:

```bash
./scripts/install-theme.sh
./scripts/db-snapshot.sh
```

Re-importing is a clean replace: the previous copy of the theme and its template set are
dropped first, so nothing is left orphaned in ACP > Templates.

`MYBB_VERSION` is pinned to the release the theme is exported from (1.8.41), so the import
runs under MyBB's own version check rather than waiving it. If the two drift apart the
import stops with a message saying so, which is the point - a theme built against a
different MyBB is worth looking at rather than waving through.

Two assets the theme asks for are in neither MyBB nor the theme repo, so they 404 in the
test forum: `images/sort-solid.svg` (the dropdown arrow on `<select>` elements) and
`images/icons/noicon.png` (the "no icon" option when posting). Both are cosmetic, and both
presumably sit on the production server un-committed - worth adding to the theme repo.

The plugin's own templates are unaffected by any of this: they live in the master template
set (`sid = -2`), which every theme falls back to, so the theme import never touches them.

### Smart Thread Link

The theme links threads with `{$thread['smartlink']}`, not MyBB's own
`{$thread['threadlink']}`. That variable comes from [Smart Thread Link][smartlink], a small
garrison plugin that points a thread at the reader's first unread post when there is one and
at the thread start otherwise. It is a hard dependency of the theme, not an extra: on a board
running the theme without it, every thread subject in a forum renders as `<a href="">` and
nothing in `forumdisplay.php` - or the portal, stats, UserCP or printthread - is clickable.

`scripts/install-smartlink.sh` copies it into `test-forum/inc/plugins/`, pinned by
`SMARTLINK_REF` in [scripts/env.sh](scripts/env.sh), and `scripts/provision.php` activates
it alongside the events plugin. To move to a newer commit, bump the ref and re-run:

```bash
./scripts/install-smartlink.sh
docker compose exec -T web php /dev/stdin < scripts/provision.php
./scripts/db-snapshot.sh
```

## How the plugin gets skinned

The plugin's pages are built from MyBB's own table vocabulary - `.tborder`, `.thead`,
`.tcat`, `.trow1`, `.trow2`, with `.button` on submit inputs - which is what MyBB's stock
templates use and what every theme is expected to style. Nothing about the markup is
plugin-specific, so a theme skins the plugin by skinning MyBB.

Its component styles - the signup dots, the action buttons and the status pills - live in
[events.css](plugin/inc/plugins/events/stylesheets/events.css), installed on the master
theme (`tid = 1`) as a genuine theme stylesheet attached to the plugin's four pages. Every
theme inherits it and can override it by editing its own copy under ACP > Templates &
Style, exactly like the board's other plugin stylesheets. Nothing is inlined into the
templates, so a theme never has to fight a `<style>` block to restyle the plugin.

Accent colours are the one thing a theme usually wants to change, so they are read as
`var(--events-accent, ...)` with the fallback written at each use site. A theme retints
every button, pill and signup dot with one declaration:

```css
:root { --events-accent: #1090d0; --events-accent-border: #1090d0; }
```

The fallbacks are deliberately *not* defaults in a `:root` block inside `events.css`. That
stylesheet is installed last in the display order, so a `:root` block there would
out-order the theme's own and the override would silently never apply.

[theme]: https://github.com/southern-cross-garrison/mybb-custom-theme
[smartlink]: https://github.com/southern-cross-garrison/mybb-plugin-smartlink

## How the suite works

`tests/e2e/` drives a real browser against a real MyBB install. There is no mocking.

**Isolation.** The suite runs single-worker: there is one MyBB instance and one clock, so
tests cannot overlap. Global setup restores the provisioned database snapshot and caches a
login for each fixture user. Before each test the plugin's tables, private messages, task
logs and custom profile fields are reset, and the clock is parked at a fixed instant
(`TEST_NOW`, 2026-10-01 09:00 UTC). Every scenario is then built from absolute dates
relative to that instant, so nothing depends on the real date.

**Moving the clock.** The web container runs with `libfaketime` preloaded, reading a
bind-mounted control file. `setClock('2026-10-05 18:30:00')` writes that file and waits until
a real HTTP request observes the change, which moves PHP's clock for Apache requests *and*
for anything run through `docker compose exec`. That is how signup cutoffs, event start and
end times, troop report availability and the weekly reminder cadence are tested - the data
stays still and time moves, which is the way round that matches production.

The database clock is deliberately *not* faked. Plugin code therefore compares times in PHP
rather than with SQL `NOW()`.

**Fixtures.** `scripts/provision.php` creates the custom profile fields, usergroups, forums
and users the suite needs, and writes `test-forum/events-fixtures.json` with their ids. The
users are shaped around the scenarios:

| User | Purpose |
|---|---|
| `admin` | Admin CP access |
| `gec` | Event coordinator: manages events from the front end, no Admin CP rights |
| `trooper1` | Garrison member with a complete profile - signs up without prerequisites |
| `trooper2` | 501st member with a complete profile |
| `newbie` | No profile details at all - drives the prerequisites step |
| `nowwcc` | Everything except a WWCC - drives the WWCC-required branch |
| `wrangler` | Contact details but no Legion ID and no costumes - the wrangling-only path |
| `excluded` | Used for per-event exclusions |

All of them use the password `testpass123`.

## What is covered

| Spec | Covers |
|---|---|
| `plugin-setup` | Templates installed, task registered, settings mapped, nav link, guest access, Admin CP module |
| `admin-events` | Event create/edit/delete, validation, multi-day, exclusions, publish and archive, coordinator has no Admin CP access |
| `manage-events` | The front-end event form: a coordinator creating and editing without the Admin CP, the pending default, multi-day round-trips, exclusions, validation, and who is turned away |
| `events-listing` | List and calendar views, the view toggle (its toolbar position, icon and remembered per-member view), filters applying on change with a `<noscript>` button behind them, region filter, archived hidden until the filter asks and the filter surviving the toggle and the paging, the calendar's month stepper in place of a heading bar, attendance markers, pending visibility, multi-day spanning, month paging |
| `signup-flow` | The whole wizard: attendance, prerequisites, costumes, confirmation; validation; state carried between steps; editing an existing signup; multiselect costume parsing |
| `signup-locking` | **Clock travel:** cutoffs, event end, late signups during an event, pending/archived status, exclusions, guests, and that an existing signup survives the lock |
| `exclusions` | What an exclusion hides: the listing and calendar, the event's own pages and feed, the announcement thread across every surface that could name it, the troop report staying readable, and the coordinator carve-out |
| `signup-roles` | Choosing trooping or wrangling, mixing the two across days, what each role is asked for, the event page and listing, and how both roles reach the coordinator surfaces |
| `coordinator` | RSVP list and filters, attendance sheet and its day filter, permissions |
| `troop-report` | Availability after the event ends, draft segmentation by club, posting, archiving, duplicate prevention, announcement-thread comment |
| `event-announcements` | The generated forum thread for an event: which region's forum it lands in, the default fallback, pending events staying unannounced, edits rewriting the post rather than adding another, and BBCode neutralised |
| `reminders` | The scheduled task under a moved clock: who gets PMed, the weekly cadence, and when reminders stop |
| `ical` | Feed contents, one VEVENT per day, escaping, permissions |
| `timezone` | **Clock travel:** the board's event timezone, with the server on another one - cutoffs, the end of an event, what the pages show, and the UTC instants in the feed |
| `print` | Print media: the board chrome is gone, the branded ribbon is there and will actually print, and the attendance sheet paginates with a repeating header |
| `regions` | The board's region list in the Admin CP: renaming one and its events and forum following it, adding one and filing an event under it, the delete dialog's two steps and where the events go, and that all of it works with JavaScript turned off |
| `health` | Every page renders with no PHP warning or SQL error logged |

## Continuous integration

`.github/workflows/e2e.yml` runs the same two commands on every push and pull request,
once on PHP 7.4 and once on 8.5, and uploads each one's Playwright report, traces and
container logs when something fails. Before the suite it lints every PHP file in `plugin/`
and `scripts/`, which is what catches PHP 8-only syntax in a file no test loads.

Once both versions pass, the *Package the plugin* job uploads the release as the run's
`mybb-plugin-events-<sha>` artifact. Downloaded, it is a zip of the contents of `plugin/`
with no folder around them, so it expands straight over a forum root. `PLUGIN.md` is left
out of it for the same reason it is kept out of `plugin/`.

### Releasing

Pushing a version tag publishes a GitHub Release. Bump `"version"` in
`plugin/inc/plugins/events.php`, commit, then tag that commit to match:

```bash
git tag v1.3
git push origin v1.3
```

The tag runs the whole workflow, and once both PHP versions pass, the *Publish the release*
job attaches the zip as `mybb-plugin-events.zip` with release notes generated from the
commits since the last tag. It fails without publishing if the tag and the plugin's
version disagree. The asset keeps the same name every release, so
`releases/latest/download/mybb-plugin-events.zip` always fetches the newest one; the
user guide links to it.

## License

Apache License 2.0 - see [LICENSE](LICENSE) and [NOTICE](NOTICE).

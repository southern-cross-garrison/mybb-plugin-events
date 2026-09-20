# MyBB Event Management plugin

Event management for MyBB 1.8: events with RSVPs and wrangler signups, prerequisite checks, multi-day support,
attendance sheets, troop reports and iCal export. See [plugin/README.md](plugin/README.md)
for what the plugin does; this file covers the development environment and the test suite.

## Quick start

Requires Docker and Node 20+.

```bash
./scripts/bootstrap.sh     # ~2 minutes on a cold start
npx playwright test
```

`bootstrap.sh` downloads the pinned MyBB release into `test-forum/`, starts the containers,
runs MyBB's installer non-interactively, deploys the plugin, imports the garrison's custom
theme, provisions the fixtures, and takes a database snapshot the suite resets to.

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
npx playwright test rsvp    # one spec
npx playwright test --ui    # interactive
npx playwright test --headed --debug -g "cutoff"
```

`plugin/` is the source of truth. Nothing is edited directly inside `test-forum/`.

Changing a template, or anything in `events_install()` / `events_activate()`, needs the
plugin re-activated and the baseline snapshot refreshed:

```bash
./scripts/deploy.sh
docker compose exec -T web php /dev/stdin < scripts/provision.php
./scripts/db-snapshot.sh
```

If the environment gets into a strange state, `./scripts/bootstrap.sh --fresh` rebuilds it
from nothing.

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

`MYBB_VERSION` is pinned to the release the theme is exported from (1.8.40), so the import
runs under MyBB's own version check rather than waiving it. If the two drift apart the
import stops with a message saying so, which is the point - a theme built against a
different MyBB is worth looking at rather than waving through.

Two assets the theme asks for are in neither MyBB nor the theme repo, so they 404 in the
test forum: `images/sort-solid.svg` (the dropdown arrow on `<select>` elements) and
`images/icons/noicon.png` (the "no icon" option when posting). Both are cosmetic, and both
presumably sit on the production server un-committed - worth adding to the theme repo.

The plugin's own templates are unaffected by any of this: they live in the master template
set (`sid = -2`), which every theme falls back to, so the theme import never touches them.

[theme]: https://github.com/southern-cross-garrison/mybb-custom-theme

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
| `trooper1` | SCG member with a complete profile - RSVPs without prerequisites |
| `trooper2` | 501st member with a complete profile |
| `newbie` | No profile details at all - drives the prerequisites step |
| `nowwcc` | Everything except a WWCC - drives the WWCC-required branch |
| `excluded` | Used for per-event exclusions |

All of them use the password `testpass123`.

## What is covered

| Spec | Covers |
|---|---|
| `plugin-setup` | Templates installed, task registered, settings mapped, nav link, guest access, Admin CP module |
| `admin-events` | Event create/edit/delete, validation, multi-day, exclusions, publish and archive, coordinator has no Admin CP access |
| `events-listing` | List and calendar views, region filter, attendance markers, pending visibility, multi-day spanning, month paging |
| `rsvp-flow` | The whole wizard: prerequisites, costumes, days, confirmation; validation; state carried between steps; duplicate RSVPs; multiselect costume parsing |
| `rsvp-locking` | **Clock travel:** cutoffs, event end, late signups during an event, pending/archived status, exclusions, guests, and that an existing RSVP survives the lock |
| `coordinator` | RSVP list and filters, attendance sheet and its day filter, permissions |
| `troop-report` | Availability after the event ends, draft segmentation by club, posting, archiving, duplicate prevention, linked-thread comment |
| `reminders` | The scheduled task under a moved clock: who gets PMed, the weekly cadence, and when reminders stop |
| `ical` | Feed contents, one VEVENT per day, escaping, permissions |
| `health` | Every page renders with no PHP warning or SQL error logged |

## Continuous integration

`.github/workflows/e2e.yml` runs the same two commands on every push and pull request, and
uploads the Playwright report, traces and container logs when something fails.

## Layout

```
plugin/                     the plugin (source of truth)
  inc/plugins/events.php    metadata, install/activate/uninstall
  inc/plugins/events/inc/   functions, hooks, installers, render helpers
  inc/plugins/events/admin/ Admin CP module
  inc/plugins/events/templates/  templates, synced into MyBB on activate
  inc/tasks/                MyBB scheduled task entry points
  root/                     front-end pages, deployed to the web root
  admin_modules/events/     Admin CP module registration
scripts/                    environment tooling (bootstrap, install, deploy, provision, snapshot)
tests/                      Playwright suite
docker/                     web image and PHP config
test-forum/                 disposable MyBB tree (gitignored)
.devenv/                    local state: download cache, snapshot, clock file, reports (gitignored)
```

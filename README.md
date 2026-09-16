# MyBB Event Management plugin

Event management for MyBB 1.8: events with RSVPs, prerequisite checks, multi-day support,
attendance sheets, troop reports and iCal export. See [plugin/README.md](plugin/README.md)
for what the plugin does; this file covers the development environment and the test suite.

## Quick start

Requires Docker and Node 20+.

```bash
./scripts/bootstrap.sh     # ~2 minutes on a cold start
npx playwright test
```

`bootstrap.sh` downloads the pinned MyBB release into `test-forum/`, starts the containers,
runs MyBB's installer non-interactively, deploys the plugin, provisions the fixtures, and
takes a database snapshot the suite resets to.

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

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
  pinned MyBB release into it and `scripts/deploy.sh` copies the plugin in.
- `tests/` is the Playwright end-to-end suite; `scripts/` holds the environment tooling.

## Everyday commands

```bash
./scripts/bootstrap.sh          # bring the environment up (first run, or after a wipe)
./scripts/bootstrap.sh --fresh  # wipe test-forum/ and the database and rebuild
./scripts/deploy.sh                     # push plugin/ changes into test-forum/
npx playwright test             # run the suite
npx playwright test --ui        # run it interactively
```

After changing anything under `plugin/`, run `./scripts/deploy.sh`. After changing a template or
anything in `events_install()`/`events_activate()`, also re-run
`docker compose exec -T web php /dev/stdin < scripts/provision.php` so the plugin is
re-activated and the templates are re-synced, then `./scripts/db-snapshot.sh` so the suite's
baseline picks the change up.

## Things worth knowing

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
- The web container has libfaketime preloaded, reading `.devenv/faketime/faketime.rc`.
  Writing that file moves PHP's clock for both Apache and CLI. The database clock is *not*
  faked, so plugin code compares times in PHP rather than with SQL `NOW()`.

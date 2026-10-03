# Events Guide

The user guide for the plugin, built with [Starlight](https://starlight.astro.build/) and
published to GitHub Pages by `.github/workflows/docs.yml` on every push to `main` that
touches `docs/`.

The guide uses pnpm (the version is pinned by `packageManager` in `package.json`, so
`corepack enable` picks it up), separately from the npm-managed test suite at the repo root.

```bash
cd docs
pnpm install
pnpm dev           # http://localhost:4321/
pnpm build         # what CI runs
```

## Layout

| Folder | Audience |
| --- | --- |
| `src/content/docs/members/` | Troopers and wranglers |
| `src/content/docs/coordinators/` | Event coordinators without Admin CP access |
| `src/content/docs/admins/` | Administrators with Admin CP access |
| `src/content/docs/webmasters/` | Whoever installs and upgrades the plugin |
| `src/assets/screenshots/<guide>/` | Screenshots, generated (see below) |
| `screenshots/` | The Playwright scripts that take them |

A new page is a new `.mdx` file in the right folder; the sidebar picks it up. Set
`sidebar.order` in its frontmatter to place it.

## Writing a how-to

- One page per task family ("Signing up for an event"), one `##` heading per task inside
  it ("Change your signup", "Pull out of an event"). Each `##` heading is a deep link
  (`…/members/signing-up/#pull-out-of-an-event`) that gets pasted into forum posts and
  PMs, so **don't reword a heading once it's published** without checking for links to it.
- Wrap the steps in `<Steps>` with a numbered list. One action per step, the thing to
  click in **bold**, written exactly as it appears on screen.
- A screenshot goes inside the step it illustrates, indented to line up with the text,
  and imported at the top of the page:

  ```mdx
  import signup from '../../../assets/screenshots/members/event-signup-button.png';

  <Steps>

  1. Click **Sign Up to Attend**.

     <Image src={signup} alt="The event page with the Sign Up to Attend button circled" />

  </Steps>
  ```

- Use `<Aside type="tip">` / `"caution"` for the one thing people get wrong, not for
  general background.

## Screenshots

Screenshots are taken by Playwright against the dev forum, with the e2e suite's demo data
and fixture logins, so the public guide never shows a real member's details. The ring
around the thing to click is drawn by the script, not by hand, so after a UI change you
re-run the script rather than re-taking and re-annotating pictures.

```bash
../scripts/bootstrap.sh    # if the dev forum isn't up
pnpm screenshots           # all guides
pnpm screenshots members   # one guide
```

This runs the repo root's Playwright, so it needs the root's `npm install` as well as this
folder's `pnpm install`.

Each `screenshots/<guide>.shots.ts` builds the state it needs with the same helpers as the
e2e specs, then calls `ring(locator)` and `shot(area, '<guide>/<name>')` from
`screenshots/annotate.ts`. A shot with rings is cropped to them with some context around,
like Scribe; one without is the whole `area`. Pass `{ crop: false }` when the whole area is
the point and the ring is only a pointer, or `minWidth` / `minHeight` for more context. Commit the resulting PNGs with the page change. A new
screenshot needs a line in the script; until it's taken, a placeholder image is fine.

## Publishing

The guide is served at <https://events-guide.501scg.org>. It needs this one-off setup:

- **Settings → Pages**: **Source** is **GitHub Actions**, and **Custom domain** is
  `events-guide.501scg.org` with **Enforce HTTPS** on.
- **DNS** for 501scg.org: a `CNAME` record from `events-guide` to
  `southern-cross-garrison.github.io`.
- `site` in `astro.config.mjs` is the domain, with no `base`.

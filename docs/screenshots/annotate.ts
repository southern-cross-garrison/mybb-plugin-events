import { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** Screenshots land where the guide's pages import them from. */
export const SCREENSHOT_DIR = path.resolve(__dirname, '../src/assets/screenshots');

const RING = '#e11d48';
const RING_PAD = 6;

/** What has been ringed on each page since its last shot. */
const pending = new WeakMap<Page, Locator[]>();

/**
 * Mark controls to ring, Scribe-style, in the next `shot()` of their page.
 *
 * The rings themselves are drawn by `shot()` at the moment it captures, from where the
 * controls are on screen right then. Drawing them earlier, at page coordinates, goes wrong
 * on a page that scrolls inside a container rather than the window (the Admin CP does):
 * the ring stays where the control was while the content moves under it.
 */
export async function ring(...targets: Locator[]): Promise<void> {
  for (const target of targets) {
    await target.waitFor({ state: 'visible' });
    const page = target.page();
    pending.set(page, [...(pending.get(page) ?? []), target]);
  }
}

export interface ShotOptions {
  /**
   * Crop to the rings, with some context around them, rather than capturing the whole
   * area. On by default whenever there is a ring; a shot with no rings is always of the
   * whole area. Turn it off for a picture whose point is the page itself (a filled-in
   * form, a full list) and whose ring is only a pointer.
   */
  crop?: boolean;
  /** Smallest crop, in CSS pixels, so the ringed control keeps enough around it to be found. */
  minWidth?: number;
  minHeight?: number;
  /** Room left around the rings. */
  padding?: number;
  /**
   * More of the page to keep in the crop without ringing it, e.g. the name of the row a
   * ringed button belongs to.
   */
  include?: Locator[];
}

type Box = { x: number; y: number; width: number; height: number };

/** Draw rings around boxes. Fixed rings use viewport coordinates, absolute ones page coordinates. */
async function drawRings(page: Page, boxes: Box[], position: 'fixed' | 'absolute'): Promise<void> {
  await page.evaluate(
    ({ boxes, position, colour, pad }) => {
      const dx = position === 'absolute' ? window.scrollX : 0;
      const dy = position === 'absolute' ? window.scrollY : 0;
      for (const box of boxes) {
        const el = document.createElement('div');
        el.className = 'docs-ring';
        Object.assign(el.style, {
          position,
          left: `${box.x + dx - pad}px`,
          top: `${box.y + dy - pad}px`,
          width: `${box.width + pad * 2}px`,
          height: `${box.height + pad * 2}px`,
          border: `3px solid ${colour}`,
          borderRadius: '10px',
          boxShadow: '0 0 0 4px rgba(225, 29, 72, 0.2)',
          boxSizing: 'border-box',
          pointerEvents: 'none',
          zIndex: '2147483647',
        });
        document.documentElement.appendChild(el);
      }
    },
    { boxes, position, colour: RING, pad: RING_PAD },
  );
}

async function clearRings(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('.docs-ring').forEach((el) => el.remove()));
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${locator} has no bounding box - is it visible?`);
  }
  return box;
}

/**
 * Save a screenshot as `<guide>/<name>.png`, with the rings marked since the last shot.
 *
 * With rings it is cropped to them plus some context, which is what makes the control
 * readable at the width the guide shows images at. The crop never leaves `area`, so the
 * board's header and footer stay out, and is taken from the screen as it is, so it is at
 * most one screen tall. Without rings it is the whole of `area` (a container element, so
 * the image is the relevant part of the page rather than the whole browser window).
 */
export async function shot(area: Locator, name: string, options: ShotOptions = {}): Promise<void> {
  const { crop = true, minWidth = 560, minHeight = 240, padding = 48, include = [] } = options;
  const page = area.page();
  const targets = pending.get(page) ?? [];
  pending.delete(page);

  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const capture = { path: file, animations: 'disabled', caret: 'hide' } as const;

  try {
    if (targets.length === 0) {
      await area.screenshot(capture);
      return;
    }

    if (!crop) {
      // The whole area, which can be taller than the screen, so the rings go on in page
      // coordinates and the element screenshot scrolls as it needs to.
      await area.scrollIntoViewIfNeeded();
      await drawRings(page, await Promise.all(targets.map(boxOf)), 'absolute');
      await area.screenshot(capture);
      return;
    }

    // Bring the first ringed control to the middle of the screen, so there is context on
    // every side of it, then measure everything where it now is.
    await targets[0].evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
    const boxes = await Promise.all(targets.map(boxOf));
    const kept = [...boxes, ...(await Promise.all(include.map(boxOf)))];
    const a = await boxOf(area);
    const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));

    // A little past the area's edges, so a ring around a control right at the edge isn't
    // cut through - but never past the screen.
    const bleed = 12;
    const bounds = {
      left: Math.max(a.x - bleed, 0),
      top: Math.max(a.y - bleed, 0),
      right: Math.min(a.x + a.width + bleed, viewport.width),
      bottom: Math.min(a.y + a.height + bleed, viewport.height),
    };

    let left = Math.min(...kept.map((b) => b.x)) - padding;
    let top = Math.min(...kept.map((b) => b.y)) - padding;
    let right = Math.max(...kept.map((b) => b.x + b.width)) + padding;
    let bottom = Math.max(...kept.map((b) => b.y + b.height)) + padding;

    // Grow to the minimum around the rings' centre, then slide back inside the bounds.
    const fit = (lo: number, hi: number, min: number, floor: number, ceiling: number): [number, number] => {
      if (hi - lo < min) {
        const centre = (lo + hi) / 2;
        lo = centre - min / 2;
        hi = centre + min / 2;
      }
      if (lo < floor) { hi += floor - lo; lo = floor; }
      if (hi > ceiling) { lo -= hi - ceiling; hi = ceiling; }
      return [Math.max(lo, floor), Math.min(hi, ceiling)];
    };
    [left, right] = fit(left, right, minWidth, bounds.left, bounds.right);
    [top, bottom] = fit(top, bottom, minHeight, bounds.top, bounds.bottom);

    // Fixed to the screen, which is what a non-full-page clip captures, so the rings land
    // on the controls however the page scrolls.
    await drawRings(page, boxes, 'fixed');
    await page.screenshot({
      ...capture,
      clip: { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) },
    });
  } finally {
    await clearRings(page);
  }
}

/** The clickable chip for a radio or checkbox, which is what a reader looks for. */
export function choice(page: Page, inputId: string): Locator {
  return page.locator(`label:has(#${inputId}), label[for="${inputId}"]`).first();
}

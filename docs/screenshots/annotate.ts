import { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** Screenshots land where the guide's pages import them from. */
export const SCREENSHOT_DIR = path.resolve(__dirname, '../src/assets/screenshots');

const RING = '#e11d48';

/**
 * Draw a Scribe-style ring around each target. The ring is a plain absolutely positioned
 * div added to the page, so it is captured by the screenshot and gone on the next
 * navigation, or as soon as `shot()` has captured them.
 */
export async function ring(...targets: Locator[]): Promise<void> {
  for (const target of targets) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) {
      throw new Error(`ring(): ${target} has no bounding box - is it visible?`);
    }

    await target.page().evaluate(
      ({ box, colour }) => {
        const pad = 6;
        const el = document.createElement('div');
        el.className = 'docs-ring';
        Object.assign(el.style, {
          position: 'absolute',
          left: `${box.x + window.scrollX - pad}px`,
          top: `${box.y + window.scrollY - pad}px`,
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
      },
      { box, colour: RING },
    );
  }
}

export async function clearRings(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll('.docs-ring').forEach((el) => el.remove()));
}

export interface ShotOptions {
  /**
   * Crop to the rings drawn since the last shot, Scribe-style, rather than capturing the
   * whole area. On by default whenever there is a ring; a shot with no rings is always of
   * the whole area. Turn it off for a picture whose point is the page itself (a filled-in
   * form, a full list) and whose ring is only a pointer.
   */
  crop?: boolean;
  /** Smallest crop, in CSS pixels, so the ringed control keeps enough around it to be found. */
  minWidth?: number;
  minHeight?: number;
  /** Room left around the rings. */
  padding?: number;
}

/**
 * Save a screenshot as `<guide>/<name>.png`.
 *
 * With rings on the page it is cropped to them plus some context, which is what makes the
 * control readable at the width the guide shows images at; the crop never leaves `area`,
 * so the board's header and footer stay out. Without rings it is the whole of `area` (a
 * container element, so the image is the relevant part of the page rather than the whole
 * browser window).
 */
export async function shot(area: Locator, name: string, options: ShotOptions = {}): Promise<void> {
  const { crop = true, minWidth = 560, minHeight = 240, padding = 48 } = options;
  const page = area.page();
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const areaBox = await area.boundingBox();
  if (!areaBox) {
    throw new Error(`shot(): ${area} has no bounding box - is it visible?`);
  }

  // Everything in page (document) coordinates, which is what a full-page clip takes, so
  // the crop is right wherever the page happens to be scrolled.
  const clip = crop
    ? await page.evaluate(
        ({ areaBox, minWidth, minHeight, padding }) => {
          const rings = Array.from(document.querySelectorAll<HTMLElement>('.docs-ring'));
          if (rings.length === 0) {
            return null;
          }

          // A little past the area's edges, so a ring around a control sitting right at
          // the edge isn't cut through.
          const bleed = 12;
          const a = {
            left: areaBox.x + window.scrollX - bleed,
            top: areaBox.y + window.scrollY - bleed,
            right: areaBox.x + window.scrollX + areaBox.width + bleed,
            bottom: areaBox.y + window.scrollY + areaBox.height + bleed,
          };

          const r = rings.map((el) => el.getBoundingClientRect());
          let left = Math.min(...r.map((b) => b.left)) + window.scrollX - padding;
          let top = Math.min(...r.map((b) => b.top)) + window.scrollY - padding;
          let right = Math.max(...r.map((b) => b.right)) + window.scrollX + padding;
          let bottom = Math.max(...r.map((b) => b.bottom)) + window.scrollY + padding;

          // Grow to the minimum around the rings' centre, then slide back inside the area.
          const grow = (lo: number, hi: number, min: number, floor: number, ceiling: number) => {
            if (hi - lo < min) {
              const centre = (lo + hi) / 2;
              lo = centre - min / 2;
              hi = centre + min / 2;
            }
            if (lo < floor) { hi += floor - lo; lo = floor; }
            if (hi > ceiling) { lo -= hi - ceiling; hi = ceiling; }
            return [Math.max(lo, floor), Math.min(hi, ceiling)];
          };
          [left, right] = grow(left, right, minWidth, a.left, a.right);
          [top, bottom] = grow(top, bottom, minHeight, a.top, a.bottom);

          return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
        },
        { areaBox, minWidth, minHeight, padding },
      )
    : null;

  if (clip) {
    await page.screenshot({ path: file, clip, fullPage: true, animations: 'disabled', caret: 'hide' });
  } else {
    await area.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  }

  // Rings belong to the picture they were drawn for. Without this, a second shot of the
  // same page (no navigation in between) carries the first one's rings as well.
  await clearRings(page);
}

/** The clickable chip for a radio or checkbox, which is what a reader looks for. */
export function choice(page: Page, inputId: string): Locator {
  return page.locator(`label:has(#${inputId}), label[for="${inputId}"]`).first();
}

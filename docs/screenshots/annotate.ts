import { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** Screenshots land where the guide's pages import them from. */
export const SCREENSHOT_DIR = path.resolve(__dirname, '../src/assets/screenshots');

const RING = '#e11d48';

/**
 * Draw a Scribe-style ring around each target. The ring is a plain absolutely positioned
 * div added to the page, so it is captured by the screenshot and gone on the next
 * navigation. Call `clearRings()` to remove them without navigating.
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

/**
 * Save a screenshot of `area` (a container element, so the image shows the relevant part
 * of the page rather than the whole browser window) as `<guide>/<name>.png`.
 *
 * Rings drawn right at the edge of `area` can be clipped, so pick an area with a little
 * room around whatever is ringed.
 */
export async function shot(area: Locator, name: string): Promise<void> {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await area.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
}

/** The clickable chip for a radio or checkbox, which is what a reader looks for. */
export function choice(page: Page, inputId: string): Locator {
  return page.locator(`label:has(#${inputId}), label[for="${inputId}"]`).first();
}

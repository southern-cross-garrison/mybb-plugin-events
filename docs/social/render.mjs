// Renders social/og-image.html to public/og-image.jpg, the picture shown when a link to
// the guide is shared on Facebook, Discord, Slack and the like (1200x630).
//
//   node social/render.mjs      # from docs/, after pnpm install
//
// Uses the repo root's Playwright and its Chromium (npm install && npx playwright install
// chromium at the root), the same as the screenshot scripts.
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const html = new URL('./og-image.html', import.meta.url);
const out = fileURLToPath(new URL('../public/og-image.jpg', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(html.href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, type: 'jpeg', quality: 90 });
await browser.close();
console.log(`Wrote ${out}`);

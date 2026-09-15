// Diagnose preview orientation: fresh load, orbit-drag views from several sides.
import { chromium } from "/Users/abid/Projects/perabyte-studio/node_modules/playwright/index.mjs";

const S = "/Users/abid/Projects/perabyte-studio/gui-test-screenshots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 250)));

await page.goto("http://localhost:3100/character", { waitUntil: "networkidle", timeout: 60000 });
await page.getByRole("button", { name: /get started/i }).first().click();
await page.waitForTimeout(600);
await page.locator("textarea").first().fill("diagnostic");
await page.getByRole("button", { name: /^Next$/ }).click();
await page.waitForTimeout(8000); // full settle

const canvas = page.locator("canvas").first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

await page.screenshot({ path: `${S}/d0_fresh.png` });

// orbit: drag left 160px (rotate around figure)
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 160, cy, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(900);
await page.screenshot({ path: `${S}/d1_orbit_left.png` });

// orbit: drag right 320px
await page.mouse.move(cx - 160, cy);
await page.mouse.down();
await page.mouse.move(cx + 160, cy, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(900);
await page.screenshot({ path: `${S}/d2_orbit_right.png` });

// zoom out: wheel down over canvas
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(900);
await page.screenshot({ path: `${S}/d3_zoom_out.png` });

console.log("pageerrors:", JSON.stringify(errors.slice(0, 5)));
await browser.close();

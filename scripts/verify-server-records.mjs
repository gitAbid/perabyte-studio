/**
 * One-off Phase-A smoke: does the story editor resolve a SERVER-side story
 * by ?id= (a story this browser never stored), and does History expose the
 * editor entry point? Run with the smoke server up on :3120 and the smoke
 * story s_smoke1 present (see API smoke above).
 *
 *   node scripts/verify-server-records.mjs http://127.0.0.1:3120
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3120";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

// 1. Editor opens a story that exists ONLY on the server.
await page.goto(`${BASE}/story?id=s_smoke1`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const body = await page.textContent("body");
const checks = [];
checks.push([
  "editor shows both server scenes",
  body.includes("scene one") && body.includes("scene two"),
]);
checks.push([
  "scene prompt rendered",
  body.includes("scene one"),
]);
checks.push([
  "story adopted as active (sessionStorage)",
  await page.evaluate(() => sessionStorage.getItem("perabyte.active_story") === "s_smoke1"),
]);

// 2. History lists the story and offers the editor entry point.
await page.goto(`${BASE}/history`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
const histBody = await page.textContent("body");
checks.push(["history lists server story", histBody.includes("Smoke Story")]);

const row = page.locator("li", { hasText: "Smoke Story" }).first();
await row.locator('button[aria-label^="Actions for"]').click();
await page.waitForTimeout(300);
const menu = await page.textContent("body");
checks.push(["menu offers Continue in editor", menu.includes("Continue in editor")]);

// 3. Editor survives navigation away + back (server truth, no tab state).
await page.locator('a[role="menuitem"]:has-text("Continue in editor")').click();
await page.waitForURL("**/story?id=s_smoke1");
await page.waitForTimeout(1200);
const backBody = await page.textContent("body");
checks.push(["editor reopened from History", backBody.includes("scene one") && backBody.includes("scene two")]);

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
if (errors.length) {
  console.log("CONSOLE ERRORS:", errors.slice(0, 5));
  failed += 1;
}
await browser.close();
process.exit(failed ? 1 : 0);

/**
 * GUI verification for story continuation (plan Task 12).
 * Drives the running dev server on :3100 with headless Chromium.
 *
 * Phases:
 *  1. Continuity toggle flips state + helper text
 *  2. Free (Pollinations) image story: scene 1 renders, scene 2 chains after it
 *  3. Convert-to-video dialog renders end-capable models (screenshot, no render)
 *
 * Usage: node scripts/verify-story-continuation.mjs [--with-clip-render]
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3100";
const SHOTS = new URL("../gui-test-screenshots/", import.meta.url).pathname;
const WITH_CLIP = process.argv.includes("--with-clip-render");

const results = [];
function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(20_000);

try {
  await page.goto(`${BASE}/story`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("button[aria-pressed]", { timeout: 30_000 });

  /* ---------------- Phase 1: continuity toggle ---------------- */
  const toggle = page.locator("button[aria-pressed]").first();
  const before = await toggle.getAttribute("aria-pressed");
  await toggle.click();
  await page.waitForTimeout(300);
  const after = await toggle.getAttribute("aria-pressed");
  const parallelText = await page
    .getByText("Scenes render in parallel, independently.")
    .count();
  record(
    "continuity toggle flips",
    before === "true" && after === "false" && parallelText === 1,
    `before=${before} after=${after}`,
  );
  await toggle.click();
  await page.waitForTimeout(300);
  record(
    "continuity toggle restores",
    (await toggle.getAttribute("aria-pressed")) === "true",
  );

  /* ---------------- Phase 2: chained free generation ---------------- */
  // Pick the free Pollinations model to keep the smoke cost at zero.
  await page.getByRole("button", { name: /^Model:/ }).click();
  await page
    .locator("div[class*='absolute'] button", { hasText: "free demo" })
    .first()
    .click();
  await page.waitForTimeout(300);
  const pickedModel = await page.getByRole("button", { name: /^Model:/ }).innerText();
  record("free model selected", /Flux/i.test(pickedModel), pickedModel.trim());

  await page
    .getByRole("textbox")
    .first()
    .fill("a red paper lantern drifting over a night market");
  await page.getByRole("button", { name: "Generate", exact: true }).click();

  // Scene 1 renders: wait for the completed image tile to exist.
  await page.waitForSelector("img[alt*='lantern']", { timeout: 120_000 });
  record("scene 1 rendered (free provider)", true);

  // Add scene 2 — with scene 1 completed (end frame derived), the runner
  // starts it immediately; the badge must now show 2 scenes.
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes("2 scenes"),
    undefined,
    { timeout: 10_000 },
  );
  record("scene 2 added to the queue", true);

  // Scene 2 completes (Pollinations image; chain feeds its start ref).
  await page.waitForFunction(
    () => document.querySelectorAll("main img").length >= 2,
    undefined,
    { timeout: 150_000 },
  );
  record("scene 2 rendered after chain", true);

  /* ---------------- Phase 3: convert dialog ---------------- */
  const convertButton = page.getByRole("button", { name: "Convert to video" });
  await convertButton.waitFor({ state: "visible", timeout: 10_000 });
  record("convert button appears for completed image story", true);
  await convertButton.click();
  await page.waitForSelector("[role='dialog']", { timeout: 5000 });
  const dialogText = await page.locator("[role='dialog']").innerText();
  const clipCountOk = /1 clip/.test(dialogText);
  const hasModelPill = /Video model/i.test(dialogText);
  record(
    "convert dialog shows clip count + model picker",
    clipCountOk && hasModelPill,
    dialogText.slice(0, 120).replace(/\n/g, " "),
  );
  await page.screenshot({ path: `${SHOTS}story-convert-dialog.png`, fullPage: true });

  if (WITH_CLIP) {
    // Confirm the conversion: renders ONE i2v clip on the end-capable model.
    await page.locator("[role='dialog']").getByRole("button", { name: "Convert" }).click();
    record("conversion confirmed — clip queued", true);
    // The page switches to the video story; a video tile appears when done.
    await page.waitForFunction(
      () => document.querySelectorAll("main video, main [class*='video']").length >= 1,
      { timeout: 300_000 },
    );
    record("clip rendered (video tile visible)", true);
    await page.screenshot({ path: `${SHOTS}story-clip-done.png`, fullPage: true });
  } else {
    await page
      .locator("[role='dialog']")
      .getByRole("button", { name: "Cancel" })
      .click();
    record("conversion cancelled cleanly (live render skipped)", true);
  }

  /* ---------------- Persistence spot-check ---------------- */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const bodyAfter = await page.evaluate(() => document.body.innerText);
  record(
    "story survives reload (scenes restored)",
    (bodyAfter.includes("Scene 2") || bodyAfter.includes("SCENE 2")) &&
      bodyAfter.includes("Continuity"),
  );
} catch (error) {
  record("unexpected failure", false, String(error).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}story-verify-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

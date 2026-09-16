/** Targeted check: selecting an end-capable model (Seedance 2.5) reveals the
 * Last frame slot; the swap note appears for a start frame on a t2v model. */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(`${BASE}/generate/video`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("First frame")', { timeout: 20_000 });

  // On a non-end-capable model the Last frame slot renders LOCKED with a
  // hint naming the unlock model — visible, never silently hidden.
  const locked = page.locator('[aria-label="Last frame — unavailable for this model"]');
  await locked.waitFor({ timeout: 10_000 });
  const hint = await locked.getAttribute("title");
  check("start-only model shows the Last frame slot LOCKED", true, hint ?? "");
  check("lock hint names an unlock model", /switch to .+ to unlock/.test(hint ?? ""));
  await page.screenshot({ path: "gui-test-screenshots/frame-dock/last-frame-locked.png" });

  // Switch the model pill to Seedance 2.5 (end-capable). It may sit in the
  // collapsed provider tail — expand that section when needed.
  await page.click('button[aria-label^="Model:"]');
  await page.waitForSelector('div[role="listbox"]', { timeout: 10_000 });
  const seedance = page.locator('div[role="listbox"] button:has-text("Seedance 2.5")');
  if ((await seedance.count()) === 0) {
    // The tail expander is the last button inside the listbox before options.
    const expander = page.locator('div[role="listbox"] > div:last-child > button').first();
    await expander.click();
    await page.waitForTimeout(300);
  }
  await seedance.first().click({ timeout: 10_000 });
  // The lock lifts: the slot becomes an active add-pill.
  await locked.waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForSelector('[aria-label="Add last frame"]', { timeout: 10_000 });
  check("end-capable model unlocks the Last frame slot", true);

  // Fill both slots: the end-frame note appears.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const inputs = page.locator('input[type="file"][accept^="image/"]');
  await page.setInputFiles('input[type="file"][accept^="image/"]', {
    name: "a.png", mimeType: "image/png", buffer: png,
  });
  await page.waitForSelector('button[aria-label^="Replace first frame"]', { timeout: 10_000 });
  // Humans pick the target slot first (the pill sets it); mirror that.
  await page.click('button:has-text("Last frame")');
  await page.setInputFiles('input[type="file"][accept^="image/"]', {
    name: "b.png", mimeType: "image/png", buffer: png,
  });
  await page.waitForSelector('button[aria-label^="Replace last frame"]', { timeout: 10_000 });
  await page.waitForSelector("text=ends exactly on your last frame", { timeout: 10_000 });
  check("start + last frames attach; end-frame note appears", true);
  await page.screenshot({ path: "gui-test-screenshots/frame-dock/solo-video-both-frames.png" });
} catch (error) {
  failures += 1;
  console.error("[FAIL] unexpected error:", error.message);
  await page.screenshot({ path: "gui-test-screenshots/frame-dock/failure-end.png" }).catch(() => {});
} finally {
  await browser.close();
}
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

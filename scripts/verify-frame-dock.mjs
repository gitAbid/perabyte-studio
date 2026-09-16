/**
 * GUI smoke for the FrameDock redesign (feat/frame-dock).
 *   node scripts/verify-frame-dock.mjs [baseUrl]   (dev server on :3100)
 *
 * Black-box checks, no renders fired:
 *   1. Solo video: First frame slot present, file upload → thumbnail chip,
 *      chip remove, drop-to-attach, model-aware Last-frame slot visibility.
 *   2. Solo image: single "Reference image" slot (no First/Last wording).
 *   3. Story: dock inside the composer, chain-override hint appears with a
 *      start frame + continuity on, Add scene commits the frame (tile badge)
 *      and the dock resets for the next draft.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const SHOTS = "gui-test-screenshots/frame-dock";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** 1×1 red PNG plus a distinct blue one for drop tests. */
function png(r, g, b) {
  // minimal valid PNG via base64 templates would be bulky; instead build a
  // tiny canvas PNG in the browser during the drop test. For input-file
  // uploads a static 1×1 PNG suffices.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
}
const RED_PNG = png();
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  /* ---------------------------- Solo video ---------------------------- */
  await page.goto(`${BASE}/generate/video`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("First frame")', { timeout: 20_000 });
  check("solo video: First frame slot renders", true);

  // The Last frame slot is always visible: active on end-capable models,
  // locked (with an explanation) otherwise — never silently hidden.
  await page.waitForSelector(
    '[aria-label="Add last frame"], [aria-label="Last frame — unavailable for this model"]',
    { timeout: 10_000 },
  );
  const lastLocked = await page
    .locator('[aria-label="Last frame — unavailable for this model"]')
    .count();
  if (lastLocked > 0) {
    const hint = await page
      .locator('[aria-label="Last frame — unavailable for this model"]')
      .getAttribute("title");
    check("solo video: Last frame slot visible but LOCKED on this model", true, hint ?? "");
    check("solo video: lock hint names an unlock model", /switch to .+ to unlock/.test(hint ?? ""));
  } else {
    check("solo video: Last frame slot active (end-capable default model)", true);
  }

  // File upload via the dock's hidden input → chip appears.
  await page.setInputFiles('input[type="file"][accept^="image/"]', {
    name: "first.png",
    mimeType: "image/png",
    buffer: RED_PNG,
  });
  await page.waitForSelector('button[aria-label^="Replace first frame"]', { timeout: 10_000 });
  check("solo video: upload fills the slot (chip + replace affordance)", true);

  // The old disconnected strip is gone.
  const stripCount = await page.locator('text="Scene frames"').count();
  check("solo/story: legacy 'Scene frames' strip absent", stripCount === 0);

  // Remove via hover ✕.
  await page.hover('button[aria-label^="Replace first frame"]');
  await page.click('button[aria-label="Remove first frame"]');
  await page.waitForSelector('button:has-text("First frame")', { timeout: 10_000 });
  check("solo video: chip remove returns the empty slot", true);

  // Drop-to-attach (first empty slot).
  await page.dispatchEvent("body", "dragover"); // no-op warm-up for listeners
  const dropped = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#20c0ff";
    ctx.fillRect(0, 0, 8, 8);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], "dropped.png", { type: "image/png" });
    const dock = document.querySelector('[class*="flex-wrap"][class*="rounded-[12px]"]');
    if (!dock) return "no dock";
    for (const type of ["dragenter", "dragover"]) {
      dock.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    dock.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return "dropped";
  });
  check("solo video: drop dispatch reached the dock", dropped === "dropped", String(dropped));
  await page.waitForSelector('button[aria-label^="Replace first frame"]', { timeout: 10_000 });
  check("solo video: drop-to-attach fills the slot", true);
  await page.screenshot({ path: `${SHOTS}/solo-video-filled.png` });

  /* ---------------------------- Solo image ---------------------------- */
  await page.goto(`${BASE}/generate/image`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("Reference image")', { timeout: 20_000 });
  check("solo image: Reference image slot renders", true);
  const firstOnImage = await page.locator('button:has-text("First frame")').count();
  check("solo image: no First/Last frame wording", firstOnImage === 0);
  await page.screenshot({ path: `${SHOTS}/solo-image.png` });

  /* ------------------------------ Story ------------------------------- */
  // Story opens in image kind → a single "Reference image" slot.
  await page.goto(`${BASE}/story`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("Reference image")', { timeout: 20_000 });
  check("story (image): Reference image slot renders inside the composer", true);

  // Attach it → the image guidance hint appears.
  await page.setInputFiles('input[type="file"][accept^="image/"]', {
    name: "scene-ref.png",
    mimeType: "image/png",
    buffer: BLUE_PNG,
  });
  await page.waitForSelector("text=guides this scene's composition", { timeout: 10_000 });
  check("story (image): guidance hint appears with a reference", true);
  await page.screenshot({ path: `${SHOTS}/story-hint.png` });

  // Commit the draft with Add scene: the tile gains its start badge and the
  // dock resets for the next scene.
  await page.fill("#prompt-input", "A lone lighthouse above a stormy sea");
  await page.click('button:has-text("Add scene")');
  await page.waitForSelector('span[title="This scene has a manual start frame"]', { timeout: 10_000 });
  check("story: Add scene commits the frame (tile badge)", true);
  await page.waitForSelector('button:has-text("Reference image")', { timeout: 10_000 });
  check("story: dock resets for the next draft scene", true);

  // Switch to video kind: First frame appears, the Last frame slot shows
  // (active or locked, never hidden), and the continuity-override hint
  // shows for a fresh start frame.
  await page.click('button[aria-label="Story media type"]:has-text("Video"), button:has-text("Video")');
  await page.waitForSelector('button:has-text("First frame")', { timeout: 20_000 });
  check("story (video): First frame slot renders", true);
  await page.waitForSelector(
    '[aria-label="Add last frame"], [aria-label="Last frame — unavailable for this model"]',
    { timeout: 10_000 },
  );
  check("story (video): Last frame slot visible (active or locked)", true);
  await page.setInputFiles('input[type="file"][accept^="image/"]', {
    name: "scene-start.png",
    mimeType: "image/png",
    buffer: RED_PNG,
  });
  await page.waitForSelector("text=the chain continues from here", { timeout: 10_000 });
  check("story (video): continuity-override hint appears with a start frame", true);
  await page.screenshot({ path: `${SHOTS}/story-video-hint.png` });
} catch (error) {
  failures += 1;
  console.error("[FAIL] unexpected error:", error.message);
  await page.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

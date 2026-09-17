/**
 * GUI smoke for story scene edit mode (feat/story-scene-edit).
 *   node scripts/verify-story-scene-edit.mjs [baseUrl]   (dev server on :3100)
 *
 * Black-box checks, no renders fired (the story is seeded queued via the API):
 *   1. Click a queued scene tile → composer shows "Editing scene N", the
 *      scene's prompt, an Update scene button; Add scene hidden.
 *   2. Tweak aspect + prompt → Update → tile ratio changes, server record
 *      carries the sparse override; the untouched scene has none.
 *   3. Draft restore: a typed composer draft survives select → exit untouched.
 *   4. A failed scene's Update re-queues it (save + retry).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const SHOTS = "gui-test-screenshots/story-scene-edit";
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function sceneAsset(id, title, scenes) {
  return {
    id,
    kind: "story",
    title,
    prompt: "seeded smoke story",
    url: "",
    variants: [],
    settings: {
      kind: "image",
      aspect: "16:9",
      resolution: "1080p",
      style: "Realistic",
      duration: "5s",
      count: 1,
      seed: "",
      negativePrompt: "",
      enhance: true,
    },
    createdAt: Date.now(),
    favorite: false,
    mode: "Story Mode",
    scenes,
    meta: { continuity: true, running: false, style: "Realistic", characterIds: [] },
  };
}

const STORY_ID = `s_smoke_${Date.now().toString(36)}`;
const story = sceneAsset(STORY_ID, "Scene edit smoke", [
  {
    id: "sc_1_smoke",
    prompt: "first scene, a lighthouse at dusk",
    url: null,
    status: "queued",
    kind: "image",
  },
  {
    id: "sc_2_smoke",
    prompt: "second scene, the storm arrives",
    url: null,
    status: "queued",
    kind: "image",
  },
]);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  // Seed the queued story straight through the API (no renders fired).
  const seeded = await page.request.post(`${BASE}/api/assets`, { data: story });
  check("seed: story record created", seeded.ok());

  await page.goto(`${BASE}/story?id=${STORY_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[aria-label="Edit scene 2 in the composer"]', {
    timeout: 20_000,
  });

  /* ------------------- 1. select → composer edit mode ------------------- */
  await page.click('[aria-label="Edit scene 2 in the composer"]');
  await page.waitForSelector('button:has-text("Update scene")', { timeout: 10_000 });
  check("select: Update scene button replaces Generate", true);
  check(
    "select: editing badge shows scene 2",
    (await page.locator('span:has-text("Editing scene 2")').count()) > 0,
  );
  const loadedPrompt = await page.inputValue("#prompt-input");
  check(
    "select: composer loaded the scene's prompt",
    loadedPrompt === "second scene, the storm arrives",
    loadedPrompt,
  );
  check(
    "select: Add scene hidden while editing",
    (await page.locator('button:has-text("Add scene")').count()) === 0,
  );

  /* ----------------------- 2. tweak → update ---------------------------- */
  // The pill's visible text is its current value; the name lives in aria-label.
  await page.click('button[aria-label^="Aspect ratio"]');
  await page.click('[role="option"]:has-text("1:1")');
  await page.fill("#prompt-input", "second scene, the storm rolls in over the bay");
  await page.click('button:has-text("Update scene")');
  // Exit edit mode: the story kind toggle is back, badge gone.
  await page.waitForSelector('button:has-text("Generate")', { timeout: 10_000 });
  check(
    "update: back to the story composer",
    (await page.locator('span:has-text("Editing scene 2")').count()) === 0,
  );
  await page.waitForTimeout(600); // poll tick applies the server record
  const tileRatio = await page
    .locator('div[aria-label="Edit scene 2 in the composer"] .skeleton')
    .first()
    .evaluate((el) => el.style.aspectRatio);
  check("update: scene 2 tile renders square", tileRatio === "1024 / 1024", tileRatio);

  const record = await (await page.request.get(`${BASE}/api/stories/${STORY_ID}`)).json();
  const sc2 = record.story.scenes.find((s) => s.id === "sc_2_smoke");
  const sc1 = record.story.scenes.find((s) => s.id === "sc_1_smoke");
  check(
    "update: server record carries the sparse override",
    sc2?.settings?.aspect === "1:1" && sc2?.prompt === "second scene, the storm rolls in over the bay",
    JSON.stringify(sc2?.settings),
  );
  check("update: untouched scene has no overrides", !sc1?.settings);

  /* ------------------------- 3. draft restore --------------------------- */
  await page.fill("#prompt-input", "my unsaved draft prompt");
  await page.click('[aria-label="Edit scene 1 in the composer"]');
  await page.waitForSelector('button:has-text("Update scene")', { timeout: 10_000 });
  const scene1Prompt = await page.inputValue("#prompt-input");
  check(
    "restore: composer loaded scene 1",
    scene1Prompt === "first scene, a lighthouse at dusk",
    scene1Prompt,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const draftBack = await page.inputValue("#prompt-input");
  check("restore: Escape exits and hands the draft back", draftBack === "my unsaved draft prompt", draftBack);

  /* --------------------- 4. failed scene save+retry --------------------- */
  await page.request.patch(
    `${BASE}/api/assets?id=${STORY_ID}`,
    { data: { scenes: record.story.scenes.map((s) => (s.id === "sc_1_smoke" ? { ...s, status: "failed", error: "boom" } : s)) } },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[aria-label="Edit scene 1 in the composer"]', { timeout: 20_000 });
  await page.click('[aria-label="Edit scene 1 in the composer"]');
  await page.click('button[aria-label^="Aspect ratio"]');
  await page.click('[role="option"]:has-text("9:16")');
  await page.click('button:has-text("Update scene")');
  await page.waitForTimeout(800);
  const after = await (await page.request.get(`${BASE}/api/stories/${STORY_ID}`)).json();
  const failedScene = after.story.scenes.find((s) => s.id === "sc_1_smoke");
  check(
    "failed scene: update saves overrides and re-queues",
    failedScene?.status === "queued" && failedScene?.settings?.aspect === "9:16",
    `status=${failedScene?.status} settings=${JSON.stringify(failedScene?.settings)}`,
  );

  await page.screenshot({ path: `${SHOTS}/final.png`, fullPage: true });
} catch (error) {
  failures += 1;
  console.log(`[FAIL] unexpected — ${error.message}`);
  await page.screenshot({ path: `${SHOTS}/error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);

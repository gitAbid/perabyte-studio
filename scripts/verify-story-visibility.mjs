/**
 * Verifies the story scene-visibility feature end-to-end with fake renders:
 * chain-frame badges (pending → chained → enlarge), 2-up grid, inline prompt
 * editing, per-scene re-run, and reorder. /api/generate is intercepted and
 * fulfilled with NDJSON (progress + result) — no real provider renders.
 *
 *   node scripts/verify-story-visibility.mjs [baseUrl]   (dev server on :3100)
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const OUT = new URL("../shots/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

// 1x1 PNG (red) — stretched by object-cover into a solid thumb block.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR ${String(e).slice(0, 200)}`));

/** Captured /api/generate bodies, in call order. */
const genCalls = [];
/** Calls after the first settle this much later, so a queued successor is
 * caught mid-"generating" with its chained badge visible. */
let subsequentDelayMs = 0;

await page.route("**/api/generate", async (route) => {
  genCalls.push(route.request().postDataJSON());
  const n = genCalls.length;
  const payload = [
    JSON.stringify({ type: "progress", stage: "rendering", message: "fake render", percent: 50 }),
    JSON.stringify({
      type: "result",
      requestId: `r${n}`,
      status: "completed",
      kind: "image",
      elapsedMs: 5,
      media: [
        { id: `m${n}`, url: `/api/media?f=verify-gen-${n}.png`, width: 1024, height: 576, seed: 1 },
      ],
    }),
    "",
  ].join("\n");
  const fulfill = () =>
    route.fulfill({ status: 200, contentType: "application/x-ndjson", body: payload });
  if (n > 1 && subsequentDelayMs > 0) setTimeout(fulfill, subsequentDelayMs);
  else await fulfill();
});
await page.route("**/api/media?f=verify-gen-*", (route) => {
  const f = new URL(route.request().url()).searchParams.get("f") ?? "";
  const n = f.match(/verify-gen-(\d+)/)?.[1] ?? "0";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="${n === "1" ? "#4ade80" : "#60a5fa"}"/><text x="400" y="270" font-size="72" text-anchor="middle" fill="#0f172a" font-family="sans-serif">FRAME ${n}</text></svg>`;
  return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** The composer's Generate button, waited until the run isn't busy. */
async function pressGenerate() {
  const button = page.getByRole("button", { name: "Generate", exact: true });
  await button.waitFor({ timeout: 15000 });
  await button.click();
}

try {
  await page.goto(`${BASE}/story`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#prompt-input", { timeout: 20000 });
  // Fresh queue for a deterministic run.
  const newStory = page.getByRole("button", { name: "New story" });
  if (await newStory.isVisible().catch(() => false)) {
    await newStory.click();
    await page.waitForTimeout(300);
  }

  // --- A: queue two scenes WITHOUT generating → pending badge -----------
  await page.fill("#prompt-input", "first scene of the verify story");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.waitForTimeout(200);
  await page.fill("#prompt-input", "second scene of the verify story");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.waitForTimeout(300);
  check(
    "pending badge label before Generate",
    await page.getByText("Scene 1's last frame").first().isVisible().catch(() => false),
  );
  check(
    "waiting pill present",
    await page.getByText("Waiting for Scene 1").first().isVisible().catch(() => false),
  );
  await page.screenshot({ path: `${OUT}story-pending.png`, fullPage: true });

  // --- B: one Generate — chained badge on the delayed successor ---------
  subsequentDelayMs = 1500;
  await pressGenerate();
  await page
    .locator('button[aria-label="Enlarge the reference frame"]')
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => check("chained badge thumb appears on successor", true))
    .catch(() => check("chained badge thumb appears on successor", false));
  check(
    "chained badge label",
    await page.getByText("From Scene 1").first().isVisible().catch(() => false),
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}story-chained.png`, fullPage: true });
  await page.locator('button[aria-label="Enlarge the reference frame"]').first().click();
  check(
    "enlarge overlay opens",
    await page.locator('img[alt="Reference frame"]').isVisible().catch(() => false),
  );
  await page.screenshot({ path: `${OUT}story-zoom.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(
    "Escape closes overlay",
    !(await page.locator('img[alt="Reference frame"]').isVisible().catch(() => false)),
  );

  // --- C: all complete, 2-up grid ---------------------------------------
  await page.waitForFunction(
    () => document.querySelectorAll('img[src*="verify-gen"]').length >= 2, // both cards
    { timeout: 10000 },
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}story-complete.png`, fullPage: true });
  const grid = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("p")].filter((p) =>
      /^Scene \d+$/.test(p.textContent?.trim() ?? ""),
    );
    return labels.map((p) => {
      const r = p.getBoundingClientRect();
      return { text: p.textContent?.trim(), x: Math.round(r.x), y: Math.round(r.y) };
    });
  });
  check(
    "2-up grid (scene labels share a row)",
    grid.length >= 2 && grid[0].y === grid[1].y,
    JSON.stringify(grid),
  );

  // --- D: inline prompt edit on a NEW queued scene -----------------------
  await page.fill("#prompt-input", "third scene, queued for editing");
  await page.getByRole("button", { name: "Add scene" }).click();
  await page.waitForTimeout(300);
  const editor = page.locator("textarea:not(#prompt-input)");
  await page.locator("p.cursor-text").last().click();
  await editor.waitFor({ timeout: 3000 });
  await editor.fill("third scene EDITED");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(
    "Escape cancels the edit",
    await page.getByText("third scene, queued for editing").first().isVisible().catch(() => false),
  );
  await page.locator("p.cursor-text").last().click();
  await editor.fill("third scene EDITED");
  await page.getByRole("heading", { name: "Generate a Story" }).click(); // blur → commit
  await page.waitForTimeout(400);
  check(
    "blur commits the edit",
    await page.getByText("third scene EDITED").first().isVisible().catch(() => false),
  );
  check(
    "commit toast shown",
    await page.getByText("Scene prompt updated.").first().isVisible().catch(() => false),
  );

  // --- E: per-scene re-run (idle story) ----------------------------------
  await page.locator('button[aria-label="Re-render scene 1"]').first().hover();
  await page.screenshot({ path: `${OUT}story-rerun-hover.png`, fullPage: true });
  await page.locator('button[aria-label="Re-render scene 1"]').first().click();
  await page.waitForTimeout(300);
  check(
    "re-run toast (idle → wait for Generate)",
    await page
      .getByText("Scene re-queued — press Generate to render it.")
      .first()
      .isVisible()
      .catch(() => false),
  );
  check("re-run alone does not render", genCalls.length === 2, `${genCalls.length}`);
  await pressGenerate(); // renders requeued scene 1, then chained scene 3
  await page.waitForFunction(() => true, { timeout: 100 }).catch(() => {});
  await page.waitForTimeout(2500);
  check("Generate renders exactly the two queued scenes", genCalls.length === 4, `${genCalls.length}`);
  check(
    "re-run keeps scene 1's original prompt",
    typeof genCalls[2]?.prompt === "string" &&
      genCalls[2].prompt.includes("first scene of the verify story"),
  );
  check(
    "chained scene 3 renders with the edited prompt",
    typeof genCalls[3]?.prompt === "string" && genCalls[3].prompt.includes("third scene EDITED"),
  );

  // --- F: reorder ---------------------------------------------------------
  const before = await page.evaluate(() =>
    [...document.querySelectorAll("p.line-clamp-2")].map((p) => p.textContent?.trim()),
  );
  await page.locator('button[aria-label="Move scene 1 later"]').click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() =>
    [...document.querySelectorAll("p.line-clamp-2")].map((p) => p.textContent?.trim()),
  );
  check(
    "reorder swaps scene order",
    before.length === 3 &&
      after.length === 3 &&
      before[0] === after[1] &&
      before[1] === after[0] &&
      before[2] === after[2],
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  );
  check(
    "first scene's up arrow disabled",
    await page.locator('button[aria-label="Move scene 1 earlier"]').isDisabled().catch(() => false),
  );
  await page.screenshot({ path: `${OUT}story-reordered.png`, fullPage: true });

  // --- G: mobile single column -------------------------------------------
  const storyId = await page.evaluate(() => sessionStorage.getItem("perabyte.active_story"));
  // A fresh context has empty localStorage too — carry the whole asset store.
  const assets = await page.evaluate(() => localStorage.getItem("perabyte.assets.v2") ?? "[]");
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mobile.newPage();
  await mpage.addInitScript(
    ({ id, store }) => {
      window.localStorage.setItem("perabyte.assets.v2", store);
      window.sessionStorage.setItem("perabyte.active_story", id ?? "");
    },
    { id: storyId, store: assets },
  );
  await mpage.goto(`${BASE}/story`, { waitUntil: "domcontentloaded" });
  await mpage.waitForSelector("p.line-clamp-2", { timeout: 10000 });
  const mGrid = await mpage.evaluate(() => {
    const labels = [...document.querySelectorAll("p")].filter((p) =>
      /^Scene \d+$/.test(p.textContent?.trim() ?? ""),
    );
    return labels.map((p) => Math.round(p.getBoundingClientRect().y));
  });
  check(
    "mobile stacks scenes in one column",
    mGrid.length >= 2 && mGrid[0] !== mGrid[1],
    JSON.stringify(mGrid),
  );
  await mpage.screenshot({ path: `${OUT}story-mobile.png`, fullPage: true });
  await mobile.close();
} catch (error) {
  console.log("SCRIPT ERROR:", String(error).slice(0, 400));
  results.push({ name: "script completed without throwing", ok: false });
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (consoleErrors.length) {
    console.log("Console errors:");
    for (const e of consoleErrors.slice(0, 10)) console.log(`  - ${e}`);
  }
  await browser.close();
  process.exit(failed.length ? 1 : 0);
}

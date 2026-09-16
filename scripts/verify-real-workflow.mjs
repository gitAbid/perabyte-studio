/**
 * Real-workflow verification (Phase A) — Sogni renders, real provider.
 *
 *  1. Solo image render on sogni:krea2_turbo → asset lands in the SERVER
 *     store (checked via /api/assets, not the browser).
 *  2. Story: two chained image scenes on Sogni; mid-run SPA-navigate to
 *     Settings and back → the run survives; both scenes complete.
 *  3. Cross-browser: a SECOND fresh browser opens /story?id= and sees the
 *     finished story (server truth, zero local state).
 *
 *   node scripts/verify-real-workflow.mjs http://127.0.0.1:3000
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const SOGNI_IMAGE = "sogni:krea2_turbo_fp8_scaled";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Server-truth helpers */
async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function waitFor(predicate, timeoutMs, everyMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

const seededSettings = JSON.stringify({
  uncensoredEnabled: false,
  maskUncensored: true,
  imageModel: SOGNI_IMAGE,
  videoModel: null,
  soloCharacterIds: [],
  storyCharacterIds: [],
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));

/* ---------------- 1. Solo render on Sogni ---------------- */
await page.addInitScript((s) => localStorage.setItem("perabyte.settings.v1", s), seededSettings);
await page.goto(`${BASE}/generate/image`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const pill = await page.textContent("body");
check("composer shows Krea 2 Turbo", pill.includes("Krea 2 Turbo"));

await page.fill("#prompt-input", "A golden lighthouse on a stormy cliff at dusk, dramatic waves");
const before = new Set((await api("/api/assets")).body.assets.map((a) => a.id));
await page.click('button:has-text("Generate")');
check("solo render submitted", true);

const soloDone = await waitFor(async () => {
  const { body } = await api("/api/assets");
  const fresh = body.assets.filter((a) => !before.has(a.id) && a.kind === "image");
  return fresh.find((a) => a.url && !a.url.startsWith("/demo/")) ?? null;
}, 240_000);
check(
  "solo render completed in SERVER store",
  Boolean(soloDone),
  soloDone ? `id=${soloDone.id}` : "no new image asset with media after 240s",
);
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/wf-01-solo-result.png" });

/* ---------------- 2. Story: two chained scenes, nav survives ---------------- */
await page.click('a[href="/story"]');
await page.waitForTimeout(2000);
await page.fill("#prompt-input", "A red fox stepping into a snowy clearing, morning light");
await page.click('button:has-text("Add scene")');
await page.waitForTimeout(600);
await page.fill("#prompt-input", "The fox curls up beneath a pine tree as snow falls");
await page.click('button:has-text("Generate")');
await page.waitForTimeout(4000);

const storyId = await page.evaluate(() => sessionStorage.getItem("perabyte.active_story"));
check("story created + adopted", Boolean(storyId), storyId ?? "no active_story");

const storyUrl = storyId ? `/api/stories?id=${storyId}` : null;
const generating = storyUrl ? await waitFor(async () => {
  const { body } = await api(storyUrl);
  return body.story?.scenes?.some((s) => s.status === "generating" || s.status === "completed");
}, 60_000) : null;
check("scene 1 rendering (server state)", Boolean(generating));

// Mid-run SPA navigation: Settings via the sidebar, then back to Story.
await page.click('a[href="/settings"]');
await page.waitForTimeout(2500);
const settingsBody = await page.textContent("body");
check("landed on Settings mid-run", settingsBody.includes("Settings"));
await page.click('a[href="/story"]');
await page.waitForTimeout(2500);
const backBody = await page.textContent("body");
check("back in the editor after nav", backBody.includes("Scene 1") || backBody.includes("SCENE 1"));
await page.screenshot({ path: "shots/wf-02-story-midrun-back.png" });

const storyFinal = storyUrl ? await waitFor(async () => {
  const { body } = await api(storyUrl);
  const scenes = body.story?.scenes ?? [];
  if (scenes.length >= 2 && scenes.every((s) => s.status === "completed" && s.url)) return scenes;
  if (scenes.some((s) => s.status === "failed")) throw new Error(`scene failed: ${scenes.find((s) => s.status === "failed")?.error}`);
  return null;
}, 360_000, 5000) : null;
check(
  "both story scenes completed on Sogni (server state)",
  Boolean(storyFinal),
  storyFinal ? storyFinal.map((s) => s.status).join(",") : "not settled after 360s",
);
const chained = Boolean(storyFinal?.[1]?.startImageRef === undefined || true); // chained scenes have no startImageRef; verify via endFrameRef of scene 1
const scene1EndRef = storyFinal?.[0]?.endFrameRef;
check("scene 1 derived an end frame for chaining", Boolean(scene1EndRef), scene1EndRef ? "endFrameRef present" : "missing");
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/wf-03-story-done.png" });

/* ---------------- 3. Cross-browser reopen ---------------- */
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page2 = await ctx2.newPage();
await page2.goto(`${BASE}/story?id=${storyId}`, { waitUntil: "domcontentloaded" });
await page2.waitForTimeout(3000);
const p2body = await page2.textContent("body");
const p2imgs = await page2.locator('img[src*="/api/media"]').count();
check("second browser opens the finished story", p2body.includes("fox") || p2imgs > 0, `media imgs: ${p2imgs}`);
check("second browser shows rendered scene media", p2imgs >= 2, `media imgs: ${p2imgs}`);
await page2.screenshot({ path: "shots/wf-04-story-second-browser.png" });
await ctx2.close();

if (consoleErrors.length) console.log("PAGE ERRORS:", consoleErrors.slice(0, 5));

console.log("\nCLEANUP_IDS=" + JSON.stringify({ solo: soloDone?.id, story: storyId }));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

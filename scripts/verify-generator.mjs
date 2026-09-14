/**
 * Verifies the compact generator layout: the whole screen must fit inside the
 * viewport (no page scrolling) and the composer badges must open their menus.
 *
 *   node scripts/verify-generator.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const OUT = new URL("../shots/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

const PAGES = [
  { path: "/generate/image", label: "image" },
  { path: "/generate/video", label: "video" },
];

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});

const report = { fits: [], overflow: [], consoleErrors: [] };

for (const vp of VIEWPORTS) {
  for (const page of PAGES) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const p = await context.newPage();
    p.on("console", (m) => {
      if (m.type() === "error") {
        report.consoleErrors.push({ page: page.label, vp: vp.name, text: m.text().slice(0, 180) });
      }
    });

    await p.goto(`${BASE}${page.path}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);

    const metrics = await p.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      bodyScroll: document.body.scrollHeight,
      composer: !!document.querySelector("#prompt-input"),
      pills: [...document.querySelectorAll('button[aria-haspopup="listbox"]')].map(
        (b) => b.getAttribute("aria-label"),
      ),
    }));

    const entry = {
      viewport: `${vp.width}x${vp.height}`,
      page: page.label,
      scrollHeight: metrics.scrollHeight,
      innerHeight: metrics.innerHeight,
      overflowPx: metrics.scrollHeight - metrics.innerHeight,
      pills: metrics.pills.length,
    };
    if (metrics.scrollHeight > metrics.innerHeight + 2) report.overflow.push(entry);
    else report.fits.push(entry);

    await p.screenshot({
      path: `${OUT}gen-${page.label}-${vp.name}.png`,
      fullPage: false,
    });

    await context.close();
  }
}

/* --- badge menus open and select ---------------------------------------- */
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p = await context.newPage();
await p.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
await p.waitForTimeout(800);

const selections = {};
try {
  for (const [name, choose] of [
    ["Aspect ratio", "9:16"],
    ["Resolution", "720p"],
    ["Style", "Cinematic"],
  ]) {
    await p.click(`button[aria-label^="${name}"]`);
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${OUT}gen-menu-${name.split(" ")[0].toLowerCase()}.png` });
    await p.click(`div[role="listbox"][aria-label="${name}"] button:has-text("${choose}")`);
    await p.waitForTimeout(250);
    selections[name] = await p.getAttribute(`button[aria-label^="${name}"]`, "aria-label");
  }
} catch (error) {
  report.menuError = error.message.slice(0, 300);
}
await p.screenshot({ path: `${OUT}gen-after-selection.png` });

const stillFits = await p.evaluate(
  () => document.documentElement.scrollHeight <= window.innerHeight + 2,
);

/* --- advanced panel opens ----------------------------------------------- */
await p.click('button[aria-label="Advanced settings"]');
await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}gen-advanced.png` });
const advancedVisible = await p.isVisible("text=Negative prompt");

report.selections = selections;
report.stillFitsAfterSelection = stillFits;
report.advancedPanelVisible = advancedVisible;
await context.close();

/* --- real generation, then re-check the fit ----------------------------- */
const genResults = [];
for (const [index, vp] of [VIEWPORTS[0], VIEWPORTS[2]].entries()) {
  // The free provider throttles back-to-back renders, so pause between runs.
  if (index > 0) await new Promise((r) => setTimeout(r, 45_000));
  const gctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  const g = await gctx.newPage();
  await g.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
  await g.fill("#prompt-input", "A lighthouse on a rocky cliff at golden hour");
  await g.click('button:has-text("Generate")');
  let genError;
  try {
    await g.waitForSelector("img[alt*='lighthouse' i]", { timeout: 180_000 });
    await g.waitForTimeout(3000);
  } catch (error) {
    genError = error.message.split("\n")[0];
  }
  // Measure the layout either way: a failed render must not break the fit.
  const m = await g.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    failed: !!document.body.innerText.match(/Generation failed/i),
    img: (() => {
      const el = document.querySelector("img[alt*='lighthouse' i]");
      return el ? { w: el.clientWidth, h: el.clientHeight, natural: `${el.naturalWidth}x${el.naturalHeight}` } : null;
    })(),
  }));
  await g.screenshot({ path: `${OUT}gen-result-${vp.name}.png` });
  genResults.push({
    viewport: vp.name,
    overflowPx: m.scrollHeight - m.innerHeight,
    image: m.img,
    failedState: m.failed,
    error: genError,
  });
  await gctx.close();
}
report.generation = genResults;

await browser.close();

console.log(JSON.stringify(report, null, 2));

/**
 * Local verification harness: renders each studio screen and writes
 * screenshots to ./shots plus a JSON report of console errors and image
 * load failures. Run with the production server already up on :3000.
 *
 *   node scripts/verify.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const OUT = new URL("../shots/", import.meta.url).pathname;

const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 414, height: 900 };

const SHOTS = [
  { name: "01-home", path: "/", viewport: DESKTOP, full: true },
  { name: "02-generate-image", path: "/generate/image", viewport: DESKTOP, full: true },
  { name: "03-generate-video", path: "/generate/video", viewport: DESKTOP, full: true },
  { name: "04-story", path: "/story", viewport: DESKTOP, full: true },
  { name: "05-history", path: "/history", viewport: DESKTOP, full: true },
  { name: "07-styleguide", path: "/styleguide", viewport: DESKTOP, full: true },
  { name: "08-home-mobile", path: "/", viewport: MOBILE, full: true },
  { name: "09-generate-mobile", path: "/generate/image", viewport: MOBILE, full: true },
  { name: "10-history-mobile", path: "/history", viewport: MOBILE, full: true },
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  // Allows running against a manually provisioned browser build.
  executablePath: process.env.PW_EXECUTABLE || undefined,
});
const report = { base: BASE, shots: [], consoleErrors: [], failedRequests: [] };

for (const shot of SHOTS) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      report.consoleErrors.push({ page: shot.name, text: msg.text().slice(0, 300) });
    }
  });
  page.on("requestfailed", (req) => {
    report.failedRequests.push({
      page: shot.name,
      url: req.url().slice(0, 120),
      error: req.failure()?.errorText ?? "unknown",
    });
  });

  await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle", timeout: 60_000 });
  // let provider images settle
  await page.waitForTimeout(2500);

  if (shot.full) {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = () => {
          window.scrollBy(0, 600);
          y += 600;
          if (y < document.body.scrollHeight) setTimeout(step, 120);
          else resolve();
        };
        step();
      });
    });
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
  }

  const images = await page.evaluate(() =>
    [...document.images].map((img) => ({
      src: img.currentSrc.slice(0, 70),
      loaded: img.complete && img.naturalWidth > 0,
      natural: `${img.naturalWidth}x${img.naturalHeight}`,
    })),
  );

  const text = await page.evaluate(() => document.body.innerText.slice(0, 400));

  await page.screenshot({
    path: `${OUT}${shot.name}.png`,
    fullPage: shot.full,
  });

  report.shots.push({
    name: shot.name,
    path: shot.path,
    images: images.length,
    imagesLoaded: images.filter((i) => i.loaded).length,
    brokenImages: images.filter((i) => !i.loaded).map((i) => i.src),
    textSample: text.replace(/\s+/g, " ").slice(0, 200),
  });

  await context.close();
  console.log(`captured ${shot.name}`);
}

/* ------------------- interactive end-to-end generation ------------------- */
const context = await browser.newContext({ viewport: DESKTOP });
const page = await context.newPage();
const e2e = {};

await page.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });

// 1) empty prompt must surface a validation error, not a request
await page.getByRole("button", { name: /generate/i }).first().click();
await page.waitForTimeout(600);
e2e.emptyPromptError = await page
  .getByText(/Describe what you want to create/i)
  .first()
  .isVisible()
  .catch(() => false);
await page.screenshot({ path: `${OUT}11-validation-error.png`, fullPage: true });

// 2) real generation
await page.getByRole("textbox").first().fill(
  "A lighthouse on a rocky cliff at golden hour, waves crashing below",
);
await page.getByRole("button", { name: /^generate$/i }).first().click();
await page.waitForSelector("img[alt*='lighthouse' i]", { timeout: 90_000 });

const generated = await page.evaluate(() => {
  const img = document.querySelector("img[alt*='lighthouse' i]");
  return img ? { complete: img.complete, w: img.naturalWidth, h: img.naturalHeight } : null;
});
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}12-generated.png`, fullPage: true });
e2e.generatedImage = generated;

// 3) history should now contain the new render
await page.goto(`${BASE}/history`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
e2e.historyRows = await page.locator("li").filter({ hasText: /Solo Mode/ }).count();
e2e.historyHasLighthouse = await page
  .getByText("Lighthouse", { exact: false })
  .first()
  .isVisible()
  .catch(() => false);
await page.screenshot({ path: `${OUT}13-history-populated.png`, fullPage: true });

report.e2e = e2e;
await context.close();
await browser.close();

console.log(JSON.stringify(report, null, 2));

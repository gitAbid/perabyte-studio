// P0 main flow: landing -> wizard -> validation -> steps -> preview persistence
import { chromium } from "/Users/abid/Projects/perabyte-studio/node_modules/playwright/index.mjs";

const S = "/Users/abid/Projects/perabyte-studio/gui-test-screenshots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text().slice(0, 180)); });
page.on("pageerror", (e) => errors.push("[pageerror] " + String(e).slice(0, 250)));
const glbResponses = [];
page.on("response", (r) => { if (r.url().includes("avatar.glb")) glbResponses.push(`${r.status()} ${r.url()}`); });

// T1: landing
await page.goto("http://localhost:3100/character", { waitUntil: "networkidle", timeout: 60000 });
await page.screenshot({ path: `${S}/t1_landing.png` });
console.log("T1 landing h1:", JSON.stringify(await page.locator("h1, h2").allTextContents()));

// enter wizard
await page.getByRole("button", { name: /get started/i }).first().click();
await page.waitForTimeout(900);
await page.screenshot({ path: `${S}/t2_step1.png` });
console.log("T2 step1 h2:", JSON.stringify(await page.locator("h2").allTextContents()));

// T3: prompt validation — click Next with empty prompt
await page.getByRole("button", { name: /^Next$/ }).click();
await page.waitForTimeout(400);
const validationMsg = await page.locator("text=/describe your character/i").count();
await page.screenshot({ path: `${S}/t3_validation.png` });
console.log("T3 validation error shown:", validationMsg > 0);

// fill prompt and advance
await page.locator("textarea").first().fill("A calm adventurer with sharp eyes.");
await page.getByRole("button", { name: /^Next$/ }).click();
await page.waitForTimeout(4500); // GLB load + settle
await page.screenshot({ path: `${S}/t4_step2_preview.png` });
const h2s = await page.locator("h2").allTextContents();
console.log("T4 step2 h2:", JSON.stringify(h2s));
console.log("GLB responses:", JSON.stringify(glbResponses));

// canvas non-empty check (read-only geometry)
const canvasInfo = await page.locator("canvas").first().evaluate((el) => ({
  w: el.width, h: el.height, visible: !!el.offsetParent }));
console.log("T4 canvas:", JSON.stringify(canvasInfo));

// T5: walk 2 -> 3 -> 4 -> 2 and confirm preview (h2 'Live 3D Preview') persists
const previewVisible = [];
for (const next of [true, true, false]) {
  if (next) await page.getByRole("button", { name: /^Next$/ }).click();
  else await page.getByRole("button", { name: /^Back$/ }).first().click();
  await page.waitForTimeout(600);
  previewVisible.push(await page.getByText("Live 3D Preview").count() > 0);
}
await page.screenshot({ path: `${S}/t5_step4.png` });
console.log("T5 preview visible at steps 3,4,(back to)3:", JSON.stringify(previewVisible));
console.log("step4 h2:", JSON.stringify(await page.locator("h2").allTextContents()));

// T5b: Generate button present on review
await page.getByRole("button", { name: /^Next$/ }).click();
await page.waitForTimeout(600);
const genBtn = await page.getByRole("button", { name: /generate character/i }).count();
console.log("T5b Generate Character button present:", genBtn > 0);

console.log("CONSOLE_ERRORS:", JSON.stringify(errors.slice(0, 10), null, 1));
await browser.close();

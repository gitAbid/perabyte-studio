/**
 * Ad-hoc verification of the provider-integration UI surfaces:
 * model pill, settings dialog (uncensored gate), and the character landing
 * lock state. Run with the production server up:
 *
 *   node scripts/verify-provider-ui.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const OUT = new URL("../shots/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});
const report = {};

/* 1 — model pill on the solo generator */
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
report.modelPillVisible = await page
  .getByRole("button", { name: /Model: Flux/i })
  .isVisible()
  .catch(() => false);
await page.getByRole("button", { name: /Model: Flux/i }).click().catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}provider-01-model-menu.png` });
report.modelMenuOptions = await page
  .locator("[role='option']")
  .allInnerTexts()
  .catch(() => []);

/* 2 — settings page: uncensored gate default off (moved from account menu to /settings) */
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}provider-02-settings.png` });
report.settingsDialogOpen = await page
  .getByText("Uncensored Mode")
  .first()
  .isVisible()
  .catch(() => false);
report.uncensoredDefaultOff = await page
  .getByRole("switch", { name: "Uncensored Mode" })
  .getAttribute("aria-checked")
  .then((v) => v === "false")
  .catch(() => false);

/* 3 — enabling uncensored asks for 18+ confirmation */
await page.getByRole("switch", { name: "Uncensored Mode" }).click().catch((e) => { report.switchClickError = e.message.split("\n")[0]; });
await page.waitForTimeout(300);
report.confirmShown = await page
  .getByText("Enable Uncensored Mode?")
  .isVisible()
  .catch(() => false);
await page.getByRole("button", { name: "Cancel" }).last().click().catch(() => {});
await page.keyboard.press("Escape");
await page.close();

/* 4 — character landing: reachable and renders clean */
const charPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await charPage.goto(`${BASE}/character`, { waitUntil: "networkidle" });
await charPage.waitForTimeout(600);
report.characterLandingOk = await charPage
  .getByRole("heading", { level: 1 })
  .isVisible()
  .catch(() => false);
await charPage.screenshot({ path: `${OUT}provider-03-character.png` });
await charPage.close();

await browser.close();
console.log(JSON.stringify(report, null, 2));
process.exit(
  report.modelPillVisible &&
    report.settingsDialogOpen &&
    report.uncensoredDefaultOff &&
    report.confirmShown &&
    report.characterLandingOk
    ? 0
    : 1,
);

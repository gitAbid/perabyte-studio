/**
 * GUI smoke for the Custom providers settings block.
 *   node scripts/verify-custom-providers-gui.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3100";
const envKey =
  readFileSync(new URL("../.env.local", import.meta.url), "utf-8")
    .split("\n")
    .find((l) => l.startsWith("APIKEY_FAN_API_KEY="))
    ?.split("=")
    .slice(1)
    .join("=")
    .trim() ?? "";
const API_KEY = process.env.APIKEY_FAN_API_KEY ?? envKey;
const OUT = new URL("../gui-test-screenshots/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});

const report = { checks: [], consoleErrors: [] };
function check(name, ok, detail = "") {
  report.checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") report.consoleErrors.push(m.text().slice(0, 180));
});

async function deleteLeftovers() {
  // Remove GUI Relay rows from previous runs so ids never collide.
  for (;;) {
    const expand = page.getByRole("button", { name: /GUI Relay details/i }).first();
    if ((await expand.count()) === 0) return;
    await expand.click();
    await page.getByRole("button", { name: "Delete", exact: true }).first().click();
    await page.getByRole("button", { name: /confirm delete/i }).first().click();
    await page.waitForTimeout(800);
  }
}

try {
  await page.goto(`${BASE}/settings?section=providers`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await deleteLeftovers();

  // The custom block exists with an Add provider button.
  const add = page.getByRole("button", { name: /add provider/i });
  await add.waitFor({ state: "visible", timeout: 5_000 });
  check("custom providers block renders with Add provider", true);

  // Open the form, fill it against the real relay.
  await add.click();
  await page.getByLabel(/^name$/i).fill("GUI Relay");
  await page.getByLabel(/base url/i).fill("https://apikey.fan/v1");
  const key = API_KEY;
  await page.getByLabel(/api key/i).fill(key);

  await page.getByRole("button", { name: /fetch models/i }).click();
  await page.getByText(/models found/i).waitFor({ state: "visible", timeout: 20_000 });
  check("fetch models previews classified list", true);
  await page.screenshot({ path: `${OUT}custom-providers-preview.png`, fullPage: true });

  // Save, then verify the row appears.
  await page.getByRole("button", { name: /save provider/i }).click();
  await page.getByText("GUI Relay").first().waitFor({ state: "visible", timeout: 8_000 });
  check("saved provider row appears", true);

  // Expand the row: kind selects exist.
  await page.getByRole("button", { name: /show GUI Relay details/i }).first().click();
  const kindSelect = page.getByLabel('Kind for grok-imagine-image', { exact: true });
  await kindSelect.waitFor({ state: "visible", timeout: 5_000 });
  const kindValue = await kindSelect.inputValue();
  check("model row shows image kind select", kindValue === "image", kindValue);
  await page.screenshot({ path: `${OUT}custom-providers-row.png`, fullPage: true });

  // Re-label one model's kind, verify the PATCH round-trips (value persists).
  await kindSelect.selectOption("off");
  await page.waitForTimeout(700);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: /show GUI Relay details/i }).first().click();
  const reloaded = await page
    .getByLabel('Kind for grok-imagine-image', { exact: true })
    .inputValue();
  check("kind change persists across reload", reloaded === "off", reloaded);

  // Delete the provider (two-step confirm) and verify it leaves the list.
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByRole("button", { name: /confirm delete/i }).click();
  await page.waitForTimeout(800);
  const gone = await page.getByText("GUI Relay").count();
  check("delete removes the provider", gone === 0);
  await page.screenshot({ path: `${OUT}custom-providers-after-delete.png`, fullPage: true });
} finally {
  if (report.consoleErrors.length) {
    console.log("console errors:", JSON.stringify(report.consoleErrors.slice(0, 5), null, 2));
  }
  await browser.close();
}

const pass = report.checks.every(Boolean) && report.consoleErrors.length === 0;
console.log(pass ? "\nGUI SMOKE PASSED" : "\nGUI SMOKE FAILED");
process.exit(pass ? 0 : 1);

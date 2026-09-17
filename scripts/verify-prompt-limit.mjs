/**
 * GUI verification for the configurable prompt budget (Settings → General).
 * Run against a dev server: node scripts/verify-prompt-limit.mjs [baseURL]
 * Checks:
 *  1. Solo composer counter shows the configured budget (0/5000).
 *  2. Settings → General exposes the "Prompt character limit" field.
 *  3. Lowering the budget updates the open Solo page (focus/sync refetch).
 *  4. The textarea maxLength follows (paste a 600-char prompt at 300 budget).
 *  5. Writer scene-copy mentions the live budget.
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3222";
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Reset to the default budget before starting.
  await page.request.put(`${BASE}/api/settings`, { data: { promptMaxChars: 5000 } });

  // 1. Solo composer counter.
  await page.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
  const counter = page.locator("text=/^0\\/5000$/").first();
  await counter.waitFor({ timeout: 15000 }).catch(() => undefined);
  check("Solo counter shows 0/5000", await counter.isVisible().catch(() => false));

  // 2. Settings → General field.
  await page.goto(`${BASE}/settings?section=general`, { waitUntil: "networkidle" });
  const field = page.getByLabel("Prompt character limit");
  await field.waitFor({ timeout: 15000 }).catch(() => undefined);
  check("Settings General has the prompt limit field", await field.isVisible().catch(() => false));
  check("Field shows the default 5000", (await field.inputValue().catch(() => "")) === "5000");

  // 3. Lower the budget via the UI; PUT should fire on blur/Enter.
  await field.fill("300");
  await field.press("Enter");
  await page.waitForTimeout(1200);
  const api = await (await page.request.get(`${BASE}/api/settings`)).json();
  check("UI save persists 300", api.promptMaxChars === 300, `api=${api.promptMaxChars}`);

  // 4. Open Solo in the same tab; focus should refresh the store.
  await page.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
  const counter300 = page.locator("text=/^0\\/300$/").first();
  await counter300.waitFor({ timeout: 15000 }).catch(() => undefined);
  check("Solo counter follows the lower budget (0/300)", await counter300.isVisible().catch(() => false));

  // maxLength: the DOM attribute must carry the live budget, and real user
  // typing is clamped by the browser (programmatic value-set bypasses it by
  // design, so this simulates actual input).
  const attr = await page.locator("#prompt-input").getAttribute("maxlength");
  check("Textarea maxlength attribute is the live budget", attr === "300", `maxlength=${attr}`);
  await page.locator("#prompt-input").click();
  await page.keyboard.type("z".repeat(305), { delay: 0 });
  await page.waitForTimeout(300);
  const len = await page.locator("#prompt-input").inputValue().then((v) => v.length);
  check("Typing beyond the budget clamps to 300", len === 300, `len=${len}`);

  // 5. Writer page copy mentions the live budget.
  await page.goto(`${BASE}/writer`, { waitUntil: "networkidle" });
  const copy = page.locator("text=/scenes break at ~300 characters/").first();
  await copy.waitFor({ timeout: 15000 }).catch(() => undefined);
  check("Writer copy shows the live budget", await copy.isVisible().catch(() => false));

  // Restore the default.
  await page.request.put(`${BASE}/api/settings`, { data: { promptMaxChars: 5000 } });
  check("Default restored", (await (await page.request.get(`${BASE}/api/settings`)).json()).promptMaxChars === 5000);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

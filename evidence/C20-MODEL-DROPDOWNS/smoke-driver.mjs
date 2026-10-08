#!/usr/bin/env node
/**
 * C20-MODEL-DROPDOWNS GUI smoke (offline, localhost only, zero spend).
 *
 * Seeds a throwaway project through the accepted UI flow (create wizard -> story approval ->
 * plan build -> shot plan + animatic approvals — the C19 driver's path), then verifies the
 * C20 generate-form dropdowns on the anchors and takes pages:
 *   - Provider + Model are real SELECT elements (no free-text inputs remain);
 *   - the model select holds the production baseline entries (anchor flux1-schnell-fp8;
 *     take minimax-h3 i2v variants) served by GET /api/production/models?kind=...;
 *   - defaults are preselected and the PROVIDER_MODEL_REQUIRED gate reason is gone on load;
 *   - the anchors submit button is enabled; the takes gate shows only the by-design
 *     ANCHOR_APPROVAL_REQUIRED reason (an offline seed can never hold an approved anchor).
 *
 * Media safety: every network request is recorded; any request to media-quotes, anchors, takes
 * or jobs endpoints FAILS the run (zero media-quotes, zero enqueues). The script never starts
 * the server: it requires an already-healthy stack at the given base URL.
 *
 * Usage: node smoke-driver.mjs http://127.0.0.1:3211 <screenshot-dir> <log-file>
 */
import { chromium } from "playwright";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3211").replace(/\/$/, "");
const SHOT_DIR = (process.argv[3] ?? new URL("./screenshots/", import.meta.url).pathname).replace(/\/?$/, "/");
const LOG_FILE = process.argv[4] ?? new URL("./smoke.log", import.meta.url).pathname;
mkdirSync(SHOT_DIR, { recursive: true });
writeFileSync(LOG_FILE, "");
const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
  if (!ok) failures += 1;
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}${name}.png`, fullPage: true });
  appendFileSync(LOG_FILE, `SCREENSHOT ${name}.png\n`);
}

/* Media safety net: record every request; media-generation endpoints are forbidden. */
const mediaRequests = [];

const health = await fetch(`${BASE}/api/production/health`).catch(() => null);
if (!health || !health.ok) {
  console.log(`BLOCKED: no healthy production server at ${BASE}`);
  process.exit(1);
}
check("server health", true, BASE);

/* Route-level sanity on the live server before the browser flow. */
for (const [kind, expectedFirst] of [["anchor", "flux1-schnell-fp8"], ["take", "minimax-h3-fl2va-fp8_i2v_turbo"]]) {
  const response = await fetch(`${BASE}/api/production/models?kind=${kind}`);
  const body = await response.json().catch(() => null);
  const ok = response.status === 200
    && response.headers.get("cache-control") === "no-store"
    && body?.provider?.id === "sogni"
    && Array.isArray(body?.models)
    && body.models[0]?.id === expectedFirst
    && (kind !== "take" || (body.models.every((m) => m.mode === "image-to-video") && body.models.some((m) => m.id === "minimax-h3-fl2va-fp8_i2v")));
  check(`route /api/production/models?kind=${kind}`, ok, JSON.stringify(body?.models?.map((m) => m.id) ?? body));
}
const badKind = await fetch(`${BASE}/api/production/models?kind=nonsense`);
check("route rejects invalid kind", badKind.status === 400, `status ${badKind.status}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/api/production/")) mediaRequests.push(url);
});
page.setDefaultTimeout(15000);

try {
  /* 1. Seed the project through the accepted wizard (C19 flow). */
  await page.goto(`${BASE}/production/new`, { waitUntil: "networkidle" });
  await page.fill("#project-name", "C20 Model Dropdowns Smoke");
  await page.getByRole("button", { name: "Next: Cast" }).click();
  await page.fill('[id$="-entity-id"]', "char_ayo");
  await page.fill('[id$="-description"]', "Ayo, a young harbor pilot");
  await page.getByRole("button", { name: "Next: World" }).click();
  await page.getByLabel("Entity ID").first().fill("loc_harbor");
  await page.getByLabel("Description").first().fill("A foggy harbor at dawn");
  await page.getByRole("button", { name: "Add another world draft" }).click();
  await page.getByLabel("Entity kind").nth(1).selectOption("style");
  await page.getByLabel("Entity ID").nth(1).fill("style_book");
  await page.getByLabel("Description").nth(1).fill("Ink-and-water storybook style");
  await page.getByRole("button", { name: "Next: Script" }).click();
  const scriptText = "The narrator opens the film on a quiet harbor at dawn while Ayo checks her skiff.\n\nAyo boards the skiff and says the tide is turning; the harbor wakes behind her.";
  await page.fill("textarea", scriptText);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/production\/(?!new$)[A-Za-z0-9][A-Za-z0-9_.:-]*$/, { timeout: 30000 });
  const projectId = new URL(page.url()).pathname.split("/").pop();
  check("project created", /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(projectId) && projectId !== "new", projectId);

  /* 2. Story approval. */
  await page.goto(`${BASE}/production/${projectId}/script`, { waitUntil: "networkidle" });
  const approval = page.locator('[data-testid="story-approval-workspace"]');
  const boxes = approval.locator('input[type="checkbox"]');
  const noteInputs = approval.locator('input[aria-label^="Note for checklist item"]');
  await noteInputs.nth(0).fill("Protagonist goal stated in the opening beat.");
  await noteInputs.nth(4).fill("Narration reviewed aloud; no dialogue yet.");
  for (let i = 0; i < 5; i += 1) await boxes.nth(i).check();
  await page.getByTestId("story-approve-button").click();
  await page.locator('[data-testid="story-approval-section"]').getByText(/approved and current|Story approved/).first().waitFor({ timeout: 20000 });
  check("story approved", true);

  /* 3. Plan build + approvals. */
  await page.goto(`${BASE}/production/${projectId}/plan`, { waitUntil: "networkidle" });
  await page.getByTestId("plan-builder").waitFor();
  await page.fill("#wardrobe-char_ayo", "Oilskin coat over a knit sweater");
  const cast2 = page.locator('[data-testid="plan-shot-draft"][data-shot-id="shot_2"]').locator("label", { hasText: "char_ayo" });
  await cast2.locator('input[type="checkbox"]').check();
  await page.getByTestId("create-plan-button").click();
  await page.getByTestId("plan-created-banner").waitFor({ timeout: 20000 });
  const planWorkspace = page.locator('[data-testid="shotplan-approve-workspace"]');
  const planBoxes = planWorkspace.locator('input[type="checkbox"]');
  for (let i = 0; i < 5; i += 1) await planBoxes.nth(i).check();
  await page.getByTestId("shotplan-approve-button").click();
  await page.getByTestId("shotplan-approved").waitFor({ timeout: 20000 });
  const animaticBoxes = page.locator('[data-testid="animatic-approve-workspace"]').locator('input[type="checkbox"]');
  for (let i = 0; i < 5; i += 1) await animaticBoxes.nth(i).check();
  await page.getByTestId("animatic-approve-button").click();
  await page.getByTestId("animatic-approved").waitFor({ timeout: 20000 });
  check("plan + animatic approved", true);

  /* 4. Anchors page: Provider/Model are selects, baseline served, default preselected, gate clean. */
  await page.goto(`${BASE}/production/${projectId}/anchors`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="anchor-submit-form"]').first().waitFor();
  const providerSelect = page.getByTestId("anchor-provider-input").first();
  const modelSelect = page.getByTestId("anchor-model-input").first();
  check("anchors: provider control is a SELECT", (await providerSelect.evaluate((el) => el.tagName)) === "SELECT");
  check("anchors: model control is a SELECT", (await modelSelect.evaluate((el) => el.tagName)) === "SELECT");
  check("anchors: provider offers sogni", (await providerSelect.locator("option").allTextContents()).includes("sogni"));
  const anchorOptionValues = await modelSelect.locator("option").evaluateAll((options) => options.map((option) => option.value));
  check("anchors: baseline flux1-schnell-fp8 served", anchorOptionValues.includes("flux1-schnell-fp8"), anchorOptionValues.join(", "));
  await modelSelect.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const select = document.querySelectorAll('[data-testid="anchor-model-input"]')[0];
    return select instanceof HTMLSelectElement && select.options.length > 0 && select.options[0]?.text !== "Loading models…";
  });
  check("anchors: default preselected", (await modelSelect.inputValue()) === "flux1-schnell-fp8", await modelSelect.inputValue());
  const anchorGate = page.locator('[data-testid="anchor-submit-gate-reasons"]').first();
  const anchorGateText = (await anchorGate.count()) === 0 ? "" : (await anchorGate.textContent()) ?? "";
  check("anchors: PROVIDER_MODEL_REQUIRED gone", !anchorGateText.includes("PROVIDER_MODEL_REQUIRED"), anchorGateText.slice(0, 120));
  check("anchors: submit enabled", !(await page.getByTestId("anchor-submit-button").first().isDisabled()));
  await shot(page, "01-anchors-dropdowns");

  /* 5. Takes page: selects hold the i2v baseline; only the by-design anchor-approval gate remains. */
  await page.goto(`${BASE}/production/${projectId}/takes`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="take-submit-form"]').first().waitFor();
  const takeProvider = page.getByTestId("take-provider-input").first();
  const takeModel = page.getByTestId("take-model-input").first();
  check("takes: provider control is a SELECT", (await takeProvider.evaluate((el) => el.tagName)) === "SELECT");
  check("takes: model control is a SELECT", (await takeModel.evaluate((el) => el.tagName)) === "SELECT");
  await page.waitForFunction(() => {
    const select = document.querySelectorAll('[data-testid="take-model-input"]')[0];
    return select instanceof HTMLSelectElement && select.options.length > 0 && select.options[0]?.text !== "Loading models…";
  });
  const takeOptionValues = await takeModel.locator("option").evaluateAll((options) => options.map((option) => option.value));
  check("takes: i2v baseline served", takeOptionValues.includes("minimax-h3-fl2va-fp8_i2v_turbo") && takeOptionValues.includes("minimax-h3-fl2va-fp8_i2v"), takeOptionValues.join(", "));
  check("takes: only i2v image-to-video options", takeOptionValues.length === 2, takeOptionValues.join(", "));
  check("takes: default preselected", (await takeModel.inputValue()) === "minimax-h3-fl2va-fp8_i2v_turbo", await takeModel.inputValue());
  const promptInput = page.locator('[id^="take-"][id$="-prompt"]').first();
  await promptInput.fill("Slow push in as the harbor wakes.");
  const takeGate = page.locator('[data-testid="take-submit-gate-reasons"]').first();
  const takeGateText = (await takeGate.count()) === 0 ? "" : (await takeGate.textContent()) ?? "";
  check("takes: PROVIDER_MODEL_REQUIRED gone after prompt", !takeGateText.includes("PROVIDER_MODEL_REQUIRED"), takeGateText.slice(0, 160));
  check("takes: only the by-design anchor-approval gate remains", takeGateText.includes("ANCHOR_APPROVAL_REQUIRED") && !takeGateText.includes("STORY_APPROVAL_REQUIRED") && !takeGateText.includes("SHOT_PLAN_APPROVAL_REQUIRED") && !takeGateText.includes("ANIMATIC_APPROVAL_REQUIRED"), takeGateText.slice(0, 160));
  check("takes: submit disabled only by the missing (offline-impossible) anchor approval", await page.getByTestId("take-submit-button").first().isDisabled());
  await shot(page, "02-takes-dropdowns");

  /* 6. Media safety: zero media-quotes / enqueues. */
  const forbidden = mediaRequests.filter((url) =>
    url.includes("/api/production/media-quotes") ||
    /\/api\/production\/shots\/[^/]+\/(anchors|takes|selection)/.test(url) ||
    url.includes("/api/production/jobs"));
  check("zero media-quote/enqueue requests", forbidden.length === 0, forbidden.length === 0 ? `${mediaRequests.length} production API requests, all read/approval/plan` : forbidden.join(" "));
} catch (error) {
  check("driver completed without exception", false, error instanceof Error ? `${error.message} @ ${error.stack?.split("\n")[1] ?? ""}` : String(error));
  await shot(page, "99-failure-state").catch(() => {});
} finally {
  await browser.close();
}

appendFileSync(LOG_FILE, `\n${failures} failure(s)\n`);
console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

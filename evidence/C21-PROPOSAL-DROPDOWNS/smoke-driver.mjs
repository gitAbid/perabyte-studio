#!/usr/bin/env node
/**
 * C21-PROPOSAL-DROPDOWNS GUI smoke (offline, localhost only, zero spend).
 *
 * Verifies the last free-text Provider/Model pair in the production UI — the
 * "PLAN STORY BEATS (PROPOSAL)" form on the script page — now renders as
 * dropdowns fed by GET /api/production/text-engines, and that the deliberate
 * fail-closed proposal boundary is untouched:
 *   - Provider/Model are real SELECT elements (no free-text inputs remain);
 *   - the selects are fed by the text-engines route (sogni + pollinations by
 *     default; empty state renders disabled with the honest Settings pointer);
 *   - provider change resets the model to that provider's first engine;
 *   - the verbatim hint copy and button note are intact;
 *   - clicking "Request story proposal" still surfaces the by-design 403
 *     BUDGET_BLOCKED envelope as the explicit not-entitled state.
 *
 * Media safety: every /api/production request is recorded; any request to
 * media-quotes, anchors, takes, selection or jobs endpoints FAILS the run.
 * The script never starts the server: it requires an already-healthy stack.
 *
 * Usage: node smoke-driver.mjs http://127.0.0.1:3212 <screenshot-dir> <log-file> [--empty]
 *   --empty: expect the honest empty state (server started with every provider disabled).
 */
import { chromium } from "playwright";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3212").replace(/\/$/, "");
const SHOT_DIR = (process.argv[3] ?? new URL("./screenshots/", import.meta.url).pathname).replace(/\/?$/, "/");
const LOG_FILE = process.argv[4] ?? new URL("./smoke.log", import.meta.url).pathname;
const EMPTY_MODE = process.argv.includes("--empty");
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

/* Media safety net: record every production API request; generation is forbidden. */
const productionRequests = [];

const health = await fetch(`${BASE}/api/production/health`).catch(() => null);
if (!health || !health.ok) {
  console.log(`BLOCKED: no healthy production server at ${BASE}`);
  process.exit(1);
}
check("server health", true, `${BASE}${EMPTY_MODE ? " (empty-config mode)" : ""}`);

/* Route-level sanity on the live server before the browser flow. */
const enginesResponse = await fetch(`${BASE}/api/production/text-engines`);
const enginesBody = await enginesResponse.json().catch(() => null);
check(
  "route /api/production/text-engines",
  enginesResponse.status === 200
    && enginesResponse.headers.get("cache-control") === "no-store"
    && enginesBody !== null
    && Array.isArray(enginesBody?.engines)
    && enginesBody.engines.every((engine) =>
      typeof engine?.providerId === "string" && engine.providerId.length > 0
      && typeof engine?.modelId === "string" && engine.modelId.length > 0
      && typeof engine?.label === "string" && engine.label.length > 0
      && Object.keys(engine).length === 3),
  JSON.stringify(enginesBody),
);
const providerIds = [...new Set((enginesBody?.engines ?? []).map((engine) => engine.providerId))];
const sogniModels = (enginesBody?.engines ?? []).filter((engine) => engine.providerId === "sogni").map((engine) => engine.modelId);
check(
  EMPTY_MODE ? "route: honest empty engine list" : "route: default built-in engines served",
  EMPTY_MODE
    ? enginesResponse.status === 200 && enginesBody?.engines?.length === 0
    : providerIds.join(",") === "sogni,pollinations" && sogniModels.length > 0,
  `providerIds=${providerIds.join(",")} models=${sogniModels.length}`,
);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/api/production/")) productionRequests.push(url);
});
page.setDefaultTimeout(15000);

try {
  /* 1. Seed a project through the accepted wizard (C19/C20 flow). */
  await page.goto(`${BASE}/production/new`, { waitUntil: "networkidle" });
  await page.fill("#project-name", "C21 Proposal Dropdowns Smoke");
  await page.getByRole("button", { name: "Next: Cast" }).click();
  await page.fill('[id$="-entity-id"]', "char_ayo");
  await page.fill('[id$="-description"]', "Ayo, a young harbor pilot");
  await page.getByRole("button", { name: "Next: World" }).click();
  await page.getByLabel("Entity ID").first().fill("loc_harbor");
  await page.getByLabel("Description").first().fill("A foggy harbor at dawn");
  await page.getByRole("button", { name: "Next: Script" }).click();
  await page.fill("textarea", "The narrator opens the film on a quiet harbor at dawn while Ayo checks her skiff.\n\nAyo boards the skiff and says the tide is turning; the harbor wakes behind her.");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/production\/(?!new$)[A-Za-z0-9][A-Za-z0-9_.:-]*$/, { timeout: 30000 });
  const projectId = new URL(page.url()).pathname.split("/").pop();
  check("project created", /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(projectId) && projectId !== "new", projectId);
  await shot(page, "01-project-overview");

  /* 2. The proposal form on the script page renders Provider/Model SELECTs. */
  await page.goto(`${BASE}/production/${projectId}/script`, { waitUntil: "networkidle" });
  const proposalSection = page.locator('section[aria-label="Story proposal"]');
  await proposalSection.waitFor();
  const providerSelect = page.locator("#proposal-provider");
  const modelSelect = page.locator("#proposal-model");
  check("proposal provider control is a SELECT", (await providerSelect.evaluate((el) => el.tagName)) === "SELECT");
  check("proposal model control is a SELECT", (await modelSelect.evaluate((el) => el.tagName)) === "SELECT");
  check("no free-text proposal inputs remain",
    (await page.locator('input#proposal-provider, input#proposal-model').count()) === 0);

  await page.waitForFunction(() => {
    const select = document.querySelector("#proposal-provider");
    return select instanceof HTMLSelectElement && select.options.length > 0
      && select.options[0]?.text !== "Loading text engines…";
  });

  if (EMPTY_MODE) {
    /* Honest empty state: both selects disabled with the exact pointer copy. */
    const expectedOption = "No text engines configured — set up providers in Settings";
    const providerTexts = await providerSelect.locator("option").allTextContents();
    const modelTexts = await modelSelect.locator("option").allTextContents();
    check("empty state: provider select disabled", await providerSelect.isDisabled());
    check("empty state: model select disabled", await modelSelect.isDisabled());
    check("empty state: provider select shows the honest copy", providerTexts.includes(expectedOption), providerTexts.join(" | "));
    check("empty state: model select shows the honest copy", modelTexts.includes(expectedOption), modelTexts.join(" | "));
    const sectionText = (await proposalSection.textContent()) ?? "";
    check("empty state: Settings link present", (await proposalSection.getByRole("link", { name: "open Settings" }).count()) === 1
      && sectionText.includes("Providers and models are configured in Settings"));
    await shot(page, "03-proposal-empty-state");
  } else {
    const providerTexts = await providerSelect.locator("option").allTextContents();
    check("provider select offers the deduped chain providers", providerTexts.join(",") === "sogni,pollinations", providerTexts.join(", "));
    const modelOptionValues = await modelSelect.locator("option").evaluateAll((options) => options.map((option) => option.value));
    check("model select fed by the engines route (sogni first)", JSON.stringify(modelOptionValues) === JSON.stringify(sogniModels), modelOptionValues.join(", "));
    check("provider select enabled", !(await providerSelect.isDisabled()));
    check("model select enabled", !(await modelSelect.isDisabled()));
    check("default model preselected to the chain's first sogni engine",
      (await modelSelect.inputValue()) === sogniModels[0], await modelSelect.inputValue());
    check("model option label is model id + provider label",
      ((await modelSelect.locator("option").first().textContent()) ?? "").includes("— Sogni"),
      (await modelSelect.locator("option").first().textContent()) ?? "");

    /* Choosing a provider resets the model to that provider's first engine. */
    await providerSelect.selectOption("pollinations");
    check("provider change resets model to that provider's first engine",
      (await modelSelect.inputValue()) === "pollinations:default", await modelSelect.inputValue());
    await providerSelect.selectOption("sogni");
    check("switching back restores the first sogni engine",
      (await modelSelect.inputValue()) === sogniModels[0], await modelSelect.inputValue());
    await shot(page, "02-proposal-dropdowns");
  }

  /* 3. Verbatim fail-closed copy intact. */
  const sectionText = (await proposalSection.textContent()) ?? "";
  check("provider hint copy verbatim", sectionText.includes("Text proposal provider ID (no entitlement exists yet)."));
  check("model hint copy verbatim", sectionText.includes("Text proposal model ID (no entitlement exists yet)."));
  check("button fail-closed note verbatim",
    sectionText.includes("Text proposal generation has no reviewed entitlement yet — the request reports the exact server decision."));

  /* 4. The request still reports the exact server decision (BUDGET_BLOCKED). */
  await page.getByRole("button", { name: "Request story proposal" }).click();
  await proposalSection.getByText("Script proposal planning is not yet entitled.").waitFor({ timeout: 20000 });
  const outcomeText = (await proposalSection.textContent()) ?? "";
  check("request returns the by-design BUDGET_BLOCKED envelope",
    outcomeText.includes("BUDGET_BLOCKED")
      && outcomeText.includes("Text proposal generation is not authorized: no reviewed text entitlement or standing budget authorization exists for text proposals.")
      && outcomeText.includes("Proposals never apply automatically. Continue editing the script manually."),
    outcomeText.slice(outcomeText.indexOf("BUDGET_BLOCKED"), outcomeText.indexOf("BUDGET_BLOCKED") + 240));
  await shot(page, "04-proposal-not-entitled");
} catch (error) {
  check("driver completed without exception", false, error instanceof Error ? `${error.message} @ ${error.stack?.split("\n")[1] ?? ""}` : String(error));
  await shot(page, "99-failure-state").catch(() => {});
} finally {
  await browser.close();
}

/* 5. Media safety: zero generation requests (the proposals POST is the by-design 403). */
const forbidden = productionRequests.filter((url) =>
  url.includes("/api/production/media-quotes") ||
  /\/api\/production\/shots\/[^/]+\/(anchors|takes|selection)/.test(url) ||
  url.includes("/api/production/jobs"));
check("zero media-quote/enqueue requests", forbidden.length === 0,
  forbidden.length === 0 ? `${productionRequests.length} production API requests, all reads + the one blocked proposal POST` : forbidden.join(" "));

appendFileSync(LOG_FILE, `\n${failures} failure(s)\n`);
console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Creator Alpha golden-path E2E — the single most important test (spec 19 §13).
 *
 *   Create Workspace → Create Character → Approve Character Canon →
 *   Create Environment → Approve Environment Canon → Create Production →
 *   Generate Story → Approve Story → Generate Storyboard Anchor →
 *   Approve Anchor → Generate Take → Select Take → Build First Cut → Export MP4
 *
 * Usage:
 *   node scripts/verify-creator-alpha.mjs [baseUrl]
 *   GOLDEN_PATH_MODE=full GOLDEN_PATH_BASE_URL=http://localhost:3310 node scripts/verify-creator-alpha.mjs
 *
 * Base URL resolution: argv[2], then GOLDEN_PATH_BASE_URL, then the default
 * http://localhost:3310 (this worktree's dev server).
 *
 * Modes (GOLDEN_PATH_MODE, default "ui"):
 *   ui   — never spends. The legacy renderer boundary (/api/jobs: character
 *          sheets, environment plates) is mocked with instant completions (same
 *          pattern as verify-character-sheet.mjs). Production spend steps
 *          (story proposal, anchor/take quotes, assembly, export) assert the
 *          UI reaches the correct ready-to-spend state and STOP at an explicit
 *          "SPEND GATE" line instead of clicking the paid confirmation.
 *   full — controlled live run by the controller: no mocks, every confirmation
 *          is clicked through (real provider + render spend; requires an
 *          entitled, policy-loaded server — see docs/production/pilots/).
 *
 * STORY NOTE (F3 integration): the step-6 wizard's script save now creates the
 * immutable story revision itself, so step 7 usually finds the story already
 * present and needs no AI spend at all. The IdeaComposer path remains for
 * projects without a story: there the server proposals are fail-closed
 * BUDGET_BLOCKED until a text/media entitlement is configured — reported as an
 * explicit, instructive environment block, never a stack trace — and the human
 * Script editor (free, no AI) is the fallback that keeps downstream steps
 * exercisable.
 *
 * Screenshots: gui-test-screenshots/creator-alpha/NN-step-slug.png (one numbered
 * screenshot per step). Exits 1 if any step FAILED; GATED/PLANNED steps are
 * disclosed, not failures. Never touches anything beyond BASE_URL.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/* .env.local via the same readFileSync pattern as verify-custom-providers-gui.mjs.
   Values are loaded into process.env WITHOUT overriding existing variables and
   are never printed. This script itself needs no secrets (the browser talks to
   the local server only); the load exists so GOLDEN_PATH_* overrides and any
   server-side vars the operator keeps there resolve the same way for every
   verify script. */
try {
  for (const line of readFileSync(join(SCRIPT_DIR, "..", ".env.local"), "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    const value = trimmed.slice(trimmed.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
} catch { /* .env.local is optional */ }

const BASE_URL = (process.argv[2] ?? process.env.GOLDEN_PATH_BASE_URL ?? "http://localhost:3310").replace(/\/$/, "");
const MODE = (process.env.GOLDEN_PATH_MODE ?? "ui").trim().toLowerCase();
if (MODE !== "ui" && MODE !== "full") {
  console.error(`CONFIG ERROR: GOLDEN_PATH_MODE must be "ui" or "full" (got "${MODE}").`);
  process.exit(1);
}
const RENDER_TIMEOUT_MS = Number(process.env.GOLDEN_PATH_RENDER_TIMEOUT_MS ?? 600_000); // 6 sheet views / 4 plates
const JOB_TIMEOUT_MS = Number(process.env.GOLDEN_PATH_JOB_TIMEOUT_MS ?? 900_000); // anchor/take job completion (full mode)
const EXPORT_TIMEOUT_MS = Number(process.env.GOLDEN_PATH_EXPORT_TIMEOUT_MS ?? 1_800_000); // assembly+QC (full mode)
const STEP_TIMEOUT_MS = Number(process.env.GOLDEN_PATH_STEP_TIMEOUT_MS ?? 120_000);

const OUT_DIR = join(SCRIPT_DIR, "..", "gui-test-screenshots", "creator-alpha");
const RUN_ID = Date.now().toString(36); // idempotency stamp: every run creates fresh entities
const PROFILE_ID = "storybook-short-v1";
const QA = {
  workspaceName: `QA Golden Workspace ${RUN_ID}`,
  characterName: `QA Golden Character ${RUN_ID}`,
  characterEntity: `char_qa_golden_${RUN_ID}`,
  environmentName: `QA Golden Environment ${RUN_ID}`,
  productionName: `QA Golden Production ${RUN_ID}`,
  locationEntity: `loc_qa_golden_${RUN_ID}`,
  styleEntity: `style_qa_golden_${RUN_ID}`,
  idea: `A lantern keeper's cat discovers the dawn tide has left a door of salt on the beach, and together they open it before the sun dries it shut.`,
  /* ONE blank-line-free paragraph → exactly one story beat → one shot. The
     golden path proves the whole pipeline on a single-shot film so a full-mode
     live run spends on exactly one anchor, one take and one export render. */
  script: "A lantern keeper's cat paws open the salt door left by the dawn tide and slips through the shining light before the first wave closes it forever.",
};

/* ------------------------------------------------------------------ */
/* Logging, steps, results                                             */
/* ------------------------------------------------------------------ */

const results = [];
let currentStep = { num: 0, slug: "setup", name: "setup" };

function log(message) { console.log(message); }
function spendGate(what, cost) {
  log(`  SPEND GATE: ${what} — would spend ${cost}. Skipped (GOLDEN_PATH_MODE=${MODE}). No paid request was sent.`);
}
function environmentNote(message) {
  log(`  ENVIRONMENT GAP: ${message}`);
}

async function shot(page, status) {
  const path = join(OUT_DIR, `${String(currentStep.num).padStart(2, "0")}-${currentStep.slug}-${status}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
    log(`  screenshot: ${path}`);
    return path;
  } catch (error) {
    log(`  screenshot failed: ${String(error).replace(/\s+/g, " ").slice(0, 160)}`);
    return null;
  }
}

/**
 * Fill that survives React hydration: write, read back, retry if the value
 * did not stick (hydration replaces early DOM nodes and clears values).
 */
async function fillVerified(locator, value, attempts = 8, until = null) {
  await locator.waitFor();
  for (let i = 0; i < attempts; i += 1) {
    // Clear first: React's change tracker dedupes same-value fills, so the
    // empty->value transition is what actually fires onChange post-hydration.
    await locator.fill("");
    await locator.fill(value);
    // Wait past the hydration window: if the fill landed before React
    // attached its listeners, hydration resets the input — re-fill then.
    await locator.page().waitForTimeout(900);
    if ((await locator.inputValue().catch(() => "")) !== value) continue;
    // DOM value alone can pre-date hydration (state still empty); when a
    // state-dependent predicate is supplied, require it to flip too.
    if (!until || (await until().catch(() => false))) return;
  }
  throw new Error(`fill did not stick${until ? " (state never updated)" : " (hydration race)"}`);
}

/** Dev-mode routes compile on first visit; give hydration room to finish. */
async function settle(page, ms = 2500) {
  await page.waitForLoadState("load").catch(() => undefined);
  await page.waitForTimeout(ms);
}

function record(status, detail = "") {
  results.push({ ...currentStep, status, detail });
  log(`  ${status}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Fail output contract: which step, what was expected, what was found, what to
 * do next — never a bare stack trace. Throwing the returned StepFailure makes
 * step() record FAIL exactly once (with the failure screenshot).
 */
function failStep(expected, found, hint) {
  log(`  EXPECTED: ${expected}`);
  log(`  FOUND:    ${found}`);
  if (hint) log(`  NEXT:     ${hint}`);
  return new StepFailure(expected, found, hint);
}

class StepFailure extends Error {
  constructor(expected, found, hint) {
    super(`step ${currentStep.num} (${currentStep.name}) FAILED — expected: ${expected}; found: ${found}${hint ? `; next: ${hint}` : ""}`);
    this.expected = expected;
    this.found = found;
    this.hint = hint;
  }
}

async function step(num, slug, name, fn) {
  currentStep = { num, slug, name };
  log(`\nSTEP ${num}/14 — ${name}`);
  const page = await context.newPage();
  installUiMocks(page);
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const closePage = () => page.close().catch(() => undefined);
  // Surface browser-side failures (hydration crashes etc.) in the run log.
  let pageErrors = 0;
  page.on("pageerror", (error) => {
    if (pageErrors < 5) log(`  PAGEERROR: ${String(error).replace(/\s+/g, " ").slice(0, 260)}`);
    pageErrors += 1;
  });
  page.on("console", (message) => {
    if (message.type() === "error" && pageErrors < 8) {
      log(`  CONSOLE: ${message.text().replace(/\s+/g, " ").slice(0, 220)}`);
      pageErrors += 1;
    }
  });
  try {
    await fn(page);
    await shot(page, "pass");
  } catch (error) {
    if (error instanceof StepFailure) {
      record("FAIL", error.found.slice(0, 300));
      log(`  EXPECTED: ${error.expected}`);
      log(`  NEXT:     ${error.hint ?? "see scripts/creator-alpha-steps.md"}`);
    } else {
      record("FAIL", String(error).replace(/\s+/g, " ").slice(0, 300));
      log(`  EXPECTED: the step completes as specified (see scripts/creator-alpha-steps.md step ${num}).`);
      log(`  FOUND:    ${String(error).replace(/\s+/g, " ").slice(0, 400)}`);
      log(`  NEXT:     inspect the FAILED screenshot above; check scripts/creator-alpha-steps.md step ${num} selectors.`);
    }
    await shot(page, "FAILED");
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ */
/* Server helpers (same-origin GET/POST; Origin on every mutation)      */
/* ------------------------------------------------------------------ */

async function getJson(path) {
  const response = await fetch(`${BASE_URL}${path}`, { cache: "no-store" });
  const text = await response.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, ok: response.ok, body };
}

async function postJson(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => "");
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** A 48 kHz 16-bit mono silent PCM WAV (the only audio the import route accepts). */
function silentWav(seconds) {
  const sampleRate = 48_000;
  const samples = Math.round(seconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Health fail-fast (the script never starts the dev server)           */
/* ------------------------------------------------------------------ */

const health = await getJson("/api/production/health").catch(() => ({ ok: false, status: 0 }));
if (!health.ok) {
  console.error(`BLOCKED: no healthy production server at ${BASE_URL} (health ${health.status}).`);
  console.error("start:   PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> npx next dev -p 3310");
  process.exit(1);
}
log(`Creator Alpha golden path — mode=${MODE} base=${BASE_URL} run=${RUN_ID}`);
log(`server health OK; screenshots: ${OUT_DIR}`);
if (MODE === "full") {
  log("FULL MODE: no mocks. Story proposal, anchor/take generation, assembly and export WILL spend against the configured entitlements.");
}

await mkdir(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
let externalRequests = 0;
await context.route((url) => /^https?:$/i.test(url.protocol) && !url.href.startsWith(`${BASE_URL}/`), async (route) => {
  externalRequests += 1;
  await route.abort();
});

/* ui-mode only: instant mock completions at the legacy /api/jobs boundary
   (character sheets + environment plates), the exact pattern of
   verify-character-sheet.mjs — no provider key usage. Production spend paths
   (/api/production/*) are NEVER mocked: the fail-closed budget boundary is the
   behavior under test. */
function installUiMocks(page) {
  if (MODE !== "ui") return;
  const jobs = new Map();
  let postCount = 0;
  const svg = (hue, label) =>
    "data:image/svg+xml;base64," +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="hsl(${hue},60%,70%)"/><text x="360" y="640" font-size="48" text-anchor="middle" fill="#222">${label}</text></svg>`,
    ).toString("base64");
  void page.route(/\/api\/jobs/, async (route) => {
    const url = new URL(route.request().url());
    if (!/\/api\/jobs(\/|$|\?)/.test(url.pathname)) return route.fallback();
    if (route.request().method() === "POST") {
      postCount += 1;
      const id = `j_qa_mock_${postCount}`;
      jobs.set(id, {
        id, kind: "image", status: "completed", createdAt: Date.now(), finishedAt: Date.now(),
        result: [{ id: `m_${postCount}`, url: svg((postCount * 47) % 360, id), width: 720, height: 1280, seed: 1000 + postCount }],
      });
      await route.fulfill({ json: { job: { id } } });
      return;
    }
    const id = url.pathname.split("/").pop();
    if (id === "jobs") return route.fulfill({ json: { jobs: [] } });
    const job = jobs.get(id);
    if (job) return route.fulfill({ json: { job } });
    return route.fulfill({ status: 404, json: { error: "no such job" } });
  });
  void page.route(/\/api\/moderate/, (route) => route.fulfill({ json: { verdict: null } }));
}

/* Selectors that repeat across steps (kept in one place; full map in
   scripts/creator-alpha-steps.md). */
const sel = {
  workspaceName: "[data-testid='workspaces.create.name']",
  workspaceNext: "[data-testid='workspaces.create.next']",
  workspaceSubmit: "[data-testid='workspaces.create.submit']",
  plateSelect0: "[data-testid='environments.create.variants.card.select-0']",
  plateGenerate: "[data-testid='environments.create.generate']",
  plateSave: "[data-testid='environments.create.save']",
};

/* ------------------------------------------------------------------ */
/* STEP 1 — Create Workspace                                           */
/* ------------------------------------------------------------------ */

let workspaceUrl = "";
await step(1, "workspace", "Create Workspace", async (page) => {
  await page.goto(`${BASE_URL}/workspaces/new`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-testid='workspaces.create.step-1']").waitFor();
  await fillVerified(page.getByRole("textbox", { name: "Workspace name" }), QA.workspaceName, 8, async () => !(await page.locator(sel.workspaceNext).isDisabled()));
  await page.locator(sel.workspaceNext).click(); // Basics → Format
  await page.locator("[data-testid='workspaces.create.step-2']").waitFor();
  await page.locator(sel.workspaceNext).click(); // Format → Review & create
  await page.locator("[data-testid='workspaces.create.step-3']").waitFor();
  await page.locator(sel.workspaceSubmit).click();
  await page.waitForURL(/\/workspaces\/(?!new$)[\w-]+$/, { timeout: STEP_TIMEOUT_MS });
  workspaceUrl = page.url();
  await page.waitForTimeout(1500);
  const heading = await page.evaluate(() => document.querySelector("h1")?.textContent ?? "");
  if (!heading.includes(QA.workspaceName)) {
    throw failStep(`the workspace detail page heading to name "${QA.workspaceName}"`, `heading reads "${heading}"`, "check the workspace detail page (components/workspaces/WorkspaceDetailView.tsx).");
  }
  record("PASS", workspaceUrl);
});

/* ------------------------------------------------------------------ */
/* STEP 2 — Create Character                                           */
/* ------------------------------------------------------------------ */

await step(2, "character", "Create Character", async (page) => {
  await page.goto(`${BASE_URL}/character/new`, { waitUntil: "domcontentloaded" });
  const prompt = page.getByLabel("Character Prompt");
  await prompt.waitFor();
  await page.waitForTimeout(1200);
  await fillVerified(prompt, "A lantern keeper's cat with a salt-white chest and a brass bell collar", 8, async () => await page.getByRole("button", { name: "Render sheet" }).isEnabled());
  if (MODE === "ui") {
    log("  MOCK: /api/jobs boundary returns instant completions in ui mode (no provider spend).");
  } else {
    log("  FULL MODE: rendering the 6-view sheet performs 6 real image jobs against the configured provider.");
  }
  await page.getByRole("button", { name: "Render sheet" }).click();
  await page.getByText("6 of 6 views rendered").waitFor({ timeout: RENDER_TIMEOUT_MS });
  await fillVerified(page.getByLabel("Character name"), QA.characterName);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved — attach it from the Character pill in Solo or Story.", { exact: true })
    .waitFor({ timeout: STEP_TIMEOUT_MS });
  record("PASS", `library character "${QA.characterName}" saved (client canon library)`);
});

/* ------------------------------------------------------------------ */
/* STEP 3 — Approve Character Canon (library-level, explicit human act) */
/* ------------------------------------------------------------------ */

await step(3, "character-canon", "Approve Character Canon", async (page) => {
  await page.goto(`${BASE_URL}/character`, { waitUntil: "domcontentloaded" });
  const link = page.locator(`a[aria-label="Open ${QA.characterName} details"]`).first();
  await link.waitFor();
  await link.click();
  await page.waitForURL(/\/character\/(?!new$)[\w-]+/, { timeout: STEP_TIMEOUT_MS });
  await settle(page);
  const approve = page.getByTestId("character.approve");
  await approve.waitFor();
  // Click until the state change lands (cold-compile hydration lag).
  for (let i = 0; i < 10; i += 1) {
    await approve.click({ timeout: 5000 }).catch(() => undefined);
    const done = await page.getByText("This version is the character's canon.", { exact: true })
      .or(page.getByText("This character is approved canon.", { exact: true }))
      .isVisible().catch(() => false);
    if (done) break;
    await page.waitForTimeout(1500);
  }
  await page.getByText("This version is the character's canon.", { exact: true })
    .or(page.getByText("This character is approved canon.", { exact: true }))
    .waitFor({ timeout: STEP_TIMEOUT_MS });
  const badge = await page.getByTestId("character.approval").innerText();
  if (!/approved/i.test(badge)) {
    throw failStep('the character approval badge to read "approved"', `badge reads "${badge}"`, "check components/character/CharacterDetail.tsx.");
  }
  record("PASS", `character canon approved at ${page.url()}`);
});

/* ------------------------------------------------------------------ */
/* STEP 4 — Create Environment                                         */
/* ------------------------------------------------------------------ */

let environmentUrl = "";
await step(4, "environment", "Create Environment", async (page) => {
  await page.goto(`${BASE_URL}/environments/new`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const genButton = page.locator(sel.plateGenerate);
  await page.getByTestId("environments.create.field.name").fill(QA.environmentName);
  await fillVerified(page.getByLabel("Description"), "A wide dawn beach where the low tide leaves salt formations and the light comes up amber.", 8, async () => await genButton.isEnabled());
  // Re-drive both fields until React state catches up (cold-compile hydration).
  for (let i = 0; i < 20 && (await genButton.isDisabled().catch(() => true)); i += 1) {
    await page.getByTestId("environments.create.field.name").fill("");
    await page.getByTestId("environments.create.field.name").fill(QA.environmentName);
    await page.getByLabel("Description").fill("");
    await page.getByLabel("Description").fill("A wide dawn beach where the low tide leaves salt formations and the light comes up amber.");
    await page.waitForTimeout(1250);
  }
  if (MODE === "ui") {
    log("  MOCK: /api/jobs boundary returns instant plates in ui mode (no provider spend).");
  } else {
    log("  FULL MODE: generating 4 plates performs 4 real image jobs against the configured provider.");
  }
  await page.locator(sel.plateGenerate).click();
  await page.getByText("4 of 4 plates ready").waitFor({ timeout: RENDER_TIMEOUT_MS });
  await page.locator(sel.plateSelect0).click();
  await page.locator(sel.plateSave).click();
  await page.waitForURL(/\/environments\/(?!new$)[\w-]+/, { timeout: STEP_TIMEOUT_MS });
  environmentUrl = page.url();
  await page.waitForTimeout(1500);
  const heading = await page.evaluate(() => document.querySelector("h1")?.textContent ?? "");
  if (!heading.includes(QA.environmentName)) {
    throw failStep(`the environment detail heading to name "${QA.environmentName}"`, `heading reads "${heading}"`, "check components/environments/EnvironmentDetail.tsx.");
  }
  record("PASS", environmentUrl);
});

/* ------------------------------------------------------------------ */
/* STEP 5 — Approve Environment Canon                                  */
/* ------------------------------------------------------------------ */

await step(5, "environment-canon", "Approve Environment Canon", async (page) => {
  await page.goto(environmentUrl, { waitUntil: "domcontentloaded" });
  const approve = page.getByTestId("environments.detail.approve");
  await approve.waitFor();
  await approve.click();
  await page.getByText("Main canon approved — the plate stays stable while views render.", { exact: true })
    .waitFor({ timeout: STEP_TIMEOUT_MS });
  const badge = await page.getByTestId("environments.detail.approval").innerText();
  if (!/approved/i.test(badge)) {
    throw failStep('the environment approval badge to read "approved"', `badge reads "${badge}"`, "check components/environments/EnvironmentDetail.tsx.");
  }
  record("PASS", `environment canon approved at ${environmentUrl}`);
});

/* ------------------------------------------------------------------ */
/* STEP 6 — Create Production (wizard pins character/location/style)   */
/* ------------------------------------------------------------------ */

let projectId = "";
await step(6, "production", "Create Production", async (page) => {
  await page.goto(`${BASE_URL}/production/new`, { waitUntil: "domcontentloaded" });
  await fillVerified(page.getByLabel("Project name"), QA.productionName, 8, async () => await page.getByLabel("Profile").isVisible());
  await settle(page, 1500);
  // Hydration race: re-drive name+profile until the wizard enables Next: Cast.
  const nextCast = page.getByRole("button", { name: "Next: Cast" });
  for (let i = 0; i < 20 && (await nextCast.isDisabled().catch(() => true)); i += 1) {
    await page.getByLabel("Project name").fill("");
    await page.getByLabel("Project name").fill(QA.productionName);
    await page.getByLabel("Profile").selectOption(PROFILE_ID);
    await page.waitForTimeout(1250);
    if (i < 3 || i === 19) {
      const diag = await page.evaluate(() => ({
        hydrated: [...document.querySelectorAll("input,button,select")].slice(0, 6).map((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber"))),
        nextF: typeof window.next,
        fCount: Array.isArray(window.__next_f) ? window.__next_f.length : -1,
        inputs: [...document.querySelectorAll("input")].map((el) => ({ id: el.id, value: el.value.slice(0, 30) })),
        issues: document.querySelector("[role=alert], .text-danger, [class*=danger]")?.textContent?.slice(0, 140) || null,
        lsKeys: Object.keys(window.localStorage),
      })).catch((e) => ({ diagError: String(e).slice(0, 120) }));
      log(`  DIAG round ${i}: ${JSON.stringify(diag).slice(0, 400)}`);
    }
  }
  await page.getByLabel("Profile").selectOption(PROFILE_ID);
  await page.getByRole("button", { name: "Next: Cast" }).click();
  await page.getByText("Cast 1", { exact: true }).waitFor();
  await fillVerified(page.getByLabel("Entity ID").nth(0), QA.characterEntity);
  await fillVerified(page.getByLabel("Description").nth(0), "The lantern keeper's cat: salt-white chest, brass bell collar, patient hunter.");
  await page.getByRole("button", { name: "Next: World" }).click();
  await page.getByText("World 1", { exact: true }).waitFor();
  await fillVerified(page.getByLabel("Entity ID").nth(0), QA.locationEntity);
  await fillVerified(page.getByLabel("Description").nth(0), "A wide dawn beach; the low tide leaves salt formations; amber first light.");
  await page.getByRole("button", { name: "Add another world draft" }).click();
  await page.getByText("World 2", { exact: true }).waitFor();
  await page.getByLabel("Entity kind").nth(1).selectOption("style");
  await fillVerified(page.getByLabel("Entity ID").nth(1), QA.styleEntity);
  await fillVerified(page.getByLabel("Description").nth(1), "Soft storybook gouache, amber-and-salt palette, gentle grain.");
  await page.getByRole("button", { name: "Next: Script" }).click();
  await page.getByLabel("Script text").waitFor();
  await page.getByLabel("Script text").fill(QA.script);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/production\/(?!new$)[^/]+$/, { timeout: STEP_TIMEOUT_MS });
  projectId = new URL(page.url()).pathname.split("/").pop();
  await page.getByText(QA.productionName).first().waitFor({ timeout: STEP_TIMEOUT_MS });
  record("PASS", `project ${projectId} (cast ${QA.characterEntity}, world ${QA.locationEntity} + style ${QA.styleEntity} pinned)`);
});

if (!projectId) {
  console.error("\nBLOCKED: step 6 did not produce a project id — steps 7–14 need it. See the FAILED screenshot for step 6.");
  await browser.close();
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* STEP 7 — Generate Story (SPEND GATE / expected BUDGET_BLOCKED)      */
/* ------------------------------------------------------------------ */

/** Free, read-only entitlement probe: the same budget-identity check the
 *  pilot performs BEFORE any spend (GET only — nothing is charged). */
async function budgetAvailability() {
  const probe = await getJson(`/api/production/projects/${projectId}/budget?providerId=sogni&unit=spark_token`).catch(() => null);
  if (!probe || !probe.ok) return { available: false, detail: probe ? `budget probe HTTP ${probe.status}` : "budget probe unreachable" };
  const reasons = Array.isArray(probe.body?.reasons) ? probe.body.reasons.join(", ") : "";
  return {
    available: probe.body?.availability === "available" && reasons === "",
    detail: `availability=${probe.body?.availability ?? "unknown"}${reasons ? ` reasons=${reasons}` : ""}`,
  };
}

/** The non-AI fallback that keeps steps 8–14 exercisable: the human Script
 *  editor saves the same immutable story-revision contract, pinning the
 *  project's active canon (character + location + style). A fallback failure
 *  is logged loudly but never masks the step-7 verdict; step 8 will fail with
 *  its own explicit message if no story revision exists. */
async function saveScriptRevision(page) {
  log("  FALLBACK: writing the story revision through the human Script editor (no AI, no spend) so the downstream path stays exercised.");
  try {
    await page.goto(`${BASE_URL}/production/${projectId}/script`, { waitUntil: "domcontentloaded" });
    const box = page.getByLabel("Script text");
    await box.waitFor();
    await box.fill(QA.script);
    await page.getByRole("button", { name: "Save script revision" }).click();
    await page.getByText(/Saved — created immutable story revision/).waitFor({ timeout: STEP_TIMEOUT_MS });
    log("  FALLBACK OK: immutable story revision saved (human-written; pins the active canon).");
  } catch (error) {
    log(`  FALLBACK FAILED: ${String(error).replace(/\s+/g, " ").slice(0, 240)} — step 8 will report the missing story revision.`);
  }
}

await step(7, "story", "Generate Story", async (page) => {
  await page.goto(`${BASE_URL}/production/${projectId}/story`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("story.page").waitFor();

  /* The studio's "no story" branch (empty state + IdeaComposer) ALSO renders
     while the read model is still loading, so neither surface is meaningful
     until the fetch resolves. Resolved states: the story studio (story.view —
     the step-6 wizard script save creates the first immutable revision), or —
     only for a genuinely story-less project — the composer after the load
     settles. */
  let storyPresent = true;
  try {
    await page.getByTestId("story.view").waitFor({ timeout: 45_000 });
  } catch {
    storyPresent = false;
  }

  if (storyPresent) {
    await page.getByTestId("story.approve.bar").waitFor();
    const budget = await budgetAvailability();
    if (!budget.available) {
      environmentNote(`budget identity is not available on project ${projectId} (${budget.detail}) — not exercised here: the wizard script save already produced the story revision without AI spend.`);
    }
    record("PASS", "story revision already present — created by the step-6 wizard script save (human-written, free); story studio + approve bar verified; no paid story action is reachable for a project that already has a story");
    return;
  }

  /* Story-less project: the IdeaComposer is the paid surface. */
  await page.getByTestId("story.empty").waitFor();
  await page.getByTestId("story.idea").first().waitFor();

  const ideaSection = page.getByTestId("story.idea").first();
  const idea = ideaSection.getByRole("textbox");
  await fillVerified(idea, QA.idea);
  const providerSelect = page.getByTestId("story.engine.provider");
  let engineDisabled = await providerSelect.isDisabled().catch(() => true);
  if (engineDisabled) {
    await sleep(5_000); // the engine catalog may still be loading on first paint
    engineDisabled = await providerSelect.isDisabled().catch(() => true);
  }
  const submit = ideaSection.locator("[data-testid='story.idea.change.submit']");
  if (!(await submit.isVisible())) {
    throw failStep('the "Generate story draft" button (story.idea.change.submit) to be present', "the idea composer submit button is missing", "check components/production/story/IdeaComposer.tsx.");
  }

  const budget = await budgetAvailability();

  if (MODE === "ui") {
    spendGate(
      "clicking \"Generate story draft\" sends a paid story-proposal request",
      "one text-model proposal call",
    );
    log(`  ready-to-spend state: idea filled (${QA.idea.length} chars); engine picker ${engineDisabled ? "shows no configured engines" : "configured"}; submit button present${budget.available ? "; budget identity available" : ""}.`);
    if (!budget.available) {
      environmentNote(`budget identity is not available on project ${projectId} (${budget.detail}).`);
      // Expected-today environment block (requirement: explicit, instructive):
      await saveScriptRevision(page);
      throw failStep(
        "a funded story proposal path (or, in ui mode, an available budget identity before the spend gate)",
        `server proposals are fail-closed BUDGET_BLOCKED — server entitlement not configured — see handoff (${budget.detail})`,
        "install the reviewed policy + authorize this project's budget (docs/production/pilots/), then re-run with GOLDEN_PATH_MODE=full. Steps 8–14 continue on the human-written fallback revision.",
      );
    }
    record("PASS", "ready-to-spend state reached; paid click withheld by the spend gate");
    environmentNote("proposals never auto-apply; downstream steps run on the human-written script revision (apply-flow is a known gap).");
    await saveScriptRevision(page);
    return;
  }

  /* full mode: click through the real proposal */
  if (engineDisabled) {
    environmentNote("no writing engines are configured (Settings → text engines); the proposal cannot even be submitted.");
    await saveScriptRevision(page);
    throw failStep(
      "a configured writing engine (story.engine.provider enabled)",
      "the engine picker reports no configured engines",
      "configure a text engine in Settings (server entitlement required), then re-run GOLDEN_PATH_MODE=full. Steps 8–14 continue on the fallback revision.",
    );
  }
  const modelSelect = page.getByTestId("story.engine.model");
  const modelOptions = await modelSelect.locator("option").count();
  if (modelOptions > 0) await modelSelect.selectOption({ index: 0 });
  await submit.click();
  const status = page.getByTestId("story.idea.status");
  await status.waitFor({ timeout: STEP_TIMEOUT_MS });
  const statusText = await status.innerText();
  if (/Story generation isn’t funded yet|isn't funded yet|not_entitled|BUDGET_BLOCKED/i.test(statusText)) {
    environmentNote("the proposal was refused by the fail-closed budget boundary (no spend occurred).");
    await saveScriptRevision(page);
    throw failStep(
      "the story proposal to be accepted (\"Draft request accepted — proposal …\")",
      `the server refused it: ${statusText.replace(/\s+/g, " ").slice(0, 240)}`,
      "server entitlement not configured — see handoff (scripts/creator-alpha-steps.md §Known gaps) and docs/production/pilots/. Steps 8–14 continue on the fallback revision.",
    );
  }
  if (!/Draft request accepted/.test(statusText)) {
    await saveScriptRevision(page);
    throw failStep(
      "the story proposal to be accepted",
      `unexpected composer status: ${statusText.replace(/\s+/g, " ").slice(0, 240)}`,
      "check components/production/story/IdeaComposer.tsx outcome states.",
    );
  }
  record("PASS", statusText.replace(/\s+/g, " ").slice(0, 200));
  environmentNote("proposals never auto-apply; downstream steps run on the human-written script revision (apply-flow is a known gap).");
  await saveScriptRevision(page);
});

/* ------------------------------------------------------------------ */
/* STEP 8 — Approve Story                                              */
/* ------------------------------------------------------------------ */

const STORY_CHECKLIST = ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"];

await step(8, "story-approve", "Approve Story", async (page) => {
  await page.goto(`${BASE_URL}/production/${projectId}/story`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("story.page").waitFor();
  const bar = page.getByTestId("story.approve.bar");
  await bar.waitFor();
  if (/This story is approved/.test(await bar.innerText())) {
    record("PASS", "story approval already recorded and current (idempotent re-run against this project)");
    return;
  }
  await page.getByTestId("story.approve.toggle").click();
  await page.getByTestId("story.approve.form").waitFor();
  const submit = page.getByTestId("story.approve.submit");
  /* Hydration-robust ticking: re-drive any checkbox whose change React dropped
     until the checklist-gated submit actually enables. */
  let armed = false;
  for (let i = 0; i < 10 && !armed; i += 1) {
    for (const id of STORY_CHECKLIST) {
      const box = page.getByTestId(`story.approve.check.${id}`);
      if (!(await box.isChecked().catch(() => false))) await box.check().catch(() => undefined);
    }
    armed = !(await submit.isDisabled().catch(() => true));
    if (!armed) await page.waitForTimeout(1000);
  }
  if (!armed) {
    throw failStep("the approve submit to enable once every checklist item is ticked", "the submit stayed disabled", "check components/production/story/ApproveBar.tsx checklist wiring.");
  }
  /* Click until the decision visibly lands. The success status region is
     TRANSIENT — onRecorded() refetches the read model and remounts the bar,
     so the durable signal is the bar's post-reload "This story is approved"
     copy (or the explicit error region on refusal). */
  let errorText = "";
  let approved = false;
  for (let i = 0; i < 6 && !(approved || errorText); i += 1) {
    if (await submit.isVisible().catch(() => false)) {
      await submit.click({ timeout: 5000 }).catch(() => undefined);
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const barText = await bar.innerText().catch(() => "");
      if (/This story is approved/.test(barText)) { approved = true; break; }
      if (await page.getByTestId("story.approve.status").isVisible().catch(() => false)) { approved = true; break; }
      const error = page.getByTestId("story.approve.error");
      if (await error.isVisible().catch(() => false)) {
        errorText = (await error.innerText()).replace(/\s+/g, " ");
        break;
      }
      await page.waitForTimeout(500);
    }
  }
  if (!approved) {
    throw failStep(
      "the approve bar to record the decision (status region or approved copy)",
      errorText ? `the server refused the approval: ${errorText.slice(0, 240)}` : "no approval signal appeared after repeated submits",
      errorText ? "check the approvals route response for this revision hash." : "check components/production/story/ApproveBar.tsx submit wiring.",
    );
  }
  record("PASS", approved ? "story approved — approve bar records the decision and the bar locks to the approved copy" : "story approved");
});

/* ------------------------------------------------------------------ */
/* STEP 9 — Generate Storyboard Anchor                                 */
/* ------------------------------------------------------------------ */

let shotCount = 0;
await step(9, "anchor", "Generate Storyboard Anchor", async (page) => {
  /* 9a prerequisite (free): create the shot plan from the approved story, then
     approve shotplan + animatic — the anchors page gates on both. */
  await page.goto(`${BASE_URL}/production/${projectId}/plan`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("plan-page").waitFor();
  await page.getByTestId("plan-builder").waitFor();
  const createPlan = page.getByTestId("create-plan-button");
  if (await createPlan.isDisabled()) {
    const issues = await page.getByTestId("plan-builder").innerText();
    throw failStep(
      "create-plan-button enabled (derived drafts valid: location + style pinned by the story)",
      `the create button is disabled — plan issues: ${issues.replace(/\s+/g, " ").slice(0, 260)}`,
      "the wizard script must pin a location AND a style canon revision before the story save (step 6 adds both world drafts).",
    );
  }
  await createPlan.click();
  await page.getByTestId("plan-created-banner").waitFor({ timeout: STEP_TIMEOUT_MS });
  for (const kind of ["shotplan", "animatic"]) {
    const workspace = page.getByTestId(`${kind}-approve-workspace`);
    await workspace.waitFor({ timeout: STEP_TIMEOUT_MS });
    for (const box of await workspace.locator('input[type="checkbox"]').all()) await box.check();
    await page.getByTestId(`${kind}-approve-button`).click();
    await page.getByTestId(`${kind}-approved`).waitFor({ timeout: STEP_TIMEOUT_MS });
    log(`  prerequisite: ${kind} approved.`);
  }
  const planRows = await page.getByTestId("plan-summary-row").count();
  shotCount = planRows > 0 ? planRows : 1;

  /* 9b anchors page: assert the ready-to-spend state of the anchor submit. */
  await page.goto(`${BASE_URL}/production/${projectId}/anchors`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("anchors-page").waitFor();
  /* The page renders its loading panel until the read model resolves — wait
     for the resolved state (per-shot empty states or the shot sections)
     before counting anything. */
  await page.getByTestId("anchor-empty").first().waitFor({ timeout: STEP_TIMEOUT_MS });
  const empties = await page.getByTestId("anchor-empty").count();
  if (empties < 1) {
    throw failStep("at least one honest per-shot empty anchor state", `${empties} anchor-empty states`, "check components/production/storyboard.tsx anchors page.");
  }
  await page.getByTestId("anchor-provider-input").first().selectOption("sogni");
  const modelSelect = page.getByTestId("anchor-model-input").first();
  const modelOptions = await modelSelect.locator("option").count();
  if (modelOptions > 0) await modelSelect.selectOption({ index: 0 });
  const submit = page.getByTestId("anchor-submit-button").first();
  const submitReady = (await submit.count()) > 0 && !(await submit.isDisabled());
  const gateReasons = await page.getByTestId("anchor-submit-gate-reasons").first().innerText().catch(() => "");
  if (!submitReady && !gateReasons) {
    throw failStep(
      "the anchor submit enabled, or its always-visible gate reasons naming what is missing",
      "the submit is disabled with no visible gate reasons",
      "check components/production/storyboard.tsx AnchorSubmitForm readiness.",
    );
  }
  if (MODE === "ui") {
    spendGate(
      `clicking "Request quote and enqueue anchor generation" for ${shotCount} shot(s)`,
      "one media quote + one anchor image job per shot",
    );
    record("PASS", submitReady
      ? `ready-to-spend: submit enabled (provider sogni${modelOptions > 0 ? ", model selected" : ""}); ${empties} gated anchor slots`
      : `honest gate shown: ${gateReasons.replace(/\s+/g, " ").slice(0, 160)}`);
    return;
  }

  /* full mode: request quote + enqueue, then wait for the job to complete. */
  log(`  FULL MODE: enqueueing ${shotCount} anchor job(s) — this spends against the configured provider.`);
  await submit.click();
  const form = page.getByTestId("anchor-submit-form").first();
  const outcome = form.locator("[role=alert], [role=status]").first();
  await outcome.waitFor({ timeout: STEP_TIMEOUT_MS });
  const outcomeText = await outcome.innerText();
  if (/Generation is blocked|BUDGET_BLOCKED/i.test(outcomeText)) {
    throw failStep(
      "the anchor job to be accepted",
      `the server refused the media quote: ${outcomeText.replace(/\s+/g, " ").slice(0, 240)}`,
      "server entitlement not configured — see handoff; authorize this project's budget, then re-run GOLDEN_PATH_MODE=full.",
    );
  }
  if (!/Job .* accepted/i.test(outcomeText)) {
    throw failStep("the anchor job to be accepted", `unexpected submit outcome: ${outcomeText.replace(/\s+/g, " ").slice(0, 240)}`, "check the anchor submit form phases.");
  }
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.getByTestId("reload-button").click();
    if ((await page.getByTestId("approval-workspace").count()) > 0) break;
    await sleep(10_000);
  }
  if ((await page.getByTestId("approval-workspace").count()) === 0) {
    throw failStep(
      "a completed anchor (approval workspace appears) within the job timeout",
      `no anchor appeared within ${Math.round(JOB_TIMEOUT_MS / 60_000)} min`,
      "check the production worker is running (scripts/production-worker.mjs) and the provider job state.",
    );
  }
  record("PASS", `anchor job(s) completed for ${shotCount} shot(s); approval workspace available`);
});

/* ------------------------------------------------------------------ */
/* STEP 10 — Approve Anchor                                            */
/* ------------------------------------------------------------------ */

await step(10, "anchor-approve", "Approve Anchor", async (page) => {
  await page.goto(`${BASE_URL}/production/${projectId}/anchors`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("anchors-page").waitFor();
  /* Wait out the loading panel so the "no fabricated workspace" assertion
     below tests the resolved read model, not the loading state. */
  await page.getByTestId("anchor-empty").first().waitFor({ timeout: STEP_TIMEOUT_MS });
  const workspaces = page.getByTestId("approval-workspace");

  if (MODE === "ui") {
    /* Without a completed anchor job (spend-gated in ui mode) no approval
       workspace may exist — fabricating one would be the failure. */
    const count = await workspaces.count();
    if (count > 0) {
      throw failStep("no fabricated approval workspace without a completed anchor job", `${count} approval workspaces present`, "the anchors page must render approval UI only from real anchor history.");
    }
    record("GATED", "anchor approval requires a completed anchor job (spend-gated in ui mode); the page honestly renders empty states only — executed at full mode.");
    return;
  }

  const workspace = workspaces.first();
  await workspace.waitFor({ timeout: STEP_TIMEOUT_MS });
  /* The workspace renders exactly its own required checklist (identity … framing)
     as positional checkboxes; tick every one. */
  for (const box of await workspace.locator('input[type="checkbox"]').all()) await box.check();
  const visionAck = workspace.locator("input[id$='-vision-ack']");
  if ((await visionAck.count()) > 0) await visionAck.first().fill(`QA golden path supervised live run ${RUN_ID}; creator watched the anchor render.`);
  await workspace.locator("input[id$='-idempotency']").fill(`qa-golden-anchor-${RUN_ID}`);
  await workspace.getByRole("button", { name: /Submit approved/ }).click();
  await page.getByText(/Decision recorded/).waitFor({ timeout: STEP_TIMEOUT_MS });
  record("PASS", "anchor approved through the checklist-gated approval workspace");
});

/* ------------------------------------------------------------------ */
/* STEP 11 — Generate Take                                             */
/* ------------------------------------------------------------------ */

await step(11, "take", "Generate Take", async (page) => {
  await page.goto(`${BASE_URL}/production/${projectId}/takes`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("takes-page").waitFor();
  /* Loading panel renders until the read model resolves — wait for the
     resolved state before counting the per-shot empty take states. */
  await page.getByTestId("take-empty").first().waitFor({ timeout: STEP_TIMEOUT_MS });

  if (MODE === "ui") {
    const empties = await page.getByTestId("take-empty").count();
    const reasons = await page.getByTestId("take-submit-gate-reasons").first().innerText().catch(() => "");
    if (empties < 1) {
      throw failStep("the honest per-shot empty take state", `${empties} take-empty states`, "check components/production/storyboard.tsx takes page.");
    }
    if (!/ANCHOR_APPROVAL_REQUIRED/.test(reasons)) {
      throw failStep("the take submit gate to name ANCHOR_APPROVAL_REQUIRED (no approved anchor yet)", `gate reasons read: ${reasons.replace(/\s+/g, " ").slice(0, 200)}`, "check TakeSubmitForm gate reasons.");
    }
    spendGate(
      `clicking the take submit for ${shotCount} shot(s)`,
      "one media quote + one take video job per shot",
    );
    record("PASS", `ready-to-spend asserted honestly: submit gated on the missing (spend-gated) anchor — ${reasons.replace(/\s+/g, " ").slice(0, 120)}`);
    return;
  }

  await page.getByTestId("take-provider-input").first().selectOption("sogni");
  const modelSelect = page.getByTestId("take-model-input").first();
  if ((await modelSelect.locator("option").count()) > 0) await modelSelect.selectOption({ index: 0 });
  const submit = page.getByTestId("take-submit-button").first();
  if (await submit.isDisabled()) {
    const reasons = await page.getByTestId("take-submit-gate-reasons").first().innerText().catch(() => "");
    throw failStep("the take submit to be enabled after the approved anchor", `still gated: ${reasons.replace(/\s+/g, " ").slice(0, 200)}`, "approve the anchor first (step 10), then reload the takes page.");
  }
  log("  FULL MODE: enqueueing the take job — this spends against the configured provider.");
  await submit.click();
  const form = page.getByTestId("take-submit-form").first();
  const outcome = form.locator("[role=alert], [role=status]").first();
  await outcome.waitFor({ timeout: STEP_TIMEOUT_MS });
  const outcomeText = await outcome.innerText();
  if (/Generation is blocked|BUDGET_BLOCKED/i.test(outcomeText)) {
    throw failStep("the take job to be accepted", `the server refused the media quote: ${outcomeText.replace(/\s+/g, " ").slice(0, 240)}`, "authorize this project's budget, then re-run GOLDEN_PATH_MODE=full.");
  }
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.getByTestId("reload-button").click();
    if ((await page.getByTestId("take-row").count()) > 0) break;
    await sleep(10_000);
  }
  if ((await page.getByTestId("take-row").count()) === 0) {
    throw failStep("a completed take (take-row appears) within the job timeout", `no take appeared within ${Math.round(JOB_TIMEOUT_MS / 60_000)} min`, "check the production worker and provider job state.");
  }
  record("PASS", "take job completed; take row listed");
});

/* ------------------------------------------------------------------ */
/* STEP 12 — Select Take                                               */
/* ------------------------------------------------------------------ */

await step(12, "take-select", "Select Take", async (page) => {
  await page.goto(`${BASE_URL}/production/${projectId}/takes`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("takes-page").waitFor();
  /* Wait out the loading panel so the "no fabricated selection controls"
     assertion below tests the resolved read model, not the loading state. */
  await page.getByTestId("take-empty").first().waitFor({ timeout: STEP_TIMEOUT_MS });

  if (MODE === "ui") {
    const selects = await page.getByTestId("select-take-button").count();
    if (selects > 0) {
      throw failStep("no take-selection controls without real take candidates", `${selects} select-take buttons present`, "the takes page must not fabricate selection controls.");
    }
    record("GATED", "take selection requires a completed take (spend-gated in ui mode); the page honestly renders no selection controls — executed at full mode.");
    return;
  }

  /* full mode: approve the take first (checklist-gated workspace), then select it. */
  const workspace = page.getByTestId("approval-workspace").first();
  if ((await workspace.count()) > 0) {
    for (const box of await workspace.locator('input[type="checkbox"]').all()) await box.check();
    const idem = workspace.locator("input[id$='-idempotency']");
    if ((await idem.count()) > 0) await idem.fill(`qa-golden-take-${RUN_ID}`);
    await workspace.getByRole("button", { name: /Submit approved/ }).click();
    await page.getByText(/Decision recorded/).waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.getByTestId("reload-button").click();
    log("  prerequisite: take approved through the checklist-gated workspace.");
  }
  const select = page.getByTestId("select-take-button").first();
  await select.waitFor({ timeout: STEP_TIMEOUT_MS });
  await select.click();
  await page.getByTestId("reverse-selection-button").first().waitFor({ timeout: STEP_TIMEOUT_MS });
  record("PASS", "take selected (reverse-selection control now present)");
});

/* ------------------------------------------------------------------ */
/* STEP 13 — Build First Cut (assembly)                                */
/* ------------------------------------------------------------------ */

await step(13, "first-cut", "Build First Cut", async (page) => {
  if (MODE === "ui") {
    /* At authoring time the first-cut UI is a Wave-3 placeholder (/first-cut);
       the export page is the honest surface that names the assembly
       prerequisites. (An uncommitted /first-cut page appeared mid-authoring —
       scripts/creator-alpha-steps.md gap 3 names the upgrade path.) */
    await page.goto(`${BASE_URL}/production/${projectId}/export`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("export-page").waitFor();
    const empty = page.getByTestId("export-empty");
    await empty.waitFor();
    const text = await page.getByTestId("export-page").innerText();
    for (const required of [/take/i, /manifest/i, /audio mix/i, /QC/i]) {
      if (!required.test(text)) {
        throw failStep("the export empty state to name the assembly prerequisite chain (takes, audio mix, manifest, QC)", `missing fragment ${required} in: ${text.replace(/\s+/g, " ").slice(0, 240)}`, "check components/production/export.tsx empty state.");
      }
    }
    spendGate(
      "compiling the manifest and rendering the first cut (assembly + render worker)",
      "local FFmpeg assembly (no provider spend, but real assembly work)",
    );
    record("PASS", "export page honestly shows the prerequisite chain; assembly withheld by the spend gate");
    return;
  }

  /* full mode — API-driven assembly (known gap: no first-cut UI yet; the audio
     mixing screen is out of the golden-path UI). Mirrors the pilot protocol. */
  log("  FULL MODE: importing silent creator audio, saving the mix, compiling the manifest and starting the export (API-driven — see steps.md known gaps).");
  const readModel = await getJson(`/api/production/projects/${projectId}`);
  if (!readModel.ok) throw failStep("the project read model", `GET /api/production/projects/${projectId} → HTTP ${readModel.status}`, "check the read-model route.");
  const project = readModel.body?.project ?? {};
  const shots = Array.isArray(readModel.body?.shots) ? readModel.body.shots : [];
  const approvalOf = (kind) => (readModel.body?.approvals ?? []).find((entry) => entry.targetKind === kind && entry.decision === "approved");
  const shotplanApproval = approvalOf("shotplan");
  const animaticApproval = approvalOf("animatic");
  if (!shotplanApproval || !animaticApproval) throw failStep("approved shotplan + animatic in the read model", "either approval is missing", "re-run step 9 (full mode).");
  const takes = shots.flatMap((shot) => (shot.takeHistory ?? []).map((take) => ({ ...take, shotId: shot.shotRevision?.shotId ?? shot.shotId })));
  if (takes.length === 0) throw failStep("at least one completed take in the read model", "takeHistory is empty", "re-run step 11 (full mode).");

  /* audio: one silent narration per shot + a music bed, imported and mixed. */
  const importAudio = async (seconds, label) => {
    const form = new FormData();
    form.append("source", `QA golden path ${RUN_ID}: ${label}`);
    form.append("rightsAttestation", `The local creator attests they own or have rights to this ${label} audio and authorize its use (QA golden run ${RUN_ID}).`);
    form.append("rightsStatus", "creator_attested");
    form.append("file", new Blob([silentWav(seconds)], { type: "audio/wav" }), `qa-golden-${label}-${RUN_ID}.wav`);
    const response = await fetch(`${BASE_URL}/api/production/assets/import`, { method: "POST", headers: { origin: BASE_URL }, body: form });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.asset?.id) throw failStep(`audio import (${label})`, `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`, "check the assets/import route contract.");
    return body.asset;
  };
  const SAMPLES_PER_FRAME = 2000; // 48 kHz at 24 fps
  const shotFrames = (index) => Number(shots[index]?.durationFrames ?? shots[index]?.shotRevision?.targetFrames ?? 120);
  let cursorSamples = 0;
  const cues = [];
  for (let index = 0; index < shots.length; index += 1) {
    const asset = await importAudio(1, `narration ${index + 1}`);
    cues.push({
      assetId: asset.id, sourceStartSample: 0, sourceEndSample: 48_000,
      timelineStartSample: cursorSamples, gainDb: 0, role: "narration",
      scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested",
    });
    cursorSamples += shotFrames(index) * SAMPLES_PER_FRAME;
  }
  const music = await importAudio(2, "music bed");
  cues.push({ assetId: music.id, sourceStartSample: 0, sourceEndSample: 96_000, timelineStartSample: 0, gainDb: -16, role: "music", scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested" });
  const mix = await postJson(`/api/production/projects/${projectId}/audio`, {
    projectId, expectedAudioVersion: project.audioMixVersion ?? null,
    expectedStoryRevisionId: project.activeStoryRevisionId ?? null,
    cues, mixSettings: { sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true },
  });
  if (mix.status !== 201) throw failStep("the audio mix save", `HTTP ${mix.status} ${JSON.stringify(mix.body).slice(0, 200)}`, "check the audio mix route contract.");
  const audioApproval = await postJson("/api/production/approvals", {
    projectId, idempotencyKey: `qa-golden-audio-${RUN_ID}`,
    command: {
      targetKind: "audio", targetId: mix.body.revision.id, expectedHash: mix.body.revision.contentHash, decision: "approved",
      checklist: ["spoken_lines", "intelligibility", "voice_consistency", "cue_timing", "music_sfx_rights", "no_truncation", "balance"].map((id) => ({ id, passed: true, note: "QA golden path silent placeholders" })),
      notes: `QA golden path run ${RUN_ID}: silent creator-audio placeholders (documented known gap — no narration assets in the harness).`,
      advisoryAcknowledgements: [],
    },
  });
  if (audioApproval.status !== 201 && audioApproval.status !== 200) {
    throw failStep("the audio approval", `HTTP ${audioApproval.status} ${JSON.stringify(audioApproval.body).slice(0, 200)}`, "check the approvals route audio checklist.");
  }
  const manifest = await postJson(`/api/production/projects/${projectId}/manifests`, {
    projectId, shotPlanRevisionId: shotplanApproval.targetId, animaticRevisionId: animaticApproval.targetId,
    audioMixRevisionId: mix.body.revision.id, selectedTakeIds: takes.map((take) => take.id),
    profileId: PROFILE_ID, expectedSelectionVersion: project.takeSelectionVersion ?? null,
  });
  if (manifest.status !== 201) throw failStep("the manifest compile", `HTTP ${manifest.status} ${JSON.stringify(manifest.body).slice(0, 220)}`, "check the manifests route contract and take selection state.");
  const exportStart = await postJson(`/api/production/projects/${projectId}/exports`, {
    projectId, manifestId: manifest.body.manifest.id, expectedManifestHash: manifest.body.manifest.inputsHash, idempotencyKey: `qa-golden-export-${RUN_ID}`,
  });
  if (exportStart.status !== 202 && exportStart.status !== 201 && exportStart.status !== 200) {
    throw failStep("the export start", `HTTP ${exportStart.status} ${JSON.stringify(exportStart.body).slice(0, 220)}`, "check the exports route contract.");
  }
  const exportId = exportStart.body?.id ?? exportStart.body?.export?.id;
  log(`  export ${exportId} started; polling for qc_pending (worker renders locally with FFmpeg).`);
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  let exportStatus = "unknown";
  while (Date.now() < deadline) {
    const detail = await getJson(`/api/production/exports/${exportId}?projectId=${projectId}`);
    exportStatus = detail.body?.exportRecord?.status ?? detail.body?.export?.status ?? "unknown";
    if (["qc_pending", "qc_failed", "ready_for_review", "failed", "canceled"].includes(exportStatus)) break;
    await sleep(10_000);
  }
  if (exportStatus !== "qc_pending") {
    throw failStep("the export to reach qc_pending within the timeout", `status ${exportStatus}`, "check the production worker (scripts/production-worker.mjs) and ffmpeg availability.");
  }
  /* technical QC through the export page UI */
  await page.goto(`${BASE_URL}/production/${projectId}/export`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("export-page").waitFor();
  await page.getByTestId("export-item").first().click();
  await page.getByTestId("run-qc").waitFor({ timeout: STEP_TIMEOUT_MS });
  await page.getByTestId("run-qc").click();
  await page.getByText(/ready_for_review|Final review/).first().waitFor({ timeout: STEP_TIMEOUT_MS });
  record("PASS", `export ${exportId} rendered and QC passed (ready_for_review)`);
});

/* ------------------------------------------------------------------ */
/* STEP 14 — Export MP4 (final review + download)                      */
/* ------------------------------------------------------------------ */

await step(14, "export", "Export MP4", async (page) => {
  await page.goto(`${BASE_URL}/production/${projectId}/export`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("export-page").waitFor();
  /* Loading state renders until the export list fetch resolves — wait for the
     resolved state (empty pipeline or the list container) before counting. */
  await page
    .getByTestId("export-empty")
    .or(page.getByTestId("export-list"))
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS });

  if (MODE === "ui") {
    const empty = await page.getByTestId("export-empty").count();
    const downloadControls = await page.getByTestId("download-final").count()
      + await page.getByTestId("download-draft").count()
      + await page.getByTestId("run-qc").count();
    if (downloadControls > 0) {
      throw failStep("no download/QC controls for a project with no rendered export", `${downloadControls} controls present`, "the export page must not fabricate download affordances.");
    }
    if (empty === 0) {
      throw failStep("the honest export empty state", "no export-empty region found", "check components/production/export.tsx.");
    }
    spendGate("final review approval + MP4 download", "the finished render (no provider spend; requires the assembly step first)");
    record("GATED", "export download requires a rendered export (assembly spend-gated in ui mode); the page honestly renders the empty pipeline — executed at full mode.");
    return;
  }

  await page.getByTestId("export-item").first().click();
  const reviewForm = page.getByTestId("final-review-form");
  await reviewForm.waitFor({ timeout: STEP_TIMEOUT_MS });
  for (const id of ["narrative", "visual", "audio", "captions"]) {
    await page.getByLabel(`Checklist ${id} passed`).check();
    await page.getByLabel(`Checklist ${id} note`).fill(`QA golden path supervised live run ${RUN_ID}.`);
  }
  await page.getByTestId("approve-final").click();
  await page.getByTestId("final-badge").waitFor({ timeout: STEP_TIMEOUT_MS });
  const downloadPromise = page.waitForEvent("download", { timeout: STEP_TIMEOUT_MS });
  await page.getByTestId("download-final").click();
  const download = await downloadPromise;
  const fileName = download.suggestedFilename();
  const target = join(OUT_DIR, `${String(currentStep.num).padStart(2, "0")}-${currentStep.slug}-download-${fileName}`);
  await download.saveAs(target);
  if (!/\.mp4$/i.test(fileName)) {
    throw failStep("the final download to be an .mp4 artifact", `suggested filename "${fileName}"`, "check the download route content disposition.");
  }
  record("PASS", `final MP4 downloaded: ${target}`);
});

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

await browser.close();

const failed = results.filter((entry) => entry.status === "FAIL");
const gated = results.filter((entry) => entry.status === "GATED");
log("\n" + "=".repeat(72));
log(`GOLDEN PATH SUMMARY — mode=${MODE} run=${RUN_ID} project=${projectId || "n/a"}`);
for (const entry of results) {
  log(`  ${entry.status.padEnd(7)} ${String(entry.num).padStart(2, "0")}/14 ${entry.name}${entry.detail ? ` — ${entry.detail.slice(0, 160)}` : ""}`);
}
log("=".repeat(72));
if (gated.length) {
  log(`${gated.length} step(s) SPEND-GATED in ${MODE} mode: ${gated.map((entry) => entry.num).join(", ")} — re-run with GOLDEN_PATH_MODE=full on an entitled server for the paid path.`);
}
log(`tripwire: ${externalRequests} non-local request(s) during the run (must stay 0).`);
if (failed.length) {
  const storyBlock = failed.find((entry) => entry.num === 7);
  log(`${failed.length} step(s) FAILED: ${failed.map((entry) => entry.num).join(", ")}`);
  if (storyBlock) {
    log("\nEXPECTED BLOCK (not a bug): story generation is fail-closed BUDGET_BLOCKED —");
    log("server entitlement not configured — see handoff (scripts/creator-alpha-steps.md §Known gaps,");
    log("docs/production/pilots/ for policy install + project budget authorization).");
    log("The golden path is otherwise exercised end to end on the human-written fallback revision.");
  }
  process.exit(1);
}
log("All executable steps passed.");
process.exit(0);

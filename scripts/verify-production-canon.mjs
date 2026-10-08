/**
 * Browser verification for C07-FULL-UI creator canon/script pages.
 *
 * Usage: node scripts/verify-production-canon.mjs http://127.0.0.1:3100
 *
 * Protocol (C10-PRE conventions): does NOT start the dev server; fails fast on
 * GET {base}/api/production/health; seeds additional projects via HTTP only
 * (same-origin Origin header); every scenario logs PASS/FAIL check() lines and
 * a screenshot into a fresh tmpdir run folder (absolute paths printed; no PNGs
 * are committed); exits 1 on any FAIL. Offline/localhost only.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* --------------------------- health fail-fast --------------------------- */

try {
  const health = await fetch(`${BASE}/api/production/health`, { cache: "no-store" });
  if (!health.ok) throw new Error(`health returned ${health.status}`);
  console.log(`health: ${BASE}/api/production/health OK`);
} catch (error) {
  console.error(`BLOCKED: the production dev server is not reachable at ${BASE} (${String(error).replace(/\s+/g, " ")}).`);
  console.error("start:   PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> npx next dev -p 3100");
  process.exit(1);
}

/* ------------------------------- run dir -------------------------------- */

const runDir = join(tmpdir(), `c07-full-ui-verify-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(runDir, { recursive: true });
const shotPaths = [];
async function shot(page, name) {
  const path = join(runDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  shotPaths.push(path);
  console.log(`screenshot: ${path}`);
  return path;
}

/* ----------------------------- HTTP seeding ----------------------------- */

async function seedJson(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`seed ${path} failed: ${response.status} ${await response.text().catch(() => "")}`.replace(/\s+/g, " ").slice(0, 300));
  }
  return response.json();
}

const sfx = Date.now().toString(36);

/* Seeded project A: canon pinned by a story — used for the stale-notice scenario. */
const projectA = await seedJson("/api/production/projects", { name: `Canon stale verification ${sfx}`, profileId: "storybook-short-v1" });
const charSeedId = `char_seed_${sfx}`;
const canonSeed = await seedJson(`/api/production/projects/${projectA.id}/canon`, {
  projectId: projectA.id, entityId: charSeedId, expectedRevisionId: null, entityKind: "character",
  description: "Seed rooftop courier with a red scarf.", attributes: {}, assetIds: [],
});
const storySeed = await seedJson(`/api/production/projects/${projectA.id}/stories`, {
  projectId: projectA.id, expectedStoryRevisionId: null,
  scriptText: "Seed script.\n\nAyo waits on the rooftop for the courier.",
  beats: [{ id: "beat_1", action: "Seed beat", narration: "Ayo waits on the rooftop for the courier.", dialogue: [] }],
  canonRevisionIds: [canonSeed.id],
});

/* Seeded project B: no script yet — used for script bounds/immutability/failure scenarios. */
const projectB = await seedJson("/api/production/projects", { name: `Script bounds verification ${sfx}`, profileId: "storybook-short-v1" });

const SCRIPT_ONE = "Ayo sprints across the rooftop at dawn.\n\nShe counts the city waking below her.";
const SCRIPT_TWO = `${SCRIPT_ONE}\n\nAyo descends to deliver the sealed letter.`;

/* The server's idFactory is randomUUID: revision ids are UUIDs, not prefixed ids. */
const REVISION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const firstRevisionIdIn = (text) => (text.match(REVISION_ID_RE) || [])[0] ?? "";

/* --------------------------- browser scenarios --------------------------- */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(45_000);

async function activeElementInfo() {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    return {
      tag: el.tagName,
      text: (el.textContent || "").trim().slice(0, 90),
      label: el.getAttribute("aria-label") || "",
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      focusVisible: el.matches(":focus-visible"),
    };
  });
}

/** Keyboard-only walk: Tab from the top of the document until the visible text equals target. */
async function tabReach(target, maxTabs = 120) {
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press("Tab");
    const info = await activeElementInfo();
    if (info && info.text === target) return { reached: true, info };
  }
  return { reached: false, info: await activeElementInfo() };
}

function alertByText(fragment) {
  return page.getByRole("alert").filter({ hasText: fragment });
}

/** Poll a zero-argument query until it equals want (React re-renders lag fills). */
async function eventually(query, want, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await query();
  while (value !== want && Date.now() < deadline) {
    await page.waitForTimeout(120);
    value = await query();
  }
  return value === want;
}
const eventuallyEnabled = (locator, want) => eventually(() => locator.isEnabled(), want);

/** Let client hydration catch up after a navigation: chunk traffic settles plus a beat. */
async function settled() {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
}

/**
 * Fill and re-fill until React state demonstrably took the value (a dev-server
 * first fill can land before hydration attaches onChange handlers).
 */
async function fillUntil(locator, value, confirm, label) {
  const deadline = Date.now() + 30_000;
  await locator.fill(value);
  while (!(await confirm())) {
    if (Date.now() > deadline) throw new Error(`fill never took effect: ${label}`);
    await page.waitForTimeout(250);
    await locator.fill(value);
  }
}

try {
  /* ------------------ T07-01 create project through the wizard ------------------ */
  await page.goto(`${BASE}/production/new`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Project name").waitFor();
  await settled();

  const nextToCast = page.getByRole("button", { name: "Next: Cast" });
  check("T07-01 details gate: Next is disabled while the name is blank", await eventuallyEnabled(nextToCast, false));
  await fillUntil(page.getByLabel("Project name"), `Canon UI verification ${sfx}`, () => nextToCast.isEnabled(), "project name");
  await page.getByLabel("Profile").selectOption("storybook-short-v1");
  check("T07-01 details gate: valid details enable Next", await eventuallyEnabled(nextToCast, true));
  await nextToCast.click();
  await page.getByText("Cast 1", { exact: true }).waitFor();

  const castEntityIds = page.getByLabel("Entity ID");
  await castEntityIds.nth(0).fill(`char_ayo_${sfx}`);
  await page.getByLabel("Description").nth(0).fill("Ayo, a rooftop courier.");
  await page.getByRole("button", { name: "Add another cast draft" }).click();
  await castEntityIds.nth(1).fill(`char_ayo_${sfx}`);
  await page.getByLabel("Description").nth(1).fill("Duplicate draft for validation.");

  const nextToWorld = page.getByRole("button", { name: "Next: World" });
  const duplicateAlert = alertByText("drafted twice");
  await duplicateAlert.waitFor();
  const duplicateShown = (await duplicateAlert.count()) === 1 && (await duplicateAlert.innerText()).includes(`char_ayo_${sfx}`);
  check("T07-01 duplicate pin shows a field issue and blocks the step",
    duplicateShown && (await eventuallyEnabled(nextToWorld, false)),
    (await duplicateAlert.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 140));

  await castEntityIds.nth(1).fill(`char_bode_${sfx}`);
  check("T07-01 fixing the duplicate clears the step gate",
    (await eventually(() => duplicateAlert.count(), 0)) && (await eventuallyEnabled(nextToWorld, true)));

  await page.getByLabel("Reference asset IDs").nth(1).fill(Array.from({ length: 101 }, (_, index) => `asset_${index}`).join(","));
  const assetAlert = alertByText("assetIds");
  await assetAlert.waitFor();
  const assetText = await assetAlert.innerText().catch(() => "");
  check("T07-01 101 reference assets show a field issue and block the step",
    assetText.includes("assetIds") && assetText.includes("100") && (await eventuallyEnabled(nextToWorld, false)),
    assetText.replace(/\s+/g, " ").slice(0, 140));
  await page.getByLabel("Reference asset IDs").nth(1).fill("");

  await nextToWorld.click();
  await page.getByText("World 1", { exact: true }).waitFor();
  await page.getByLabel("Entity ID").nth(0).fill(`loc_rooftop_${sfx}`);
  await page.getByLabel("Description").nth(0).fill("Lagos rooftop at dawn.");
  await page.getByRole("button", { name: "Next: Script" }).click();

  await page.getByLabel("Script text").waitFor();
  check("T07-01 script step shows the immutable-save copy", await page.getByText("immutable", { exact: false }).first().isVisible());
  await page.getByLabel("Script text").fill(SCRIPT_ONE);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/production\/(?!new$)[^/]+$/);
  const createdUrl = page.url();
  await page.getByRole("heading", { name: `Canon UI verification ${sfx}` }).waitFor();
  const overviewText = await page.getByRole("main").innerText();
  check("T07-01 project page shows the created project, canon and story ids",
    overviewText.includes(`char_ayo_${sfx}`) && overviewText.includes(`loc_rooftop_${sfx}`) &&
      REVISION_ID_RE.test(overviewText) && /active revisions/i.test(overviewText),
    createdUrl);
  check("T07-01 wizard wrote the script as the first immutable story revision", overviewText.includes("immutable"));
  await shot(page, "t07-01-project-overview");

  /* ------------------ T07-02 script import bounds ------------------ */
  await page.goto(`${BASE}/production/${projectB.id}/script`, { waitUntil: "domcontentloaded" });
  const scriptBox = page.getByLabel("Script text");
  await scriptBox.waitFor();
  await settled();

  const emptyAlert = alertByText("cannot be empty or whitespace only");
  await emptyAlert.waitFor();
  const saveButton = page.getByRole("button", { name: "Save script revision" });
  check("T07-02 blank script is rejected before any save (message + disabled save)",
    (await emptyAlert.count()) === 1 && (await eventuallyEnabled(saveButton, false)));

  const longAlert = alertByText("exceeds the 500000 character bound");
  await fillUntil(scriptBox, "a".repeat(500_001), async () => (await longAlert.count()) === 1, "oversized script text");
  check("T07-02 oversized script is rejected before any save (message + disabled save)",
    (await longAlert.count()) === 1 && (await eventuallyEnabled(saveButton, false)));
  await shot(page, "t07-02-bounds-rejected");

  const factsLine = page.getByText(/characters · .*bytes · .*lines/);
  await fillUntil(scriptBox, SCRIPT_ONE, async () => (await factsLine.count()) === 1, "valid script text");
  check("T07-02 import facts are derived for display", (await factsLine.innerText()).includes("bytes"));
  await saveButton.click();
  const firstBanner = page.getByText(/Saved — created immutable story revision/);
  await firstBanner.waitFor();
  const firstRevisionId = firstRevisionIdIn(await firstBanner.innerText());
  check("T07-02 first save creates a revision and the provenance shows a first revision",
    firstRevisionId.length > 0 && (await page.getByText("none (first revision)").count()) === 1,
    firstRevisionId);
  await shot(page, "t07-02-first-save");

  /* ------------------ T07-03 immutable revisions ------------------ */
  await scriptBox.fill(SCRIPT_TWO);
  await saveButton.click();
  const secondBanner = page.getByText(/Saved — created immutable story revision/);
  await secondBanner.waitFor();
  const secondRevisionId = firstRevisionIdIn(await secondBanner.innerText());
  check("T07-03 second save creates a distinct revision id",
    secondRevisionId.length > 0 && secondRevisionId !== firstRevisionId,
    `${firstRevisionId} -> ${secondRevisionId}`);

  const history = page.getByRole("region", { name: "Revision history" });
  const historyText = await history.innerText();
  check("T07-03 superseded first revision keeps its exact original text in history",
    historyText.includes(firstRevisionId) && historyText.includes("Ayo sprints across the rooftop at dawn.") &&
      historyText.includes("She counts the city waking below her.") && !historyText.includes("Ayo descends to deliver"),
    `history names ${firstRevisionId}`);
  await shot(page, "t07-03-immutable-history");

  /* ------------------ T07-05 failed save keeps editor data ------------------ */
  const textBeforeFailure = await scriptBox.inputValue();
  await page.route("**/api/production/projects/*/stories", async (route) => { await route.abort("connectionrefused"); });
  await saveButton.click();
  const networkAlert = alertByText("NETWORK_ERROR");
  await networkAlert.waitFor();
  check("T07-05 aborted save shows an honest network error and keeps the editor text",
    (await networkAlert.count()) === 1 && (await scriptBox.inputValue()) === textBeforeFailure);

  await page.unroute("**/api/production/projects/*/stories");
  await page.route("**/api/production/projects/*/stories", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Forced verification failure", retryable: false }, requestId: "req_forced_c07" }),
    });
  });
  await saveButton.click();
  const envelopeAlert = alertByText("req_forced_c07");
  await envelopeAlert.waitFor();
  const envelopeText = await envelopeAlert.innerText().catch(() => "");
  check("T07-05 error envelope renders code, message and request id and keeps the editor text",
    envelopeText.includes("INTERNAL_ERROR") && envelopeText.includes("Forced verification failure") &&
      envelopeText.includes("req_forced_c07") && (await scriptBox.inputValue()) === textBeforeFailure,
    envelopeText.replace(/\s+/g, " ").slice(0, 160));
  await shot(page, "t07-05-failed-save-keeps-data");

  await page.unroute("**/api/production/projects/*/stories");
  await saveButton.click();
  const retryBanner = page.getByText(/Saved — (created immutable story revision|identical content)/);
  await retryBanner.waitFor();
  check("T07-05 retry after failures succeeds with the editor text intact",
    (await scriptBox.inputValue()) === textBeforeFailure && (await alertByText("req_forced_c07").count()) === 0,
    (await retryBanner.innerText()).replace(/\s+/g, " ").slice(0, 120));

  /* ------------------ T07-07 proposal control (I02, fail-closed) ------------------ */
  const proposeButton = page.getByRole("button", { name: "Request story proposal" });
  await proposeButton.click();
  const entitledAlert = page.getByRole("alert").filter({ hasText: "Script proposal planning is not yet entitled." });
  await entitledAlert.waitFor();
  const entitledText = await entitledAlert.innerText().catch(() => "");
  check("T07-07 403 proposal envelope renders as an explicit not-yet-entitled state",
    entitledText.includes("BUDGET_BLOCKED") && entitledText.includes("Request ID:") && entitledText.includes("never apply automatically"),
    entitledText.replace(/\s+/g, " ").slice(0, 200));
  check("T07-07 no success state is claimed for the blocked proposal", (await page.getByText("Proposal accepted").count()) === 0);
  await shot(page, "t07-07-proposal-not-entitled");

  /* ------------------ T07-06 keyboard focus and accessible labels ------------------ */
  await page.goto(`${BASE}/production/${projectB.id}/script`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Script text").waitFor();
  await settled();
  check("T07-06 script editor exposes an accessible label for the script text", (await page.getByLabel("Script text").count()) === 1);
  const scriptTab = await tabReach("Save script revision");
  check("T07-06 keyboard-only tabbing reaches the save button with visible focus",
    scriptTab.reached && scriptTab.info?.tag === "BUTTON" && scriptTab.info.visible && scriptTab.info.focusVisible,
    JSON.stringify(scriptTab.info));

  await page.goto(`${BASE}/production/${projectB.id}/canon`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Entity ID").waitFor();
  await settled();
  const canonLabels = (await page.getByLabel("Entity ID").count()) === 1 &&
    (await page.getByLabel("Entity kind").count()) === 1 &&
    (await page.getByLabel("Description").count()) === 1;
  check("T07-06 canon editor labels its entity inputs", canonLabels);
  const canonTab = await tabReach("Create canon revision");
  check("T07-06 keyboard-only tabbing reaches the canon save button with visible focus",
    canonTab.reached && canonTab.info?.tag === "BUTTON" && canonTab.info.focusVisible,
    JSON.stringify(canonTab.info));
  await shot(page, "t07-06-canon-focus");

  /* ------------------ T07-04 stale downstream notices ------------------ */
  await page.goto(`${BASE}/production/${projectA.id}/canon`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Entity ID").waitFor();
  await settled();
  await page.getByLabel("Description").fill("Seed rooftop courier with a green scarf, revised.");
  const createCanonButton = page.getByRole("button", { name: "Create canon revision" });
  await fillUntil(page.getByLabel("Entity ID"), charSeedId, () => createCanonButton.isEnabled(), "canon entity id");
  await page.getByLabel("Entity kind").selectOption("character");
  await createCanonButton.click();
  const canonBanner = page.getByText(/Saved — canon revision/);
  await canonBanner.waitFor();
  check("T07-04 canon editor saves a new immutable revision for the pinned entity",
    (await canonBanner.innerText()).includes(charSeedId),
    (await canonBanner.innerText()).replace(/\s+/g, " ").slice(0, 140));

  const canonStale = page.getByRole("region", { name: "Stale downstream work" });
  await canonStale.getByText(/is stale/).waitFor();
  const canonStaleText = await canonStale.innerText();
  check("T07-04 canon page stale notice names the stale story and the replaced pin",
    canonStaleText.includes(storySeed.id) && canonStaleText.includes(canonSeed.id) && canonStaleText.includes("DEPENDENCY_REPLACED"),
    canonStaleText.replace(/\s+/g, " ").slice(0, 200));

  await page.goto(`${BASE}/production/${projectA.id}`, { waitUntil: "domcontentloaded" });
  const projectStale = page.getByRole("region", { name: "Stale downstream work" });
  await projectStale.getByText(/is stale/).waitFor();
  const projectStaleText = await projectStale.innerText();
  check("T07-04 project page stale notice names the stale story and both revisions",
    projectStaleText.includes(storySeed.id) && projectStaleText.includes(canonSeed.id),
    projectStaleText.replace(/\s+/g, " ").slice(0, 200));
  await shot(page, "t07-04-stale-notices");
} catch (error) {
  check("C07 canon/script workflow completed", false, String(error).replace(/\s+/g, " ").slice(0, 300));
  try { await shot(page, "failure-state"); } catch { /* screenshot best-effort */ }
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots: ${shotPaths.length} files in ${runDir}`);
process.exit(failed.length ? 1 : 0);

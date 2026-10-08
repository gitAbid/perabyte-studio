#!/usr/bin/env node
/**
 * C19-PLAN-UI GUI smoke (offline, localhost only, zero spend).
 *
 * Drives the ENTIRE browser flow with a throwaway project: create project (details/cast/world/
 * script) -> save story -> approve story (tick the checklist) -> plan page: verify fail-closed
 * pre-approval state, build the plan from beats, edit drafts, create -> approve shot plan ->
 * approve animatic -> storyboard shows the shots with plan/animatic approval chips green.
 *
 * Media safety: every network request is recorded; any request to media-quotes, anchors, takes or
 * jobs endpoints FAILS the run (zero media-quotes, zero enqueues). The script never starts the
 * server: it requires an already-healthy stack at the given base URL.
 *
 * Usage: node smoke-driver.mjs http://127.0.0.1:3210 <screenshot-dir> <log-file>
 */
import { chromium } from "playwright";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3210").replace(/\/$/, "");
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/api/production/")) mediaRequests.push(url);
});
page.setDefaultTimeout(15000);

try {
  /* 1. Sidebar links to Production */
  await page.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
  const productionLink = page.locator('nav[aria-label="Primary"] a[href="/production"]');
  check("sidebar has Production link", (await productionLink.count()) === 1);
  check("sidebar Production label", (await productionLink.first().textContent())?.trim() === "Production");
  await shot(page, "01-sidebar-production");

  /* 2. Create project via the four-step wizard */
  await page.goto(`${BASE}/production/new`, { waitUntil: "networkidle" });
  await page.fill("#project-name", "C19 Plan UI Smoke");
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
  check("script wizard beats derived", (await page.locator("p[role='status']").filter({ hasText: "2 beats" }).count()) === 1);
  await shot(page, "02-wizard-script");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(/\/production\/(?!new$)[A-Za-z0-9][A-Za-z0-9_.:-]*$/, { timeout: 30000 });
  const projectId = new URL(page.url()).pathname.split("/").pop();
  check("project created, redirected to overview", /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(projectId) && projectId !== "new", projectId);
  const overviewStates = page.locator('[data-testid="overview-approval-states"]');
  await overviewStates.waitFor({ timeout: 20000 });
  check("overview has Plan button", (await page.getByRole("link", { name: "Plan", exact: true }).count()) === 1);
  check("overview approval states section", await overviewStates.count() === 1);
  check("overview chips: story approved missing, no plan/animatic yet", (await overviewStates.textContent())?.includes("no revision yet") === true);
  await shot(page, "03-overview-after-create");

  /* 3. Plan page fails closed before story approval */
  await page.goto(`${BASE}/production/${projectId}/plan`, { waitUntil: "networkidle" });
  check("plan page fail-closed: story not approved", await page.getByText("The current story revision is not approved").count() === 1);
  check("plan page links to script editor", await page.locator('a[href^="/production/"]').filter({ hasText: "Approve the story" }).count() >= 1);
  await shot(page, "04-plan-failclosed-unapproved");

  /* 4. Script editor: save story + approve with checklist */
  await page.goto(`${BASE}/production/${projectId}/script`, { waitUntil: "networkidle" });
  const editor = page.getByRole("textbox", { name: "Script text" });
  check("script editor prefilled from saved story", ((await editor.inputValue()) || "").startsWith("The narrator opens the film"));
  const approval = page.locator('[data-testid="story-approval-workspace"]');
  check("story approval workspace visible", await approval.count() === 1);
  const boxes = approval.locator('input[type="checkbox"]');
  check("story checklist has 5 items", await boxes.count() === 5);
  const noteInputs = approval.locator('input[aria-label^="Note for checklist item"]');
  check("story checklist note inputs present", await noteInputs.count() === 5);
  check("approve disabled until checklist ticked", await page.getByTestId("story-approve-button").isDisabled());
  await noteInputs.nth(0).fill("Protagonist goal stated in the opening beat.");
  await noteInputs.nth(4).fill("Narration reviewed aloud; no dialogue yet.");
  for (let i = 0; i < 5; i += 1) await boxes.nth(i).check();
  await shot(page, "05-story-approval-ticked");
  await page.getByTestId("story-approve-button").click();
  await page.locator('[data-testid="story-approval-section"]').getByText(/approved and current|Story approved/).first().waitFor({ timeout: 20000 });
  check("story approved via checklist", true);
  await shot(page, "06-story-approved");

  /* 5. Plan page: build plan from beats, edit drafts, create */
  await page.getByRole("link", { name: "Build the shot plan" }).click();
  await page.waitForURL(/\/production\/[^/]+\/plan$/, { timeout: 20000 });
  await page.getByTestId("plan-builder").waitFor();
  const card1 = page.locator('[data-testid="plan-shot-draft"][data-shot-id="shot_1"]');
  const card2 = page.locator('[data-testid="plan-shot-draft"][data-shot-id="shot_2"]');
  check("two draft shots derived from beats", (await card1.count()) === 1 && (await card2.count()) === 1);
  const visual1 = await card1.locator("textarea").inputValue();
  check("visual intent prefilled from beat action", visual1 === "The narrator opens the film on a quiet harbor at dawn while Ayo checks her skiff.", visual1.slice(0, 40) + "…");
  const motion1 = await card1.locator('input[id$="-motion"]').inputValue();
  check("motion intent prefilled", motion1 === "Gentle, storybook camera movement.");
  check("framing defaults to medium", (await card1.locator('select[id$="-framing"]').inputValue()) === "medium");
  check("frames default 192 on H3 grid", (await card1.locator('input[id$="-frames"]').inputValue()) === "192" && (await card1.getByText("on H3 grid").count()) === 1);
  check("duration hint shown", (await card1.getByText("≈ 8.000s at 24 fps").count()) === 1);
  const loc1 = await card1.locator('select[id$="-location"]').inputValue();
  const style1 = await card1.locator('select[id$="-style"]').inputValue();
  check("location/style prefilled from canon options", loc1 !== "" && style1 !== "");

  // prove fields are editable + off-grid frames flagged without blocking
  await card1.locator('select[id$="-framing"]').selectOption("wide");
  const framesInput = card1.locator('input[id$="-frames"]');
  await framesInput.fill("200");
  check("off-grid frames flagged without blocking", (await card1.getByText("off H3 grid").count()) === 1 && !(await page.getByTestId("create-plan-button").isDisabled()));
  await framesInput.fill("192");
  await card1.locator("textarea").fill("Wide establishing frame: the harbor at dawn, Ayo silhouetted on the dock.");

  // cast binding: wardrobe suggestion then tick in shot 2 (covers the dialogue beat)
  await page.fill("#wardrobe-char_ayo", "Oilskin coat over a knit sweater");
  const cast2 = card2.locator("label", { hasText: "char_ayo" });
  await cast2.locator('input[type="checkbox"]').check();
  const wardrobeBinding = card2.locator('input[aria-label^="Wardrobe for char_ayo in shot"]');
  check("cast binding carries wardrobe text", (await wardrobeBinding.inputValue()) === "Oilskin coat over a knit sweater");
  await shot(page, "07-plan-drafts-edited");

  await page.getByTestId("create-plan-button").click();
  await page.getByTestId("plan-created-banner").waitFor({ timeout: 20000 });
  check("shot plan + animatic created", true);
  await page.getByTestId("current-plan-section").getByText("Current shot plan & animatic").waitFor();
  await page.locator('[data-testid="plan-summary-row"]').first().waitFor();
  const summaryRows = await page.locator('[data-testid="plan-summary-row"]').count();
  check("read-only summary lists 2 shots", summaryRows === 2);
  await shot(page, "08-plan-created");

  /* 6. Approve shot plan */
  const planWorkspace = page.locator('[data-testid="shotplan-approve-workspace"]');
  const planBoxes = planWorkspace.locator('input[type="checkbox"]');
  check("shotplan checklist has 5 items", await planBoxes.count() === 5);
  for (let i = 0; i < 5; i += 1) await planBoxes.nth(i).check();
  await page.getByTestId("shotplan-approve-button").click();
  await page.getByTestId("shotplan-approved").waitFor({ timeout: 20000 });
  check("shot plan approved", true);
  await shot(page, "09-shotplan-approved");

  /* 7. Approve animatic */
  const animaticWorkspace = page.locator('[data-testid="animatic-approve-workspace"]');
  const animaticBoxes = animaticWorkspace.locator('input[type="checkbox"]');
  check("animatic checklist has 5 items", await animaticBoxes.count() === 5);
  for (let i = 0; i < 5; i += 1) await animaticBoxes.nth(i).check();
  await page.getByTestId("animatic-approve-button").click();
  await page.getByTestId("animatic-approved").waitFor({ timeout: 20000 });
  check("animatic approved", true);
  await shot(page, "10-animatic-approved");

  /* 8. Storyboard populated with green approval chips */
  await page.goto(`${BASE}/production/${projectId}/shots`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="shot-row"]').first().waitFor();
  const shotRows = await page.locator('[data-testid="shot-row"]').count();
  check("storyboard shows both shots", shotRows === 2);
  const approvalStates = page.locator('[data-testid="approval-states"]');
  const statesText = (await approvalStates.textContent()) ?? "";
  const shotplanApproved = await approvalStates.locator("li", { hasText: "shotplan" }).locator(".bg-success-soft").count();
  const animaticApproved = await approvalStates.locator("li", { hasText: "animatic" }).locator(".bg-success-soft").count();
  check("storyboard shotplan chip green", shotplanApproved >= 1, statesText.slice(0, 80));
  check("storyboard animatic chip green", animaticApproved >= 1);
  await shot(page, "11-storyboard-green");

  /* 9. Overview chips green */
  await page.goto(`${BASE}/production/${projectId}`, { waitUntil: "networkidle" });
  const overviewText = (await page.locator('[data-testid="overview-approval-states"]').textContent()) ?? "";
  check("overview chips all approved", (overviewText.match(/approved/g) ?? []).length >= 3 && !overviewText.includes("not approved"));
  await shot(page, "12-overview-green");

  /* 10. Media safety: zero media-quotes / enqueues */
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

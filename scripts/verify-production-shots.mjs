#!/usr/bin/env node
/**
 * Browser verification for the C08 storyboard/anchors/takes UI (offline/localhost only).
 *
 * Usage: node scripts/verify-production-shots.mjs http://127.0.0.1:3100
 *
 * REDUCED SCENARIO SET, FROZEN HONESTLY (C08-root-freeze disclosure): anchors and takes cannot
 * exist over HTTP without provider receipts (insertAnchor/insertTake only happen on the
 * job-completion path), so live take-sibling approve/reject, selection and reversal are proven at
 * the pure-derivation level (lib/production/storyboard.test.ts) with fixture read models, not in
 * the browser. Likewise canon reference asset IDs require existing media bytes, so the pinned
 * reference-asset display with the honest no-bytes note is proven by deriveShotProvenance tests.
 * This script seeds ONLY through the accepted HTTP routes, never writes the store directly, and
 * never fabricates candidates.
 *
 * Fail-closed preconditions: the dev server must already be healthy — this script never starts
 * the server and never sends a request beyond the given base URL. No ffmpeg requirement.
 * Any FAIL exits 1.
 */
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const runDir = mkdtempSync(join(tmpdir(), "c08-verify-"));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* Preconditions: server health (the script never starts the dev server). */
const health = await fetch(`${BASE}/api/production/health`).catch(() => null);
if (!health || !health.ok) {
  console.log(`BLOCKED: no healthy production server at ${BASE}. start: PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> npx next dev -p 3100`);
  process.exit(1);
}

/* Seeding: HTTP-only through the accepted production routes, Origin on every mutation. */
async function postJson(path, body, expectStatus = 201) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
  if (response.status !== expectStatus) {
    console.log(`BLOCKED: seed step POST ${path} returned HTTP ${response.status} (expected ${expectStatus}): ${(await response.text().catch(() => "")).slice(0, 400)}`);
    process.exit(1);
  }
  return response.json();
}

const STORY_CHECKLIST = ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"];
const SHOTPLAN_CHECKLIST = ["beat_coverage", "spoken_lines", "canon_bindings", "duration_format", "plot_fidelity"];
const ANIMATIC_CHECKLIST = ["beat_coverage", "spoken_lines", "timing", "duration_format", "continuity"];

/* (1) project */
const project = await postJson("/api/production/projects", { name: "Storyboard UI verification", profileId: "storybook-short-v1" });
const projectId = project.id;

const approve = (idempotencyKey, command) => postJson("/api/production/approvals", { projectId, idempotencyKey, command }, 201);

/* (2) canon revisions: location + style (reference asset IDs would need real media bytes — not seedable offline). */
const locRev = await postJson(`/api/production/projects/${projectId}/canon`, {
  projectId, entityId: "loc_harbor", expectedRevisionId: null, entityKind: "location",
  description: "A foggy harbor at dawn", attributes: {}, assetIds: [],
});
const styleRev = await postJson(`/api/production/projects/${projectId}/canon`, {
  projectId, entityId: "style_book", expectedRevisionId: null, entityKind: "style",
  description: "Ink-and-water storybook style", attributes: {}, assetIds: [],
});

/* (3) canon selections */
await postJson(`/api/production/projects/${projectId}/canon/selection`, {
  projectId, entityId: "loc_harbor", expectedRevisionId: locRev.id, canonRevisionId: locRev.id,
}, 200);
await postJson(`/api/production/projects/${projectId}/canon/selection`, {
  projectId, entityId: "style_book", expectedRevisionId: styleRev.id, canonRevisionId: styleRev.id,
}, 200);

/* (4) story v1 */
const NARRATION_V1 = "The narrator opens the film on a quiet harbor at dawn.";
const storyV1 = await postJson(`/api/production/projects/${projectId}/stories`, {
  projectId,
  expectedStoryRevisionId: null,
  scriptText: NARRATION_V1,
  beats: [
    { id: "beat_opening", action: "The harbor wakes.", narration: NARRATION_V1, dialogue: [] },
    { id: "beat_closing", action: "The film closes.", narration: "The narrator closes the film over the water.", dialogue: [] },
  ],
  canonRevisionIds: [locRev.id, styleRev.id],
});

/* (5) story approval — REQUIRED before a shot plan exists */
await approve("verify-story-v1", {
  targetKind: "story", targetId: storyV1.id, expectedHash: storyV1.contentHash, decision: "approved",
  checklist: STORY_CHECKLIST.map((id) => ({ id, passed: true, note: "verified against the script" })),
  notes: "", advisoryAcknowledgements: [],
});

/* (6) shot plan: EIGHT shots in plan order (no six-shot ceiling), varied framing/targetFrames */
const FRAMINGS = ["wide", "medium", "close", "extreme_wide", "medium_wide", "wide", "close", "extreme_close"];
const TARGET_FRAMES = [24, 36, 48, 12, 96, 24, 60, 13];
const DURATION_LABELS = ["1.000s", "1.500s", "2.000s", "0.500s", "4.000s", "1.000s", "2.500s", "0.541s"];
const shots = FRAMINGS.map((framing, index) => ({
  shotId: `shot_${index + 1}`,
  beatIds: [index % 2 === 0 ? "beat_opening" : "beat_closing"],
  visualIntent: `Harbor frame ${index + 1} in the pinned style`,
  motionIntent: `Slow push ${index + 1}`,
  castBindings: [],
  locationRevisionId: locRev.id,
  propRevisionIds: [],
  styleRevisionId: styleRev.id,
  framing,
  targetFrames: TARGET_FRAMES[index],
  continuation: null,
}));
const plan = await postJson(`/api/production/projects/${projectId}/shot-plans`, {
  projectId, storyRevisionId: storyV1.id, approvedStoryHash: storyV1.contentHash, shots,
});

/* (7) shot plan + animatic approvals */
await approve("verify-shotplan-v1", {
  targetKind: "shotplan", targetId: plan.shotPlanRevision.id, expectedHash: plan.shotPlanRevision.contentHash, decision: "approved",
  checklist: SHOTPLAN_CHECKLIST.map((id) => ({ id, passed: true, note: "verified" })),
  notes: "", advisoryAcknowledgements: [],
});
await approve("verify-animatic-v1", {
  targetKind: "animatic", targetId: plan.animaticRevision.id, expectedHash: plan.animaticRevision.contentHash, decision: "approved",
  checklist: ANIMATIC_CHECKLIST.map((id) => ({ id, passed: true, note: "verified" })),
  notes: "", advisoryAcknowledgements: [],
});
console.log(`seeded project ${projectId}: story ${storyV1.id}, plan ${plan.shotPlanRevision.id}, animatic ${plan.animaticRevision.id}`);

/* Browser session with a non-local request tripwire. */
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
let externalRequests = 0;
await context.route((url) => /^https?:$/i.test(url.protocol) && !url.href.startsWith(`${BASE}/`), async (route) => {
  externalRequests += 1;
  await route.abort();
});

async function screenshot(name) {
  const path = join(runDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`screenshot: ${path}`);
}
const detail = (error) => String(error).replace(/\s+/g, " ").slice(0, 240);
const shotsUrl = `${BASE}/production/${projectId}/shots`;
const anchorsUrl = `${BASE}/production/${projectId}/anchors`;
const takesUrl = `${BASE}/production/${projectId}/takes`;
const PLAN_ORDER = Array.from({ length: 8 }, (_, index) => `shot_${index + 1}`).join(",");

/* Reset focus to the document start. Chromium keeps the sequential focus navigation starting
   point after blur(), so the reset focuses the first focusable element instead. */
async function resetFocusToStart(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const first = document.querySelector("a[href], button:not([disabled]), input:not([disabled]), select, textarea");
    if (first instanceof HTMLElement) first.focus();
  });
}

/* Keyboard-only helper: reset to the start, then Tab until the predicate matches. */
async function tabTo(page, predicate, maxSteps = 160) {
  await resetFocusToStart(page);
  for (let step = 0; step < maxSteps; step += 1) {
    if (await page.evaluate(predicate)) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

try {
  /* T08-order — 8 shots in plan order with stable indices across chunk navigation and per-shot duration. */
  try {
    await page.goto(shotsUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("shots-page").waitFor();
    const rows = page.getByTestId("shot-row");
    await rows.first().waitFor();
    const chunkStatus = await page.getByTestId("chunk-status").innerText();
    check("T08-order chunk status reports 8 shots over 2 chunks (no six-shot ceiling)", /Chunk 1 of 2/.test(chunkStatus) && /shots 1–6 of 8/.test(chunkStatus), chunkStatus.replace(/\s+/g, " "));
    const chunkOneIds = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-shot-id")));
    const chunkOneIndices = await rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-index")));
    check("T08-order chunk 1 lists shots 1–6 in plan order with stable 1-based indices",
      chunkOneIds.join(",") === PLAN_ORDER.split(",").slice(0, 6).join(",") && chunkOneIndices.join(",") === "1,2,3,4,5,6",
      `${chunkOneIds.join(",")}/${chunkOneIndices.join(",")}`);
    const durations = await page.getByTestId("shot-duration").evaluateAll((elements) =>
      elements.map((element) => `${element.getAttribute("data-frames")}=${element.getAttribute("data-label")}`));
    const expectedDurations = TARGET_FRAMES.slice(0, 6).map((frames, index) => `${frames}=${DURATION_LABELS[index]}`);
    check("T08-order per-shot durations derive from targetFrames at 24fps (integer math)", durations.join(",") === expectedDurations.join(","), durations.join(","));
    await page.getByRole("button", { name: "Next shots" }).click();
    await page.getByTestId("chunk-status").filter({ hasText: "Chunk 2 of 2" }).waitFor();
    const chunkTwoIds = await page.getByTestId("shot-row").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-shot-id")));
    const chunkTwoIndices = await page.getByTestId("shot-row").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-index")));
    check("T08-order chunk 2 holds shots 7–8 with stable indices across the chunk boundary",
      chunkTwoIds.join(",") === "shot_7,shot_8" && chunkTwoIndices.join(",") === "7,8",
      `${chunkTwoIds.join(",")}/${chunkTwoIndices.join(",")}`);
    check("T08-order the two chunks concatenate to the full plan order", `${chunkOneIds.join(",")},${chunkTwoIds.join(",")}` === PLAN_ORDER);
    await page.getByRole("button", { name: "Previous shots" }).click();
    await page.getByTestId("chunk-status").filter({ hasText: "Chunk 1 of 2" }).waitFor();
    check("T08-order Previous returns to chunk 1 with the same stable order", (await page.getByTestId("shot-row").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-shot-id")))).join(",") === chunkOneIds.join(","));
  } catch (error) {
    check("T08-order scenario completed", false, detail(error));
  }
  await screenshot("T08-order");

  /* T08-gates — anchors page: honest empty states, disabled submit WITH reason, keyboard-only pass,
     disabled submit fires nothing, aborted mutation keeps local state (all while every shot is
     current and approved, so the only honest gate still shown is the missing provider input). */
  try {
    await page.goto(anchorsUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("anchors-page").waitFor();
    const emptyStates = page.getByTestId("anchor-empty");
    await emptyStates.first().waitFor();
    const emptyCount = await emptyStates.count();
    const firstEmptyText = await emptyStates.first().innerText();
    check(
      "T08-gates all 8 shots render the honest empty anchor state naming the prerequisite chain",
      emptyCount === 8 && /No anchors exist for shot shot_1/.test(firstEmptyText) && /animatic/.test(firstEmptyText) && /job/.test(firstEmptyText),
      `${emptyCount} empty states`,
    );
    check("T08-gates no fabricated anchor candidates or approval workspaces exist", (await page.getByTestId("approval-workspace").count()) === 0, `${await page.getByTestId("approval-workspace").count()} workspaces`);
    const submitButtons = page.getByTestId("anchor-submit-button");
    const submitCount = await submitButtons.count();
    let allDisabled = true;
    for (let index = 0; index < submitCount; index += 1) if (!(await submitButtons.nth(index).isDisabled())) allDisabled = false;
    check("T08-gates every anchor generation submit is disabled", allDisabled && submitCount === 8, `${submitCount} submits`);
    const gateReasons = page.getByTestId("anchor-submit-gate-reasons");
    const firstReasons = await gateReasons.first().innerText();
    check(
      "T08-gates the disabled submit shows always-visible reasons",
      (await gateReasons.count()) === 8 && /PROVIDER_MODEL_REQUIRED/.test(firstReasons) && /provider and model are required/.test(firstReasons),
      firstReasons.replace(/\s+/g, " ").slice(0, 200),
    );
  } catch (error) {
    check("T08-gates anchors empty states scenario completed", false, detail(error));
  }
  await screenshot("T08-gates-anchors");

  try {
    await page.goto(takesUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("takes-page").waitFor();
    const emptyStates = page.getByTestId("take-empty");
    await emptyStates.first().waitFor();
    const emptyCount = await emptyStates.count();
    const firstEmptyText = await emptyStates.first().innerText();
    check(
      "T08-gates all 8 shots render the honest empty take state naming the anchor prerequisite",
      emptyCount === 8 && /No takes exist for shot shot_1/.test(firstEmptyText) && /anchor/.test(firstEmptyText) && /job/.test(firstEmptyText),
      `${emptyCount} empty states`,
    );
    const takeSubmits = page.getByTestId("take-submit-button");
    const takeSubmitCount = await takeSubmits.count();
    let takesAllDisabled = true;
    for (let index = 0; index < takeSubmitCount; index += 1) if (!(await takeSubmits.nth(index).isDisabled())) takesAllDisabled = false;
    const takeReasons = await page.getByTestId("take-submit-gate-reasons").first().innerText();
    check(
      "T08-gates every take generation submit is disabled with a visible reason (no approved anchor)",
      takesAllDisabled && takeSubmitCount === 8 && /ANCHOR_APPROVAL_REQUIRED/.test(takeReasons),
      takeReasons.replace(/\s+/g, " ").slice(0, 220),
    );
    check("T08-gates no take rows or selection controls exist without candidates", (await page.getByTestId("take-row").count()) === 0 && (await page.getByTestId("select-take-button").count()) === 0);
  } catch (error) {
    check("T08-gates takes scenario completed", false, detail(error));
  }
  await screenshot("T08-gates-takes");

  /* Keyboard-only pass on the anchors page: reach and operate enabled controls. */
  try {
    await page.goto(anchorsUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("anchors-page").waitFor();
    await page.getByTestId("anchor-empty").first().waitFor();
    const reached = [];
    let previous = "";
    await resetFocusToStart(page);
    for (let step = 0; step < 160; step += 1) {
      const info = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          testId: element.getAttribute("data-testid"),
          key: `${element.tagName}:${element.getAttribute("aria-label") ?? element.getAttribute("id") ?? (element.textContent ?? "").trim().slice(0, 24)}`,
          visible: rect.width > 0 && rect.height > 0,
          inPage: !!element.closest('[data-testid="anchors-page"]'),
        };
      });
      if (info && info.key !== previous) {
        reached.push(info);
        previous = info.key;
      }
      await page.keyboard.press("Tab");
    }
    const invisibleInPage = reached.filter((entry) => entry.inPage && !entry.visible);
    check(
      "T08-gates keyboard-only pass reaches many distinct controls with none hidden inside the page",
      reached.length >= 20 && invisibleInPage.length === 0,
      `${reached.length} distinct controls (${reached.filter((entry) => entry.inPage).length} inside the page), hidden inside page: ${invisibleInPage.map((entry) => entry.key).join("|") || "none"}`,
    );
    /* Operate an enabled control by keyboard: type into the first provider input. */
    const typed = await tabTo(page, () => document.activeElement?.getAttribute("data-testid") === "anchor-provider-input");
    if (typed) await page.keyboard.type("keyboard-provider");
    const providerValue = await page.getByTestId("anchor-provider-input").first().inputValue();
    check("T08-gates keyboard-only typing reaches and operates the provider input", typed && providerValue === "keyboard-provider", `value=${providerValue}`);
    /* Enter on Reload re-runs the read-model fetch. */
    const reloaded = await tabTo(page, () => document.activeElement?.getAttribute("data-testid") === "reload-button");
    if (reloaded) await page.keyboard.press("Enter");
    await page.getByTestId("anchor-empty").first().waitFor();
    check("T08-gates keyboard-only Enter on Reload re-fetches the read model", reloaded);
  } catch (error) {
    check("T08-gates keyboard-only pass completed", false, detail(error));
  }

  /* Disabled submit must not fire: press Enter on the disabled anchor submit and count quote POSTs. */
  try {
    let quotePosts = 0;
    await page.route("**/api/production/media-quotes", async (route) => {
      if (route.request().method() === "POST") quotePosts += 1;
      await route.continue();
    });
    await page.getByTestId("anchor-provider-input").first().fill("");
    await page.getByTestId("anchor-submit-button").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    check("T08-gates pressing the disabled submit fires no quote request", quotePosts === 0, `${quotePosts} quote POSTs`);
    await page.unroute("**/api/production/media-quotes");
  } catch (error) {
    check("T08-gates disabled submit request-guard completed", false, detail(error));
  }

  /* Aborted mutation keeps local state (the shot is still current and approved here, so the gate
     is satisfiable; the server then answers the quote request with the real offline decision). */
  try {
    await page.goto(anchorsUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("anchors-page").waitFor();
    await page.getByTestId("anchor-empty").first().waitFor();
    await page.getByTestId("anchor-provider-input").first().fill("local-prov");
    await page.getByTestId("anchor-model-input").first().fill("local-model");
    const submit = page.getByTestId("anchor-submit-button").first();
    check("T08-error-retry the current approved shot enables the submit once provider and model are set", !(await submit.isDisabled()));
    /* First click: the real server answers. Offline, the media-quotes composition layer throws
       BUDGET_BLOCKED before the route envelope path, so the page receives an unparseable 500;
       the UI must render that honestly as a failure state, never a success or a job. A real
       BUDGET_BLOCKED envelope renders as the blocked banner (BlockedAlert code path). */
    await submit.click();
    const alert = page.locator('[data-testid="anchor-submit-form"] [role="alert"]').first();
    await alert.waitFor();
    const refusalText = await alert.innerText();
    const blockedBanner = await page.locator('[data-testid="anchor-submit-form"]').first().locator(":text('Generation is blocked')").count();
    check(
      "T08-error-retry the server refusal renders as an explicit failure state (never a job or success)",
      /The generation request could not be submitted/.test(refusalText) && /500/.test(refusalText) && blockedBanner === 0,
      refusalText.replace(/\s+/g, " ").slice(0, 220),
    );
    /* Second click with the route aborted at the network boundary: honest failure, inputs kept. */
    await page.route("**/api/production/media-quotes", async (route) => {
      if (route.request().method() === "POST") { await route.abort("failed"); return; }
      await route.continue();
    });
    await page.getByTestId("anchor-provider-input").first().fill("aborted-prov");
    await submit.click();
    await page.locator('[data-testid="anchor-submit-form"] [role="alert"]:has-text("network")').first().waitFor();
    const networkText = await page.locator('[data-testid="anchor-submit-form"] [role="alert"]').first().innerText();
    const providerKept = await page.getByTestId("anchor-provider-input").first().inputValue();
    const modelKept = await page.getByTestId("anchor-model-input").first().inputValue();
    check(
      "T08-error-retry aborted mutation renders a network error and keeps every local input",
      /network/i.test(networkText) && providerKept === "aborted-prov" && modelKept === "local-model",
      `provider=${providerKept} model=${modelKept}`,
    );
    await page.unroute("**/api/production/media-quotes");
  } catch (error) {
    check("T08-error-retry aborted-mutation scenario completed", false, detail(error));
  }
  await screenshot("T08-error-retry-aborted-mutation");

  /* T08-provenance-stale — pins displayed per shot; seeding step (8): story v2 makes the plan stale. */
  let storyV2 = null;
  try {
    await page.goto(shotsUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("shots-page").waitFor();
    const firstCard = page.getByTestId("shot-row").first().locator("xpath=ancestor::article");
    await firstCard.waitFor();
    const card = await firstCard.innerText();
    check(
      "T08-provenance location and style pins with canon descriptions render per shot",
      card.includes(locRev.id) && card.includes("A foggy harbor at dawn") && card.includes(styleRev.id) && card.includes("Ink-and-water storybook style"),
      card.replace(/\s+/g, " ").slice(0, 160),
    );
    check(
      "T08-provenance the provenance rows honestly show the unseedable parts",
      card.includes("none (no cast bindings)") && card.includes("Reference media") && card.includes("none pinned"),
      "reference assets require media bytes and cannot be seeded offline; the honest empty pin row renders",
    );
    storyV2 = await postJson(`/api/production/projects/${projectId}/stories`, {
      projectId,
      expectedStoryRevisionId: storyV1.id,
      scriptText: "A rewritten harbor opening at noon, with sharper consequences.",
      beats: [
        { id: "beat_opening", action: "The harbor wakes, harsher.", narration: "A rewritten harbor opening at noon.", dialogue: [] },
        { id: "beat_closing", action: "The film closes.", narration: "The narrator closes the film over the water.", dialogue: [] },
      ],
      canonRevisionIds: [locRev.id, styleRev.id],
    });
    await page.getByTestId("reload-button").click();
    const stale = page.getByTestId("stale-notice").filter({ hasText: "STORY_CHANGED" });
    await stale.first().waitFor();
    const staleText = await stale.first().innerText();
    const pinned = await stale.first().getAttribute("data-pinned");
    const active = await stale.first().getAttribute("data-active");
    check(
      "T08-provenance exact STORY_CHANGED notice names pinned vs active story revisions",
      staleText.includes(storyV1.id) && staleText.includes(storyV2.id) && pinned === storyV1.id && active === storyV2.id,
      staleText.replace(/\s+/g, " ").slice(0, 220),
    );
  } catch (error) {
    check("T08-provenance-stale scenario completed", false, detail(error));
  }
  await screenshot("T08-provenance-stale");

  /* T08-approval-display — decision, actor, checklist summary, exact revision ids; story v2 approved
     through the real server API; no cascade into the plan. */
  try {
    const approvalStates = page.getByTestId("approval-states");
    await approvalStates.waitFor();
    const statesText = await approvalStates.innerText();
    check(
      "T08-approval shot plan and animatic approvals show decision, actor, checklist and exact revision ids",
      statesText.includes(plan.shotPlanRevision.id) && statesText.includes(plan.animaticRevision.id) &&
        /approved/.test(statesText) && /local-creator/.test(statesText) &&
        ["beat_coverage", "canon_bindings", "timing", "continuity"].every((id) => statesText.includes(id)),
      statesText.replace(/\s+/g, " ").slice(0, 240),
    );
    check(
      "T08-approval the active story v2 shows honestly no decision yet (no fake currency)",
      statesText.includes(storyV2.id) && /no human decision recorded/.test(statesText),
    );
    const approvalResponse = await fetch(`${BASE}/api/production/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        projectId,
        idempotencyKey: "verify-story-v2",
        command: {
          targetKind: "story", targetId: storyV2.id, expectedHash: storyV2.contentHash, decision: "approved",
          checklist: STORY_CHECKLIST.map((id) => ({ id, passed: true, note: "verified for v2" })),
          notes: "", advisoryAcknowledgements: [],
        },
      }),
    });
    check("T08-approval server API approves story v2 with the exact displayed revision", approvalResponse.status === 201, `status ${approvalResponse.status}`);
    await page.getByTestId("reload-button").click();
    await page.getByTestId("approval-states").waitFor();
    const afterText = await page.getByTestId("approval-states").innerText();
    check(
      "T08-approval story v2 then renders approved with actor and checklist summary",
      afterText.includes(storyV2.id) && /approved/.test(afterText) && /local-creator/.test(afterText) && /protagonist_goal/.test(afterText),
    );
    const staleAfter = page.getByTestId("stale-notice").filter({ hasText: "STORY_CHANGED" });
    await staleAfter.first().waitFor();
    check(
      "T08-approval no cascade: approving story v2 leaves the plan visibly stale",
      (await staleAfter.count()) >= 1 && (await staleAfter.first().getAttribute("data-pinned")) === storyV1.id,
      `${await staleAfter.count()} STORY_CHANGED notices remain`,
    );
  } catch (error) {
    check("T08-approval-display scenario completed", false, detail(error));
  }
  await screenshot("T08-approval-display");

  /* T08-error-retry (read model): aborted GET -> role=alert, Retry recovers. */
  try {
    await page.goto(shotsUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("shot-row").first().waitFor();
    await page.route("**/api/production/projects/*", async (route) => {
      if (route.request().method() === "GET") { await route.abort("failed"); return; }
      await route.continue();
    });
    await page.getByTestId("reload-button").click();
    const alert = page.getByTestId("shots-page").locator('[role="alert"]').first();
    await alert.waitFor();
    const alertText = await alert.innerText();
    check(
      "T08-error-retry aborted read-model GET renders the role=alert error state",
      /could not be loaded/i.test(alertText) && /NETWORK_ERROR|network/i.test(alertText),
      alertText.replace(/\s+/g, " ").slice(0, 180),
    );
    check("T08-error-retry the error state renders no fabricated shot rows", (await page.getByTestId("shot-row").count()) === 0);
    await page.unroute("**/api/production/projects/*");
    await page.getByRole("button", { name: "Retry" }).click();
    await page.getByTestId("shot-row").first().waitFor();
    const recoveredIds = await page.getByTestId("shot-row").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-shot-id")));
    check("T08-error-retry Retry recovers chunk 1 exactly", recoveredIds.join(",") === PLAN_ORDER.split(",").slice(0, 6).join(",") && (await page.getByTestId("chunk-status").innerText()).includes("Chunk 1 of 2"), recoveredIds.join(","));
  } catch (error) {
    check("T08-error-retry read-model failure scenario completed", false, detail(error));
  }
  await screenshot("T08-error-retry-recovered");

  check("T08-tripwire zero non-local requests for the whole run", externalRequests === 0, `${externalRequests} non-local request(s)`);
} catch (error) {
  check("storyboard verification workflow completed", false, detail(error));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots retained in ${runDir}`);
process.exit(failed.length ? 1 : 0);

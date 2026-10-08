#!/usr/bin/env node
/**
 * Browser verification for the C12 export QC + final-review/download UI (offline/localhost only).
 *
 * Usage: node scripts/verify-production-export.mjs http://127.0.0.1:3100
 *
 * REDUCED BROWSER SET, FROZEN HONESTLY (docs/production/reports/C12-root-freeze.json): no export
 * record can exist over HTTP offline (compileManifest requires selected currently-approved takes;
 * takes exist only via provider job completion and no HTTP route creates them), so this script
 * verifies the honest empty-pipeline state, keyboard-only navigation with loading/error/retry, and
 * the zero-non-local-requests tripwire. The qc_pending/qc_failed/ready_for_review/approved states,
 * the 428/409 gating, and the real download bytes are proven at SERVICE level against real local
 * renders in lib/services/production/qc.test.ts (handler factories with injected stores). The
 * script never seeds exports directly and never fabricates export state.
 *
 * Preconditions: a healthy local production server only — NO ffmpeg requirement (nothing renders
 * in the offline browser path). The script never starts the server and never sends a request
 * beyond the given base URL. Any FAIL or BLOCKED exits 1.
 */
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const runDir = mkdtempSync(join(tmpdir(), "c12-verify-"));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("DISCLOSURE (frozen reduced browser set): exports cannot be created over HTTP offline —");
console.log("no HTTP route creates approved takes, so no manifest/export can be compiled in this run.");
console.log("The browser run proves the empty-pipeline state, a11y/loading/retry, and the offline tripwire only.");

/* Preconditions: server health (the script never starts the dev server; no ffmpeg needed). */
const health = await fetch(`${BASE}/api/production/health`).catch(() => null);
if (!health || !health.ok) {
  console.log(`BLOCKED: no healthy production server at ${BASE}. start: PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> npx next dev -p 3100`);
  process.exit(1);
}
console.log(`run directory: ${runDir}`);

/* Seeding: the same minimal offline chain as C08 — project, story (>=2 beats), story approval. */
async function postJson(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
  return response;
}

const projectResponse = await postJson("/api/production/projects", { name: "Export QC verification", profileId: "storybook-short-v1" });
if (projectResponse.status !== 201) {
  console.log(`BLOCKED: project seed failed with HTTP ${projectResponse.status}: ${await projectResponse.text().catch(() => "")}`);
  process.exit(1);
}
const projectId = (await projectResponse.json()).id;
const storyResponse = await postJson(`/api/production/projects/${projectId}/stories`, {
  projectId,
  expectedStoryRevisionId: null,
  scriptText: "The harbor wakes at dawn and closes over the water.",
  beats: [
    { id: "beat_opening", action: "The harbor wakes.", narration: "The harbor wakes at dawn.", dialogue: [] },
    { id: "beat_closing", action: "The film closes.", narration: "The film closes over the water.", dialogue: [] },
  ],
  canonRevisionIds: [],
});
if (storyResponse.status !== 201) {
  console.log(`BLOCKED: story seed failed with HTTP ${storyResponse.status}: ${await storyResponse.text().catch(() => "")}`);
  process.exit(1);
}
const story = await storyResponse.json();
const STORY_CHECKLIST = ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"];
const approvalResponse = await postJson("/api/production/approvals", {
  projectId,
  idempotencyKey: `c12-verify-story-${story.id}`,
  command: {
    targetKind: "story", targetId: story.id, expectedHash: story.contentHash, decision: "approved",
    checklist: STORY_CHECKLIST.map((id) => ({ id, passed: true, note: "Verified by the C12 browser protocol." })),
    notes: "Seeded approved story for the C12 empty-pipeline browser verification.",
    advisoryAcknowledgements: [],
  },
});
if (approvalResponse.status !== 201 && approvalResponse.status !== 200) {
  console.log(`BLOCKED: story approval seed failed with HTTP ${approvalResponse.status}: ${await approvalResponse.text().catch(() => "")}`);
  process.exit(1);
}
console.log(`seeded project ${projectId} with approved story ${story.id} (exports still impossible offline — disclosure above)`);

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

const exportPageUrl = `${BASE}/production/${projectId}/export`;
const detail = (error) => String(error).replace(/\s+/g, " ").slice(0, 240);

try {
  /* T12-empty — honest empty state naming prerequisites, no download controls, no success badges. */
  await page.goto(exportPageUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("export-page").waitFor();
  const empty = page.getByTestId("export-empty");
  await empty.waitFor();
  const emptyText = await page.getByTestId("export-page").innerText();
  check(
    "T12-empty empty state names the pipeline prerequisites (takes, audio mix, manifest, export, QC)",
    /audio mix/i.test(emptyText) && /manifest/i.test(emptyText) && /take/i.test(emptyText) && /export/i.test(emptyText) && /QC/i.test(emptyText),
    emptyText.replace(/\s+/g, " ").slice(0, 200),
  );
  check(
    "T12-empty no download controls exist for a project without exports",
    (await page.getByTestId("download-final").count()) === 0 &&
      (await page.getByTestId("download-draft").count()) === 0 &&
      (await page.getByTestId("run-qc").count()) === 0,
  );
  check(
    "T12-empty no success badges or Ready-to-upload language for a project without exports",
    (await page.getByTestId("final-badge").count()) === 0 &&
      (await page.getByTestId("draft-badge").count()) === 0 &&
      !/ready to upload/i.test(emptyText) &&
      !/approved/i.test(emptyText.split("Exports appear")[0] ?? ""),
    "no final/draft badge rendered",
  );
  await screenshot("T12-empty");

  /* T12-nav-a11y — keyboard-only navigation, role/label checks, loading/error/retry via aborted GET. */
  const heading = page.getByRole("heading", { level: 1 });
  await heading.waitFor();
  check("T12-nav-a11y the export page exposes a level-1 heading naming the workspace", /export/i.test(await heading.innerText()), await heading.innerText());

  // Force the error state first: abort the read-model GET and reload the page (keyboard-only from here).
  let aborted = 0;
  await page.route(`**/api/production/projects/${projectId}`, async (route) => {
    if (route.request().method() === "GET") {
      aborted += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const alert = page.getByTestId("export-error");
  await alert.waitFor();
  const alertText = await alert.innerText();
  check(
    "T12-nav-a11y aborted read-model GET renders a role=alert error with a retry action",
    aborted >= 1 && /network error|INVALID|UNKNOWN/i.test(alertText),
    alertText.replace(/\s+/g, " ").slice(0, 160),
  );
  check("T12-nav-a11y the error path renders no fabricated export controls or badges", (await page.getByTestId("download-final").count()) === 0 && (await page.getByTestId("export-empty").count()) === 0);
  await screenshot("T12-nav-a11y-error-retry");

  // Keyboard-only recovery: Tab to the retry control and activate it with Enter while still aborting.
  let focusTestid = "";
  for (let tabs = 0; tabs < 20; tabs += 1) {
    await page.keyboard.press("Tab");
    focusTestid = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.testid ?? "" : ""));
    if (focusTestid === "reload") break;
  }
  check("T12-nav-a11y keyboard Tab reaches the Reload retry control without a pointer", focusTestid === "reload", `activeElement testid=${focusTestid}`);
  await page.keyboard.press("Enter");
  const abortedAfterKeyboard = await new Promise((resolve) => {
    const poll = setInterval(() => { if (aborted >= 2) { clearInterval(poll); clearTimeout(failSafe); resolve(aborted); } }, 50);
    const failSafe = setTimeout(() => { clearInterval(poll); resolve(aborted); }, 5_000);
  });
  check("T12-nav-a11y Enter on the focused retry control re-requests the read model (still failing)", abortedAfterKeyboard >= 2, `${abortedAfterKeyboard} aborted GET(s)`);
  await screenshot("T12-nav-a11y-keyboard-retry");

  await page.unroute(`**/api/production/projects/${projectId}`);
  // The failed re-render reset focus to the document body; walk back to Reload keyboard-only.
  for (let tabs = 0; tabs < 20; tabs += 1) {
    await page.keyboard.press("Tab");
    focusTestid = await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.dataset.testid ?? "" : ""));
    if (focusTestid === "reload") break;
  }
  await page.keyboard.press("Enter");
  await page.getByTestId("export-empty").waitFor();
  check("T12-nav-a11y retry after the failure restores the honest empty state", (await page.getByTestId("export-error").count()) === 0);
  await screenshot("T12-nav-a11y-recovered");

  check("T12-tripwire zero non-local requests across the whole session", externalRequests === 0, `${externalRequests} non-local request(s)`);
} catch (error) {
  check("C12 export browser workflow completed", false, detail(error));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots retained in ${runDir}`);
process.exit(failed.length ? 1 : 0);

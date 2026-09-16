/**
 * GUI smoke for the character creation v2 flow (Simple/Detailed modes +
 * in-page character sheet). Run against a dev server:
 *
 *   node scripts/verify-character-sheet.mjs [baseUrl]
 *
 * Renders are mocked at the /api/jobs boundary (instant completions), so no
 * provider key usage. Screenshots land in ./shots.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://127.0.0.1:3322";
const OUT = new URL("../shots/", import.meta.url).pathname;
const PROMPT = "A teal-haired courier with a chrome helmet and a warm grin";

const svg = (hue, label) =>
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640"><rect width="360" height="640" fill="hsl(${hue},60%,70%)"/><text x="180" y="320" font-size="40" text-anchor="middle" fill="#222">${label}</text></svg>`,
  ).toString("base64");

const VIEW_HUES = { front: 200, back: 260, face: 20, chest: 120, hip: 45, butt: 320 };

function installJobMocks(page, state) {
  const wrap = (handler) => async (route) => {
    const url = new URL(route.request().url());
    if (!/\/api\/jobs(\/|$|\?)/.test(url.pathname)) return route.fallback();
    return handler(route, url);
  };
  return page.route(
    /\/api\/jobs/,
    wrap(async (route, url) => {
      if (route.request().method() === "POST") {
        state.postCount += 1;
        const id = `j_mock_${state.postCount}`;
        state.jobs.set(id, {
          id,
          kind: "image",
          status: "completed",
          createdAt: Date.now(),
          finishedAt: Date.now(),
          result: [
            {
              id: `m_${state.postCount}`,
              url: svg(state.postCount * 47, id),
              width: 720,
              height: 1280,
              seed: 1000 + state.postCount,
            },
          ],
        });
        await route.fulfill({ json: { job: { id } } });
        return;
      }
      const id = url.pathname.split("/").pop();
      if (id === "jobs") {
        // The RendersTray active-job poller (lib/job-store) — empty tray.
        await route.fulfill({ json: { jobs: [] } });
        return;
      }
      const job = state.jobs.get(id);
      if (job) {
        await route.fulfill({ json: { job } });
        return;
      }
      await route.fulfill({ status: 404, json: { error: "no such job" } });
    }),
  );
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});

const report = { checks: [], consoleErrors: [], pageErrors: [] };
function check(name, ok, detail = "") {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function newPage(context, state) {
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("favicon")) {
      report.consoleErrors.push(msg.text().slice(0, 200));
    }
  });
  page.on("pageerror", (error) => report.pageErrors.push(String(error).slice(0, 200)));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      report.consoleErrors.push(`${response.status()} ${response.url().slice(0, 200)}`);
    }
  });
  await installJobMocks(page, state);
  // Keep the smoke offline for moderation verdicts.
  await page.route(/\/api\/moderate/, (route) =>
    route.fulfill({ json: { verdict: null } }),
  );
  return page;
}

/* ------------------------- Desktop — Simple mode ------------------------- */
{
  const state = { jobs: new Map(), postCount: 0 };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await newPage(context, state);

  await page.goto(`${BASE}/character/new`, { waitUntil: "networkidle" });

  // Simple is the default mode; the sheet panel is present on desktop.
  const simpleTab = page.getByRole("tab", { name: "Simple" });
  check("simple mode default", await simpleTab.getAttribute("aria-selected") === "true");
  const renderButton = page.getByRole("button", { name: "Render sheet" });
  check("sheet panel visible", await renderButton.isVisible());
  check("render disabled without prompt", await renderButton.isDisabled());

  await page.getByLabel("Character Prompt").fill(PROMPT);
  check("render enabled with prompt", await renderButton.isEnabled());

  await renderButton.click();
  await page.getByText("6 of 6 views rendered").waitFor({ timeout: 60_000 });
  check("all six views rendered in place", state.postCount === 6, `${state.postCount} jobs`);
  await page.screenshot({ path: `${OUT}character-sheet-desktop.png`, fullPage: false });

  // Save cluster
  await page.getByLabel("Character name").fill("Maya");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByText("Saved — attach it from the Character pill in Solo or Story.", { exact: true })
    .waitFor({ timeout: 10_000 });
  check("character saved in page", true);

  await page.getByRole("button", { name: "Save sheet to library" }).click();
  await page.getByRole("button", { name: "Saved to library" }).waitFor({ timeout: 10_000 });
  check("sheet saved to library", true);

  // Per-view re-render chains another job
  const before = state.postCount;
  // Hover a tile to expose actions, then click re-render
  const faceTile = page.locator("div.group", { has: page.getByText("Face", { exact: true }) }).first();
  await faceTile.hover();
  await page.getByRole("button", { name: "Render Face", exact: true }).click();
  await page.waitForTimeout(3000);
  check("per-view re-render fired", state.postCount === before + 1, `${state.postCount}`);

  /* ----------------------- Desktop — Detailed mode ----------------------- */
  await page.getByRole("tab", { name: "Detailed" }).click();
  check("detailed stepper appears", await page.getByRole("list", { name: "Character wizard progress" }).isVisible());
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForTimeout(150);
  }
  const reviewRender = page.getByRole("button", { name: "Render Character Sheet" });
  check("review offers sheet render", await reviewRender.isVisible());
  await reviewRender.click();
  // A fresh batch re-renders all six: wait for it to advance past the front
  // view (poll cadence is 2s, so give it room).
  await page.getByText("Rendering view 2 of 6").waitFor({ timeout: 20_000 });
  check("review triggers a fresh batch", state.postCount >= before + 2, `${state.postCount}`);

  /* ------------------------- Character detail page ------------------------ */
  await page.goto(`${BASE}/character`, { waitUntil: "networkidle" });
  await page.locator('a[aria-label="Open Maya details"]').first().waitFor({ timeout: 15_000 });
  await page.locator('a[aria-label="Open Maya details"]').first().click();
  await page.waitForURL(/\/character\/(?!new)[\w-]+/);
  await page.getByRole("heading", { name: "Maya" }).waitFor({ timeout: 15_000 });
  check("detail page is the card landing", true);
  check("specifications panel", await page.getByText("Specifications").isVisible());
  check("sheet views restored", await page.getByText(/of 6 views/).isVisible());
  check("renders history listed", await page.getByText(/Renders \(\d+\)/).isVisible());
  await page.screenshot({ path: `${OUT}character-detail.png`, fullPage: false });

  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.waitForURL(/\/character\/ch_/);
  await page.getByRole("heading", { name: /Maya \(copy\)/ }).waitFor({ timeout: 15_000 });
  check("copy navigates to the duplicate", true);
  await page.getByRole("link", { name: /Edit/ }).first().click();
  await page.waitForURL(/\/character\/ch_.*\/edit/);
  await page.getByText("Describe your character", { exact: false }).first().waitFor({ timeout: 15_000 });
  check("edit opens the studio for the copy", true);

  await context.close();
}

/* ------------------------------- Mobile --------------------------------- */
{
  const state = { jobs: new Map(), postCount: 0 };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await newPage(context, state);

  await page.goto(`${BASE}/character/new`, { waitUntil: "networkidle" });
  const pill = page.getByRole("button", { name: /Sheet 0\/6/ });
  check("mobile pill launcher", await pill.isVisible());

  await page.getByLabel("Character Prompt").fill(PROMPT);
  await pill.click();
  await page.getByRole("button", { name: "Close", exact: true }).waitFor({ timeout: 5000 });
  check("mobile drawer opens", await page.getByRole("button", { name: "Render sheet" }).isVisible());

  await page.getByRole("button", { name: "Render sheet" }).click();
  await page.getByText("6 of 6 views rendered").waitFor({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}character-sheet-mobile.png`, fullPage: false });

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Sheet 6\/6/ }).waitFor({ timeout: 5000 });
  check("pill reflects completed views", true);

  await context.close();
}

await browser.close();

const failed = report.checks.filter((c) => !c.ok);
console.log(
  `\n${report.checks.length - failed.length}/${report.checks.length} checks passed · ` +
    `${report.consoleErrors.length} console errors · ${report.pageErrors.length} page errors`,
);
if (report.consoleErrors.length) console.log("console errors:", report.consoleErrors);
if (report.pageErrors.length) console.log("page errors:", report.pageErrors);
process.exit(failed.length || report.pageErrors.length ? 1 : 0);

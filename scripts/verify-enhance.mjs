/**
 * Verifies the Enhance-prompt flow end to end in the browser: typing a prompt,
 * clicking Enhance (busy state → enriched text → toast), on both the Solo
 * image generator and the Story composer.
 *
 *   node scripts/verify-enhance.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

// Use the origin the dev server advertises — Next 16 blocks dev resources
// for other spellings (e.g. 127.0.0.1), which silently breaks hydration.
const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = new URL("../gui-test-screenshots/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});

const report = { flows: [], consoleErrors: [] };

async function runFlow(path, clickButtonFirst, shot) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") {
      report.consoleErrors.push({ path, text: m.text().slice(0, 180) });
    }
  });

  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const promptBox = page.locator("#prompt-input");
  await promptBox.fill("a quiet harbor with fishing boats");

  const enhance = page.getByRole("button", { name: /enhance/i });
  // Wait for React to own the textarea: the button enables once the prompt
  // state is live. If a fill raced hydration, retype character by character.
  const enabled = await enhance
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /enhance/i.test(b.textContent ?? ""),
        );
        return btn && !btn.disabled;
      },
      { timeout: 5_000 },
    ))
    .then(() => true)
    .catch(() => false);
  if (!enabled) {
    await promptBox.fill("");
    await promptBox.pressSequentially("a quiet harbor with fishing boats", { delay: 12 });
    await enhance.waitFor({ state: "visible", timeout: 3_000 });
    await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /enhance/i.test(b.textContent ?? ""),
        );
        return btn && !btn.disabled;
      },
      { timeout: 8_000 },
    );
  }

  if (clickButtonFirst) {
    // The button must be disabled while the textarea is empty.
    await promptBox.fill("");
    const disabledWhileEmpty = await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /enhance/i.test(b.textContent ?? ""),
        );
        return btn?.disabled === true;
      },
      { timeout: 5_000 },
    ).then(() => true).catch(() => false);
    await promptBox.fill("a quiet harbor with fishing boats");
    await page.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /enhance/i.test(b.textContent ?? ""),
        );
        return btn && !btn.disabled;
      },
      { timeout: 5_000 },
    );
    if (!disabledWhileEmpty) {
      report.flows.push({ path, ok: false, reason: "enhance enabled on empty prompt" });
      await context.close();
      return;
    }
  }

  await enhance.click();
  const busyShown = await page
    .getByText(/enhancing/i)
    .first()
    .isVisible()
    .catch(() => false);

  // The service answers within ~12s (AI) or near-instantly (fallback).
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#prompt-input");
      return el && el.value.includes(",") && el.value.length > 40;
    },
    { timeout: 20_000 },
  );
  const enhanced = await promptBox.inputValue();
  const toast = await page
    .getByText(/prompt (enhanced|enriched)/i)
    .first()
    .isVisible()
    .catch(() => false);

  await page.screenshot({ path: `${OUT}${shot}`, fullPage: false });
  report.flows.push({
    path,
    ok: enhanced.length > 40 && toast,
    busyShown,
    enhanced: enhanced.slice(0, 140),
    toast,
  });
  await context.close();
}

await runFlow("/generate/image", true, "enhance-image.png");
await runFlow("/generate/video", false, "enhance-video.png");
await runFlow("/story", false, "enhance-story.png");

await browser.close();
console.log(JSON.stringify(report, null, 2));

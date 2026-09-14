/**
 * Verifies the character wizard's Appearance step: the whole-year age slider,
 * and the Ethnicity / Country selects — including the values echoed on the
 * Review step.
 *
 *   node scripts/verify-character-config.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = new URL("../shots/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const p = await context.newPage();
const consoleErrors = [];
p.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 180));
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  // Landing → wizard step 1
  await p.goto(`${BASE}/character`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Get Started" }).click();
  await p.getByLabel("Character Prompt").fill(
    "A confident woman in a red dress standing on a rooftop at dusk.",
  );
  await p.getByRole("button", { name: "Next", exact: true }).click();

  // Step 2 — Appearance
  const slider = p.locator("#character-age");
  await slider.waitFor({ state: "visible", timeout: 15000 });

  const attrs = await slider.evaluate((el) => ({
    min: el.min,
    max: el.max,
    step: el.step,
    value: el.value,
  }));
  check("slider spans adult whole years", attrs.min === "18" && attrs.max === "80" && attrs.step === "1", JSON.stringify(attrs));
  check("default age is 25", attrs.value === "25");

  const valueText = await p.locator('label[for="character-age"] + span').textContent();
  check("value label reads years old", valueText === "25 years old", valueText ?? "");

  await slider.fill("34");
  const midText = await p.locator('label[for="character-age"] + span').textContent();
  const midHint = await p.locator("#character-age ~ p").last().textContent();
  check("slider steps to 34", midText === "34 years old", midText ?? "");
  check("bucket hint updates", midHint === "Adult (25–39)", midHint ?? "");

  await slider.fill("70");
  const seniorHint = await p.locator("#character-age ~ p").last().textContent();
  check("bucket hint reaches Senior", seniorHint === "Senior (60+)", seniorHint ?? "");
  await slider.fill("34");

  await p.getByLabel("Ethnicity").selectOption("South Asian");
  await p.getByLabel("Country").selectOption("Bangladesh");
  check("ethnicity select set", (await p.getByLabel("Ethnicity").inputValue()) === "South Asian");
  check("country select set", (await p.getByLabel("Country").inputValue()) === "Bangladesh");

  await p.screenshot({ path: `${OUT}character-appearance.png` });

  // Step 3 → Step 4 — Review echoes the values
  await p.getByRole("button", { name: "Next", exact: true }).click();
  await p.getByRole("button", { name: "Next", exact: true }).click();
  const review = p.locator("section", { hasText: "Appearance" }).first();
  await review.waitFor({ state: "visible", timeout: 15000 });
  const reviewText = await review.textContent();
  check("review shows exact age", reviewText.includes("34 years old"));
  check("review shows ethnicity", reviewText.includes("South Asian"));
  check("review shows country", reviewText.includes("Bangladesh"));

  await p.screenshot({ path: `${OUT}character-review.png` });
} catch (error) {
  check("script completed", false, String(error).slice(0, 300));
}

check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

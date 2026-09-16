/* eslint-disable */
/**
 * GUI smoke for feature/multi-character-loras (dev server on :3100).
 * Black-box via the real UI; every /api/generate call is intercepted, so no
 * real render is spent. Asserts:
 *   1. Solo: cast picker multi-select + chips + cap, LoRA pill on krea2,
 *      request body carries LoRA selections + composed multi-character prompt.
 *   2. Story: seeded cast of 2 → runner prompt has labeled anchors.
 *   3. Character studio: LoRA row on Review for krea2, toggle works, and the
 *      generate body carries the selection (the previously-dead path).
 */
const { chromium } = require("playwright");

const BASE = "http://localhost:3100";
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// addInitScript serializes the function body alone — no outer-scope closure —
// so every constant it needs lives inside it.
function seedStorage() {
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const characters = ["Maya", "Ines", "Rosa"].map((name, i) => ({
    id: "ch_" + name.toLowerCase(),
    name,
    thumbnail: pixel,
    spec: {
      prompt: `A test character ${name}`,
      style: "Realistic",
      gender: "Female",
      age: 25,
      ethnicity: "Not specified",
      country: "Not specified",
      skinTone: "medium",
      faceShape: "Oval",
      facialFeatures: "Natural",
      expression: "Neutral",
      hairColor: "Black",
      hairStyle: "Braided",
      eyeColor: "Brown",
      eyeShape: "Almond",
      outfit: "Casual",
      accessories: "None",
      build: "Average",
      bodyDetails: "Normal proportions",
      tattoos: false,
      piercings: false,
      facialHair: false,
      personality: "",
      nsfwLevel: 0,
      look: "",
    },
    createdAt: i,
    updatedAt: i,
  }));
  window.localStorage.setItem("perabyte.characters.v1", JSON.stringify(characters));
  window.localStorage.setItem(
    "perabyte.settings.v1",
    JSON.stringify({
      imageModel: "sogni:krea2_turbo_fp8_scaled",
      soloCharacterIds: ["ch_maya"],
      storyCharacterIds: ["ch_maya", "ch_ines"],
    }),
  );
}

/** Fulfills /api/generate with a fake NDJSON result; returns captured bodies. */
function interceptGenerate(captured) {
  const ndjson = (obj) => JSON.stringify(obj) + "\n";
  return async (route) => {
    const req = route.request();
    captured.push(JSON.parse(req.postData()));
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
      body:
        ndjson({ type: "progress", stage: "rendering", message: "smoke 10%", percent: 10 }) +
        ndjson({
          type: "result",
          requestId: "smoke_" + captured.length,
          status: "completed",
          kind: "image",
          elapsedMs: 5,
          media: [
            { id: "m1", url: PIXEL, width: 8, height: 8, seed: 1, mime: "image/png" },
          ],
        }),
    });
  };
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(seedStorage);
  const page = await context.newPage();
  const captured = [];
  await page.route("**/api/generate", interceptGenerate(captured));
  const fails = [];
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : " — " + detail}`);
    if (!cond) fails.push(name);
  };

  /* ------------------------------- Solo ------------------------------- */
  await page.goto(BASE + "/generate/image", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label="Character cast"]');

  const castPill = page.locator('button[aria-label="Character cast"]');
  check("solo: cast pill shows count 1", (await castPill.textContent()).includes("1"));
  check(
    "solo: attached chip shows Maya",
    await page.locator("text=Maya").first().isVisible(),
  );
  check(
    "solo: chip copy present",
    await page.getByText("look and outfit added automatically").isVisible(),
  );

  await castPill.click();
  await page.getByRole("checkbox", { name: "Ines" }).click();
  await page.getByRole("checkbox", { name: "Rosa" }).click();
  check(
    "solo: cap warning at 3 characters",
    await page.getByText(/Cap reached/).isVisible(),
  );
  check(
    "solo: popover counter 3/3",
    (await page.getByText("3/3").isVisible()) === true,
  );
  await page.keyboard.press("Escape");

  // LoRA on krea2 — toggle the first adapter entry in the popover.
  await page.locator('button[aria-label="LoRA adapters"]').click();
  const loraRow = page.locator("div.order-last button[aria-pressed]").first();
  await loraRow.click();
  await page.waitForTimeout(200);
  check("solo: lora row exposes strength slider", await page.locator("div.order-last input[type=range]").first().isVisible());
  // Close the popover before clicking Generate — an open popover shifts the
  // layout as it collapses and steals the click.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  await page
    .locator("#prompt-input")
    .fill("dancing at a rooftop party");
  await page.getByRole("button", { name: "Generate", exact: false }).first().click();
  await page.waitForTimeout(800);
  const soloBody = captured[0] || {};
  check(
    "solo: request body has loras (the fix)",
    Array.isArray(soloBody.loras) && soloBody.loras.length === 1,
    JSON.stringify(soloBody.loras),
  );
  check(
    "solo: prompt leads with labeled three-character anchors",
    /^Scene with three characters\. First: an adult .* Second: an adult .* Third: an adult .*/.test(
      soloBody.prompt || "",
    ),
    soloBody.prompt,
  );
  check(
    "solo: scene text trails the anchors",
    (soloBody.prompt || "").endsWith("dancing at a rooftop party"),
  );

  // Detach from the chip row and re-generate.
  await page.locator('button[aria-label="Detach Rosa"]').click();
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "Generate", exact: false }).first().click();
  await page.waitForTimeout(600);
  check(
    "solo: detach drops the third anchor",
    /^Scene with two characters\./.test((captured[1] || {}).prompt || ""),
    (captured[1] || {}).prompt,
  );

  /* ------------------------------- Story ------------------------------ */
  await page.goto(BASE + "/story", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[aria-label="Character cast"]');
  const storyPill = page.locator('button[aria-label="Character cast"]');
  check("story: cast pill shows count 2", (await storyPill.textContent()).includes("2"));

  await page.locator("#prompt-input").fill("a quiet lakeside morning");
  await page.getByRole("button", { name: "Generate", exact: false }).first().click();
  await page.waitForTimeout(1200);
  check(
    "story: runner prompt carries two labeled anchors",
    /^Scene with two characters\. First: an adult .* Second: an adult .*a quiet lakeside morning$/.test(
      (captured[2] || {}).prompt || "",
    ),
    (captured[2] || {}).prompt,
  );

  /* ---------------------------- Character ----------------------------- */
  await page.goto(BASE + "/character", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator('button[title="Open Maya"]').click();
  await page.getByRole("button", { name: "Next", exact: true }).click(); // step 1 → 2
  await page.getByRole("button", { name: "Next", exact: true }).click(); // step 2 → 3
  await page.getByRole("button", { name: "Next", exact: true }).click(); // step 3 → 4
  const loraRowChar = page.locator('button[aria-label="LoRA adapters"]');
  await loraRowChar.waitFor({ timeout: 5000 });
  check("character: LoRA row renders for krea2", await loraRowChar.isVisible());

  await loraRowChar.click();
  await page.locator("div.order-last button[aria-pressed]").first().click();
  check(
    "character: selection count badge shows 1",
    (await loraRowChar.textContent()).includes("1"),
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Generate" }).first().click();
  await page.waitForTimeout(800);
  const charBody = captured[3] || {};
  check(
    "character: generate body carries loras (the new path)",
    Array.isArray(charBody.loras) && charBody.loras.length === 1,
    JSON.stringify(charBody.loras),
  );
  check(
    "character: prompt is the composed character prompt",
    (charBody.prompt || "").includes("A test character Maya"),
    charBody.prompt,
  );
  check(
    "character: safe render (gate off)",
    charBody.safe === true && charBody.enhance === true,
  );

  await browser.close();
  console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nALL SMOKE CHECKS PASSED");
  process.exit(fails.length ? 1 : 0);
}

main().catch((error) => {
  console.error("SMOKE CRASHED:", error);
  process.exit(1);
});

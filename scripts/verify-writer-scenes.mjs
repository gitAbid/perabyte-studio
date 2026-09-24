/**
 * Browser verification for Writer's cast-aware, review-before-save scene flow.
 *
 * Usage: node scripts/verify-writer-scenes.mjs http://127.0.0.1:3100
 */
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

const ada = {
  id: "ch_ada",
  name: "Ada",
  spec: {},
  createdAt: 1,
  updatedAt: 1,
};
const outline = [
  "Ada studies the comet through an antique observatory telescope, cinematic moonlight.",
  "Ada deciphers a constellation map across the desk, intimate lamplight.",
  "Ada climbs the observatory stairs as the dome opens, dramatic wide shot.",
  "Ada faces the bright comet above the city, windswept rooftop portrait.",
  "Ada records the discovery at dawn, hopeful final frame.",
];
const writerRequests = [];
const savedAssets = [];
let holdNextSplit = false;
let releaseHeldSplit;
let failNextAssetSave = false;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10_000);

await page.route("**/api/assets", async (route) => {
  if (route.request().method() === "GET") {
    await route.fulfill({ json: { assets: [] } });
    return;
  }
  if (route.request().method() === "POST") {
    const asset = route.request().postDataJSON();
    if (failNextAssetSave) {
      failNextAssetSave = false;
      await route.fulfill({ status: 500, json: { error: "mock save failed" } });
      return;
    }
    savedAssets.push(asset);
    await route.fulfill({ json: { asset: savedAssets.at(-1) } });
    return;
  }
  await route.fallback();
});
await page.route("**/api/stories/**", async (route) => {
  const story = savedAssets.at(-1);
  if (!story) {
    await route.fulfill({ status: 404, json: { error: "Story not found." } });
    return;
  }
  await route.fulfill({ json: { story, jobs: [] } });
});
await page.route("**/api/characters", (route) => route.fulfill({ json: { characters: [ada] } }));
await page.route("**/api/locations", (route) => route.fulfill({ json: { locations: [] } }));
await page.route("**/api/settings", (route) => route.fulfill({
  json: { providers: [], tasks: { writer: null }, promptMaxChars: 5000 },
}));
await page.route("**/api/writer", async (route) => {
  const request = route.request().postDataJSON();
  writerRequests.push(request);
  if (request.action === "write") {
    await route.fulfill({ json: {
      text: "Ada follows a comet to the old observatory and discovers a message in the stars.",
      model: "mock-writer",
      provider: "mock",
    } });
    return;
  }
  if (request.action === "split") {
    if (holdNextSplit) {
      holdNextSplit = false;
      await new Promise((resolve) => { releaseHeldSplit = resolve; });
    }
    await route.fulfill({ json: {
      title: "Ada and the comet",
      scenes: outline,
      model: "mock-writer",
      provider: "mock",
    } });
    return;
  }
  await route.fulfill({ status: 400, json: { error: "Unexpected writer action" } });
});

try {
  await page.goto(`${BASE}/writer`, { waitUntil: "domcontentloaded" });
  const sceneCount = page.getByRole("button", { name: /^Scene count:/ });
  await sceneCount.waitFor();
  check("Smart is selected for a new draft", await sceneCount.getAttribute("aria-label") === "Scene count: Smart");

  await sceneCount.click();
  const countOptions = await page.getByRole("listbox", { name: "Scene count" }).getByRole("option").allInnerTexts();
  check(
    "scene count offers Smart, 3, 5, 8, and 12",
    JSON.stringify(countOptions) === JSON.stringify(["Smart", "3 scenes", "5 scenes", "8 scenes", "12 scenes"]),
    countOptions.join(", "),
  );
  await page.getByRole("option", { name: "Smart", exact: true }).click();

  await page.getByRole("button", { name: "Character cast" }).click();
  await page.getByRole("checkbox", { name: "Ada" }).click();
  check(
    "selected Ada is visible in Available cast",
    await visible(page.getByText("Available cast", { exact: true })) && await visible(page.getByText("Ada", { exact: true }).last()),
  );

  await page.locator("#writer-idea").fill("Ada follows a comet to an old observatory.");
  await page.getByRole("button", { name: "Write the story", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("#writer-draft")?.value ===
      "Ada follows a comet to the old observatory and discovers a message in the stars.",
  );
  const write = writerRequests.find((request) => request.action === "write");
  check(
    "write sends Smart mode and Ada's display name",
    write?.brief?.sceneCount === "smart" && JSON.stringify(write?.brief?.characterNames) === JSON.stringify(["Ada"]),
    JSON.stringify(write?.brief ?? {}),
  );

  await page.getByRole("button", { name: /^Scene count:/ }).click();
  await page.getByRole("option", { name: "5 scenes", exact: true }).click();
  await page.getByRole("button", { name: "Generate outline", exact: true }).click();
  await page.getByText("Ada studies the comet through an antique observatory telescope, cinematic moonlight.", { exact: true }).waitFor();
  const split = writerRequests.find((request) => request.action === "split");
  check(
    "outline request carries count, cast, kind, and draft",
    split?.sceneCount === 5 &&
      JSON.stringify(split?.characterNames) === JSON.stringify(["Ada"]) &&
      split?.kind === "image" &&
      split?.uncensored === false &&
      split?.modelId === undefined &&
      split?.draft === "Ada follows a comet to the old observatory and discovers a message in the stars.",
    JSON.stringify(split ?? {}),
  );
  check(
    "returned prompts appear as numbered scene cards",
    (await page.getByText("Scene 01", { exact: true }).count()) === 1 &&
      (await page.getByText("Scene 05", { exact: true }).count()) === 1 &&
      await visible(page.getByText(outline[4], { exact: true })),
  );
  check("outline remains available for review in Writer", new URL(page.url()).pathname === "/writer");

  holdNextSplit = true;
  await page.getByRole("button", { name: "Generate outline", exact: true }).click();
  const splitDeadline = Date.now() + 10_000;
  while (!releaseHeldSplit && Date.now() < splitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!releaseHeldSplit) throw new Error("Timed out waiting for the held split request.");
  const draftInput = page.locator("#writer-draft");
  const originalDraft = await draftInput.inputValue();
  await draftInput.fill("A changed story draft.");
  await draftInput.fill(originalDraft);
  releaseHeldSplit();
  releaseHeldSplit = undefined;
  await page.getByRole("button", { name: "Generate outline", exact: true }).waitFor();
  check(
    "late split response cannot revive a stale outline after inputs change",
    !(await visible(page.getByText(outline[0], { exact: true }))) &&
      await page.getByRole("button", { name: "Create story", exact: true }).isDisabled(),
  );

  await page.getByRole("button", { name: "Generate outline", exact: true }).click();
  await page.getByText(outline[0], { exact: true }).waitFor();
  await page.getByRole("button", { name: /^Open first scene/ }).click();
  await page.waitForURL((url) => url.pathname === "/generate/image");
  check(
    "Use in Solo opens the first reviewed visual prompt",
    new URL(page.url()).searchParams.get("prompt") === outline[0],
  );
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/writer");
  await page.locator("#writer-draft").fill(originalDraft);
  if (!(await visible(page.getByText("Available cast", { exact: true })))) {
    await page.getByRole("button", { name: "Character cast" }).click();
    await page.getByRole("checkbox", { name: "Ada" }).click();
  }
  if (await page.getByRole("button", { name: "Create story", exact: true }).isDisabled()) {
    await page.getByRole("button", { name: "Generate outline", exact: true }).click();
    await page.getByText(outline[0], { exact: true }).waitFor();
  }

  failNextAssetSave = true;
  await page.getByRole("button", { name: "Create story", exact: true }).click();
  await page.getByRole("alert").getByText("We could not save the story. Your draft and outline are still here.", { exact: true }).waitFor();
  check(
    "failed save keeps the draft and reviewed outline available for retry",
    new URL(page.url()).pathname === "/writer" &&
      (await page.locator("#writer-draft").inputValue()) === originalDraft &&
      await visible(page.getByText(outline[0], { exact: true })) &&
      !(await page.getByRole("button", { name: "Create story", exact: true }).isDisabled()),
  );

  await page.getByRole("button", { name: "Create story", exact: true }).click();
  await page.waitForURL(`${BASE}/story?id=*`);
  const saved = savedAssets.at(-1);
  check(
    "Create story saves the reviewed prompts and character id",
    JSON.stringify(saved?.scenes?.map((scene) => scene.prompt)) === JSON.stringify(outline) &&
      JSON.stringify(saved?.meta?.characterIds) === JSON.stringify(["ch_ada"]),
    JSON.stringify(saved?.meta ?? {}),
  );
  check(
    "Create story navigates to Story Mode",
    new URL(page.url()).pathname === "/story" && Boolean(new URL(page.url()).searchParams.get("id")),
  );
} catch (error) {
  check("writer workflow completed", false, String(error).replace(/\s+/g, " ").slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

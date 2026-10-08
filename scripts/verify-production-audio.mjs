#!/usr/bin/env node
/**
 * Browser verification for the C10 audio cue UI (offline/localhost only).
 *
 * Usage: node scripts/verify-production-audio.mjs http://127.0.0.1:3100
 *
 * Fail-closed preconditions: ffmpeg/ffprobe must be runnable (fixtures are decoded by the import
 * route through the vault) and the dev server must already be healthy — this script never starts
 * the server and never sends a request beyond the given base URL. Any FAIL or BLOCKED exits 1.
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const runDir = mkdtempSync(join(tmpdir(), "c10-pre-verify-"));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* Preconditions: media toolchain (fail-closed, before any scenario). */
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH ?? "ffprobe";
for (const [label, command] of [["ffmpeg", ffmpegPath], ["ffprobe", ffprobePath]]) {
  const probe = spawnSync(command, ["-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    console.log(`BLOCKED: ffmpeg/ffprobe are required to verify the audio workflow (${label} is not runnable: ${probe.error?.message ?? `exit code ${probe.status}`}). Install ffmpeg or point FFMPEG_PATH/FFPROBE_PATH at it, then rerun.`);
    process.exit(1);
  }
}
console.log(`run directory: ${runDir}`);

/* Preconditions: server health (the script never starts the dev server). */
const health = await fetch(`${BASE}/api/production/health`).catch(() => null);
if (!health || !health.ok) {
  console.log(`BLOCKED: no healthy production server at ${BASE}. start: PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> npx next dev -p 3100`);
  process.exit(1);
}

/* Fixtures: a pure-Buffer 48 kHz stereo 16-bit PCM WAV and an ASCII file wearing a .wav name. */
function buildWav({ sampleRate = 48_000, channels = 2, seconds = 1, frequency = 440 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "latin1");
  buffer.write("fmt ", 12, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 12_000);
    for (let channel = 0; channel < channels; channel += 1) buffer.writeInt16LE(value, 44 + (frame * channels + channel) * 2);
  }
  return buffer;
}
const validWav = join(runDir, "tone-48k-stereo.wav");
writeFileSync(validWav, buildWav({}));
const invalidWav = join(runDir, "not-audio.wav");
writeFileSync(invalidWav, Buffer.from("these ascii bytes are definitively not audio", "utf8"));
const decodeProbe = spawnSync(ffprobePath, ["-v", "error", "-show_entries", "stream=sample_rate,channels,codec_name", "-of", "csv=p=0", validWav], { encoding: "utf8" });
if (decodeProbe.status !== 0 || !/pcm_s16le/.test(decodeProbe.stdout) || !/48000/.test(decodeProbe.stdout)) {
  console.log(`BLOCKED: the generated WAV fixture is not decodable by ffprobe (${decodeProbe.stderr.trim() || decodeProbe.stdout.trim()}); refusing to fake a pass.`);
  process.exit(1);
}

/* Seeding: projects and stories through the accepted HTTP routes only. */
async function postJson(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
  return response;
}

const projectResponse = await postJson("/api/production/projects", { name: "Audio UI verification", profileId: "storybook-short-v1" });
if (projectResponse.status !== 201) {
  console.log(`BLOCKED: project seed failed with HTTP ${projectResponse.status}: ${await projectResponse.text().catch(() => "")}`);
  process.exit(1);
}
const projectId = (await projectResponse.json()).id;
const NARRATION_V1 = "The narrator opens the film on a quiet harbor at dawn.";
async function seedStory(narration, parentStoryRevisionId = null) {
  const response = await postJson(`/api/production/projects/${projectId}/stories`, {
    projectId,
    expectedStoryRevisionId: parentStoryRevisionId,
    scriptText: narration,
    beats: [
      { id: "beat_opening", action: "The harbor wakes.", narration, dialogue: [] },
      { id: "beat_closing", action: "The film closes.", narration: "The narrator closes the film over the water.", dialogue: [] },
    ],
    canonRevisionIds: [],
  });
  if (response.status !== 201) throw new Error(`story seed failed with HTTP ${response.status}: ${await response.text().catch(() => "")}`);
  return (await response.json()).id;
}
const storyV1 = await seedStory(NARRATION_V1);
console.log(`seeded project ${projectId} with story revision ${storyV1}`);

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

const audioPageUrl = `${BASE}/production/${projectId}/audio`;
const detail = (error) => String(error).replace(/\s+/g, " ").slice(0, 240);

try {
  /* T10-01 — offline upload-ready through the real form. */
  await page.goto(audioPageUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("audio-page").waitFor();
  await page.getByRole("heading", { name: "Import audio" }).waitFor();
  check("T10-01 audio page opens with the cue editor for an active script", true);

  await page.locator("#audio-file").setInputFiles(validWav);
  await page.locator("#audio-source").fill("Local studio session");
  await page.locator("#audio-rights-attestation").fill("Recorded by the creator this session.");
  await page.locator("#audio-rights-status").selectOption("creator_attested");
  await page.getByRole("button", { name: "Import audio file" }).click();
  try {
    const card = page.getByTestId("asset-card").first();
    await card.waitFor();
    const cardText = await card.innerText();
    const sha = await card.getAttribute("data-sha256");
    check(
      "T10-01 uploaded asset card shows rights, source, attestation, sha256 and sample facts",
      /creator attested/.test(cardText) &&
        /Local studio session/.test(cardText) &&
        /Recorded by the creator this session\./.test(cardText) &&
        /^[0-9a-f]{64}$/.test(sha ?? "") &&
        /48,000/.test(cardText) &&
        /1\.000s/.test(cardText),
      cardText.replace(/\s+/g, " ").slice(0, 140),
    );
  } catch (error) {
    check("T10-01 uploaded asset card shows rights, source, attestation, sha256 and sample facts", false, detail(error));
  }
  await screenshot("T10-01-upload-ready");
  check("T10-01 upload workflow stayed on the local host", externalRequests === 0, `${externalRequests} non-local request(s)`);

  /* T10-02 — preview and seek on the in-session upload. */
  try {
    await page.getByRole("button", { name: "Play preview" }).waitFor();
    await page.getByRole("button", { name: "Play preview" }).click();
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="preview-element"]');
      return element instanceof HTMLAudioElement && (!element.paused || element.ended);
    });
    const playedState = await page.locator('[data-testid="preview-time"]').getAttribute("data-preview-state");
    check("T10-02 play reaches a playing (or fully played) state", playedState === "playing" || playedState === "paused", `state=${playedState}`);
    await page.getByTestId("seek").evaluate((element) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(element, "48000");
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const currentTime = await page.locator('[data-testid="preview-element"]').evaluate((element) => (element instanceof HTMLAudioElement ? element.currentTime : -1));
    const label = (await page.getByTestId("preview-time").innerText()).trim();
    check("T10-02 seek advances currentTime within bounds with the integer sample label", currentTime >= 0.9 && currentTime <= 1.0 && label === "1.000s", `currentTime=${currentTime} label=${label}`);
  } catch (error) {
    check("T10-02 play reaches a playing (or fully played) state", false, detail(error));
    check("T10-02 seek advances currentTime within bounds with the integer sample label", false, detail(error));
  }
  await screenshot("T10-02-preview-seek");

  /* T10-03 — place narration + music cues, trim/gain, save, idempotent re-save, reload restore. */
  try {
    await page.locator("#new-cue-role").selectOption("narration");
    await page.locator("#new-cue-beat").selectOption("beat_opening");
    await page.getByRole("button", { name: "Add cue" }).click();
    await page.locator("#new-cue-role").selectOption("music");
    await page.getByRole("button", { name: "Add cue" }).click();
    const draftRows = page.getByTestId("cue-row");
    check("T10-03 narration and music cue drafts are placed", (await draftRows.count()) === 2, `${await draftRows.count()} drafts`);
    const narrationText = await draftRows.nth(0).getByTestId("source-text").inputValue();
    check("T10-03 narration cue auto-fills the beat narration byte-exactly", narrationText === NARRATION_V1, JSON.stringify(narrationText.slice(0, 80)));

    const musicRow = draftRows.nth(1);
    await musicRow.getByTestId("source-end").fill("24000");
    await musicRow.getByTestId("timeline-start").fill("48000");
    await musicRow.getByTestId("gain").fill("-3");
    const save = page.getByRole("button", { name: "Save audio mix" });
    await save.isEnabled() || (() => { throw new Error("Save stayed disabled for valid drafts"); })();
    await save.click();
    const banner = page.locator('[data-testid="save-banner"][data-created="true"]');
    await banner.waitFor();
    const bannerText = await banner.innerText();
    const revisionId = bannerText.match(/audio-mix-[A-Za-z0-9_.:-]+/)?.[0] ?? "";
    check("T10-03 save creates an active mix revision named in the banner", /^audio-mix-[A-Za-z0-9_.:-]+$/.test(revisionId), bannerText.replace(/\s+/g, " ").slice(0, 160));

    await save.click();
    await page.locator('[data-testid="save-banner"][data-created="false"]').waitFor();
    check("T10-03 idempotent re-save reports no duplicate revision", (await page.getByTestId("timeline-row").count()) === 2, `${await page.getByTestId("timeline-row").count()} timeline rows`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("timeline-row").first().waitFor();
    const restoredText = await page.getByTestId("audio-page").innerText();
    check(
      "T10-03 reload restores cues and totalEndSample from the read model",
      (await page.getByTestId("timeline-row").count()) === 2 &&
        /72,000 samples \(1\.500s\)/.test(restoredText) &&
        restoredText.includes("beat_opening") &&
        /creator attested/.test(restoredText),
      `rows=${await page.getByTestId("timeline-row").count()}`,
    );
  } catch (error) {
    check("T10-03 narration cue auto-fills the beat narration byte-exactly", false, detail(error));
    check("T10-03 save creates an active mix revision named in the banner", false, detail(error));
    check("T10-03 idempotent re-save reports no duplicate revision", false, detail(error));
    check("T10-03 reload restores cues and totalEndSample from the read model", false, detail(error));
  }
  await screenshot("T10-03-saved-mix");

  /* Session restore: re-importing the same bytes re-activates the same content-derived asset. */
  try {
    await page.locator("#audio-file").setInputFiles(validWav);
    await page.locator("#audio-source").fill("Local studio session");
    await page.locator("#audio-rights-attestation").fill("Recorded by the creator this session.");
    await page.getByRole("button", { name: "Import audio file" }).click();
    await page.locator('[data-testid="upload-ready"]').waitFor();
    check("T10-03 re-importing identical bytes restores the in-session preview", /in session/i.test(await page.getByTestId("asset-card").first().innerText()));
  } catch (error) {
    check("T10-03 re-importing identical bytes restores the in-session preview", false, detail(error));
  }

  /* T10-04 — narration alignment against the exact beat text. */
  const save = page.getByRole("button", { name: "Save audio mix" });
  try {
    check("T10-04 byte-exact narration shows no alignment issues and Save is enabled", !(await save.isDisabled()) && (await page.getByTestId("save-issues").count()) === 0);
    const narrationRow = page.getByTestId("cue-row").first();
    const textInput = narrationRow.getByTestId("source-text");
    const originalText = await textInput.inputValue();
    await textInput.fill(`${originalText}!`);
    await page.getByTestId("save-issues").waitFor();
    const issueText = await page.getByTestId("save-issues").innerText();
    check("T10-04 one-character drift surfaces an ALIGNMENT issue and disables Save", /ALIGNMENT/.test(issueText) && (await save.isDisabled()), issueText.replace(/\s+/g, " ").slice(0, 180));
    await narrationRow.locator("select").first().selectOption("beat_opening");
    await page.getByTestId("save-issues").waitFor({ state: "detached" });
    check("T10-04 rebinding the beat restores the exact text and re-enables Save", !(await save.isDisabled()));
  } catch (error) {
    check("T10-04 byte-exact narration shows no alignment issues and Save is enabled", false, detail(error));
    check("T10-04 one-character drift surfaces an ALIGNMENT issue and disables Save", false, detail(error));
    check("T10-04 rebinding the beat restores the exact text and re-enables Save", false, detail(error));
  }

  /* T10-06 — actionable overflow beyond the asset's decoded samples. */
  try {
    const musicRow = page.getByTestId("cue-row").nth(1);
    await musicRow.getByTestId("source-end").fill("96000");
    await page.getByTestId("save-issues").waitFor();
    const issueText = await page.getByTestId("save-issues").innerText();
    check(
      "T10-06 source overflow names the cue, both sample counts and both seconds; Save disabled",
      /SOURCE_RANGE/.test(issueText) &&
        issueText.includes("96000") && issueText.includes("48000") &&
        issueText.includes("2.000s") && issueText.includes("1.000s") &&
        (await save.isDisabled()),
      issueText.replace(/\s+/g, " ").slice(0, 220),
    );
    check("T10-06 no animatic overflow tier is claimed without an animatic", !/animatic length/.test(issueText));
    await musicRow.getByTestId("source-end").fill("24000");
    await page.getByTestId("save-issues").waitFor({ state: "detached" });
  } catch (error) {
    check("T10-06 source overflow names the cue, both sample counts and both seconds; Save disabled", false, detail(error));
  }
  await screenshot("T10-06-overflow");

  /* T10-05 — a second story revision makes the pinned mix visibly stale. */
  try {
    const storyV2 = await seedStory("A rewritten harbor opening at noon.", storyV1);
    await page.getByRole("button", { name: "Reload" }).click();
    const stale = page.getByTestId("stale-region");
    await stale.waitFor();
    const staleText = await stale.innerText();
    check(
      "T10-05 stale narration names the pinned and active story revisions",
      /MIX_STORY_PINNED/.test(staleText) && staleText.includes(storyV1) && staleText.includes(storyV2),
      staleText.replace(/\s+/g, " ").slice(0, 260),
    );
    await screenshot("T10-05-stale-narration");
  } catch (error) {
    check("T10-05 stale narration names the pinned and active story revisions", false, detail(error));
  }

  /* T10-noBlankSuccess — failed upload and forced network failure never render success. */
  try {
    await page.locator("#audio-file").setInputFiles(invalidWav);
    await page.locator("#audio-source").fill("Broken fixture upload");
    await page.locator("#audio-rights-attestation").fill("Intentionally invalid fixture for the failure path.");
    await page.locator("#audio-rights-status").selectOption("licensed");
    await page.getByRole("button", { name: "Import audio file" }).click();
    await page.getByTestId("upload-alert").waitFor();
    const alertText = await page.getByTestId("upload-alert").innerText();
    const sourceKept = await page.locator("#audio-source").inputValue();
    const fileKept = await page.locator("#audio-file").inputValue();
    check(
      "T10-noBlankSuccess invalid upload renders envelope details and retains the form",
      /MEDIA_UNAVAILABLE|INVALID_INPUT/.test(alertText) && /requestId /.test(alertText) && sourceKept === "Broken fixture upload" && fileKept.includes("not-audio.wav"),
      alertText.replace(/\s+/g, " ").slice(0, 200),
    );
    check("T10-noBlankSuccess no ready state appears for the invalid upload", (await page.locator('[data-testid="upload-ready"]').count()) === 0);

    let aborted = 0;
    await page.route("**/api/production/assets/import", async (route) => {
      if (route.request().method() === "POST") {
        aborted += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.locator("#audio-file").setInputFiles(validWav);
    await page.locator("#audio-source").fill("Network failure probe");
    await page.getByRole("button", { name: "Import audio file" }).click();
    await page.locator('[data-testid="upload-alert"]:has-text("network error")').waitFor();
    const networkAlert = await page.getByTestId("upload-alert").innerText();
    check(
      "T10-noBlankSuccess aborted upload renders an error and never a success state",
      aborted === 1 && /network error/i.test(networkAlert) && (await page.locator('[data-testid="upload-ready"]').count()) === 0,
      networkAlert.replace(/\s+/g, " ").slice(0, 160),
    );
    await page.unroute("**/api/production/assets/import");
  } catch (error) {
    check("T10-noBlankSuccess invalid upload renders envelope details and retains the form", false, detail(error));
    check("T10-noBlankSuccess no ready state appears for the invalid upload", false, detail(error));
    check("T10-noBlankSuccess aborted upload renders an error and never a success state", false, detail(error));
  }
  await screenshot("T10-noBlankSuccess-failure-paths");

  check("the whole workflow never requested a non-local origin", externalRequests === 0, `${externalRequests} non-local request(s)`);
} catch (error) {
  check("audio cue workflow completed", false, detail(error));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots and fixtures retained in ${runDir}`);
process.exit(failed.length ? 1 : 0);

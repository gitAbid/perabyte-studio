#!/usr/bin/env node
/**
 * C14 long-landscape pilot orchestration (scripts/pilot-long-landscape.mjs).
 *
 * Drives the EXISTING accepted production HTTP surface end to end for the 3-6 minute 16:9 pilot
 * film (docs/production/TASK_PACKETS.md C14, docs/production/reports/C14-PILOT-SCRIPT-freeze.json),
 * in the exact mold of the accepted C13 script (scripts/pilot-short-portrait.mjs). It invents no
 * endpoints, imports no lib modules (node builtins + global fetch only) and never retries a paid
 * enqueue.
 *
 * Long-film fixture (frozen C14): profile storybook-long-v1 (16:9, targetFrames 5760 = 4 min target),
 * 24 shots x 226 frames = 5424 frames = 226 s = 3:46 (inside the 3-6 min window). 226 = 124 + 17*6
 * sits on the H3 take grid (124 + 17n, max 362). Surveyed lib/production/contracts.ts +
 * lib/services/production/shot-plan.ts: animatic totalFrames is the gapless SUM of shot
 * targetFrames; the schema does NOT require equality with profile.targetFrames (the profile value
 * is a planning target), so 24 x 226 seeds for real and the assertion pins the actual sum.
 *
 * Modes:
 *   node scripts/pilot-long-landscape.mjs --preflight [baseURL] [--narration ... --music ... --sfx ...]
 *       Offline RED walk against a local dev server WITHOUT SOGNI_API_KEY. Executes every
 *       offline-capable step (health, LONG plan seeding on storybook-long-v1, pagination/order
 *       assertions, optional creator-audio pre-probe) and records each live-dependent step as a
 *       structured BLOCKER. Never sends a paid enqueue. Exits 0 with the blockers report (the
 *       contract's expected RED state). Any offline failure exits 1.
 *   node scripts/pilot-long-landscape.mjs --final [baseURL] [flags]
 *       Live end-to-end run. FAILS CLOSED before anything else unless BOTH SOGNI_API_KEY and
 *       PERABYTE_STUDIO_REVIEWED_POLICY_PATH are set in this shell (the server and worker must be
 *       started with the same env). Sequence: (1) preflight-lite (health + worker heartbeat +
 *       creator-audio pre-probe), (2) seed project/canon/story/approvals/LONG shot plan,
 *       (3) budget identity wait (--budget-wait-seconds; authorize the seeded project mid-run),
 *       (4) per shot: media quote (BOUND assert) -> anchor enqueue -> poll -> creator approval,
 *           then take quote -> enqueue -> poll -> creator approval -> take selection,
 *       (5) narration import + audio mix save, (6) audio approval,
 *       (7) manifest + export + poll + run_qc + verify QC passed,
 *       (8) STOP: print the G01-G09 checklist + download URL (the human act); with
 *           --creator-approved <file> --state <file> the script records the final-review POST
 *           and (9) downloads the final bytes, verifies sha256 and runs an ffprobe reopen probe
 *           against the 16:9 long profile (1920x1080 h264, 24 fps).
 *
 * Restart/resume across shot batches (frozen C14 drill):
 *   --restart-after-shot N   exit cleanly after shot N's take selection, saving a resumable batch
 *                            state file covering the completed shots (pilot-batch-state-after-N-shots.json).
 *   --resume <state>         continue from shot N+1: re-checks env/health/worker/budget, verifies
 *                            the project, plan and completed selections in the read model, then
 *                            resumes production. Interrupted shots are recovered by polling the
 *                            existing job under the stable per-shot idempotency key — the script
 *                            never re-POSTs a paid enqueue that the store already holds.
 *   The run book (docs/production/pilots/long-landscape.md) documents killing the worker between
 *   batches and restarting it before the resume.
 *
 * Human approvals (anchor, take, audio) are interactive y/N gates on a TTY; in a non-TTY the run
 * stops with instructions unless --yes records the creator's explicit supervised-run acknowledgment.
 *
 * Creator-side hash note (frozen C08 read-model gap): the read model does not export asset
 * sha256, so the FIRST anchor/take approval hash is computed client-side from read-model fields
 * plus a read-only lookup of the local production store (node:sqlite). The server approval route
 * recomputes the hash and remains the only validation truth.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";

/* ------------------------------ frozen fixtures ------------------------------ */

const PROFILE_ID = "storybook-long-v1";
const FPS = 24;
const SAMPLES_PER_FRAME = 2_000; // lib/production/manifest.ts MANIFEST_SAMPLES_PER_FRAME
const SHOT_FRAMES = 226; // H3 grid: 124 + 17*6 (max 362) — every take frameCount is legal
const SHOT_COUNT = 24; // > 6: the long film has NO short-pilot shot ceiling (route maxShots 10_000)
const TOTAL_FRAMES = SHOT_COUNT * SHOT_FRAMES; // 5424 frames = 226 s = 3:46 (3-6 min window)
const TOTAL_SAMPLES = TOTAL_FRAMES * SAMPLES_PER_FRAME; // 10,848,000 samples at 48 kHz
const PROFILE_TARGET_FRAMES = 5760; // storybook-long-v1 targetFrames: a target, NOT an equality constraint (surveyed)
const PAGE_SIZE = 6; // pagination-assertion page width for the long plan reading discipline
const PROVIDER_ID = "sogni";
const DEFAULT_ANCHOR_MODEL = "flux1-schnell-fp8";
const DEFAULT_TAKE_MODEL = "minimax-h3-fl2va-fp8_i2v_turbo"; // 16:9 H3 FL2VA i2v turbo (C13-LIVE-FIX lineage)
const ANCHOR_RESOLUTION = "1080p";
const ASPECT = "16:9";
const EXPECTED_VIDEO = Object.freeze({ width: 1920, height: 1080, fps: FPS, videoCodec: "h264" }); // 16:9 long profile
const MIX_SETTINGS = Object.freeze({ sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true });
const FINAL_REVIEW_CHECKLIST_IDS = ["narrative", "visual", "audio", "captions"]; // lib/production/qc.ts FINAL_REVIEW_CHECKLIST_IDS

/** Exact mirrors of lib/production/approval.ts APPROVAL_CHECKLISTS (server route re-validates). */
const CHECKLISTS = Object.freeze({
  story: ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"],
  shotplan: ["beat_coverage", "spoken_lines", "canon_bindings", "duration_format", "plot_fidelity"],
  animatic: ["beat_coverage", "spoken_lines", "timing", "duration_format", "continuity"],
  anchor: ["identity", "wardrobe", "location", "props", "framing"],
  take: ["identity", "wardrobe", "location", "props", "intended_action", "motion_camera", "artifacts"],
  audio: ["spoken_lines", "intelligibility", "voice_consistency", "cue_timing", "music_sfx_rights", "no_truncation", "balance"],
});

/**
 * Frozen C14 long fixture: "Milo and Pip and the Day the Wind Came" — 24 beats, one shot per beat,
 * every narration written to fit a 226-frame (9.4 s) shot slot at 48 kHz. Cast: Milo alone until
 * Pip joins at the well (shot 8), both afterwards.
 */
const STORY = Object.freeze({
  scriptText: [
    "Milo and Pip and the Day the Wind Came.",
    "",
    "At first light, Milo the mouse woke to a wind that rattled his burrow door.",
    "He knotted his red scarf tight, just the way Grandmother taught him.",
    "He pushed the door open, and the rushing morning hurried in.",
    "Below the hill, the whole meadow waved like a golden sea.",
    "Milo set off down the winding path, leaning into the wind.",
    "Leaves spun around his ears like small, hurried birds.",
    "A gust tugged his scarf away, and he caught the corner just in time.",
    "At the old stone well stood Pip, holding her blue ribbon down with both paws.",
    "Pip waved, and the wind streamed her long ears out sideways.",
    "The wind scattered all her apple blossoms, and Pip called out in dismay.",
    "Milo opened his satchel: string, a basket, and one bright kite.",
    "Together they tied the string to the basket with careful knots.",
    "The kite climbed, and the basket rose into the swirling sky.",
    "They chased the bouncing basket down the hillside, laughing and breathless.",
    "Milo leaped, and caught the string with both paws.",
    "One by one, the apple blossoms drifted back down into the basket.",
    "Pip counted them twice. One was still missing.",
    "They searched the tall grass, parting it paw by paw.",
    "There, on the well's stone lip, sat the last blossom.",
    "Milo reached out gently, and Pip cupped it home.",
    "They carried the basket home beneath a slowly calming sky.",
    "Pip tucked the blossoms into the soft earth beside her door.",
    "Milo shared his canteen, and they watered the little row.",
    "The wind settled, and paw in paw they walked home into the gentle evening.",
  ].join("\n"),
  canon: {
    characterMilo: { entityId: "char_milo_long_pilot", entityKind: "character", description: "Milo, a small brown field mouse with round ears, a cream belly and a red knit scarf.", wardrobe: "Red knit scarf" },
    characterPip: { entityId: "char_pip_long_pilot", entityKind: "character", description: "Pip, a young grey rabbit with long ears, a white tail and a blue ribbon at her ear.", wardrobe: "Blue ribbon" },
    location: { entityId: "loc_meadow_long_pilot", entityKind: "location", description: "A golden hilltop meadow on a windy day with a winding path, Milo's burrow mound and an old stone well." },
    style: { entityId: "style_watercolor_long_pilot", entityKind: "style", description: "Soft watercolor storybook style, warm windy-day palette, gentle ink outlines, painterly light." },
  },
  beats: [
    { id: "beat_01", action: "Milo wakes in his hilltop burrow as the wind rattles the door.", narration: "At first light, Milo the mouse woke to a wind that rattled his burrow door." },
    { id: "beat_02", action: "Milo knots his red scarf tight.", narration: "He knotted his red scarf tight, just the way Grandmother taught him." },
    { id: "beat_03", action: "Milo pushes the door open into the rushing morning.", narration: "He pushed the door open, and the rushing morning hurried in." },
    { id: "beat_04", action: "The meadow below waves like a golden sea.", narration: "Below the hill, the whole meadow waved like a golden sea." },
    { id: "beat_05", action: "Milo starts down the winding path into the wind.", narration: "Milo set off down the winding path, leaning into the wind." },
    { id: "beat_06", action: "Leaves spin around Milo's ears.", narration: "Leaves spun around his ears like small, hurried birds." },
    { id: "beat_07", action: "A gust tugs Milo's scarf; he catches it just in time.", narration: "A gust tugged his scarf away, and he caught the corner just in time." },
    { id: "beat_08", action: "Milo finds Pip at the old stone well, holding her ribbon down.", narration: "At the old stone well stood Pip, holding her blue ribbon down with both paws." },
    { id: "beat_09", action: "Pip waves; the wind streams her long ears sideways.", narration: "Pip waved, and the wind streamed her long ears out sideways." },
    { id: "beat_10", action: "Pip points at her scattered apple blossoms.", narration: "The wind scattered all her apple blossoms, and Pip called out in dismay." },
    { id: "beat_11", action: "Milo lays out string, a basket and a bright kite.", narration: "Milo opened his satchel: string, a basket, and one bright kite." },
    { id: "beat_12", action: "They tie the string to the basket with careful knots.", narration: "Together they tied the string to the basket with careful knots." },
    { id: "beat_13", action: "The kite climbs and lifts the basket into the sky.", narration: "The kite climbed, and the basket rose into the swirling sky." },
    { id: "beat_14", action: "They chase the bouncing basket down the hillside.", narration: "They chased the bouncing basket down the hillside, laughing and breathless." },
    { id: "beat_15", action: "Milo leaps and catches the string with both paws.", narration: "Milo leaped, and caught the string with both paws." },
    { id: "beat_16", action: "The blossoms drift back down into the basket.", narration: "One by one, the apple blossoms drifted back down into the basket." },
    { id: "beat_17", action: "Pip counts the blossoms; one is missing.", narration: "Pip counted them twice. One was still missing." },
    { id: "beat_18", action: "They search the tall grass paw by paw.", narration: "They searched the tall grass, parting it paw by paw." },
    { id: "beat_19", action: "The last blossom sits on the well's stone lip.", narration: "There, on the well's stone lip, sat the last blossom." },
    { id: "beat_20", action: "Milo reaches out and Pip cups the blossom home.", narration: "Milo reached out gently, and Pip cupped it home." },
    { id: "beat_21", action: "They carry the basket home under a calming sky.", narration: "They carried the basket home beneath a slowly calming sky." },
    { id: "beat_22", action: "Pip tucks the blossoms into the soft earth by her door.", narration: "Pip tucked the blossoms into the soft earth beside her door." },
    { id: "beat_23", action: "Milo shares his canteen and they water the little row.", narration: "Milo shared his canteen, and they watered the little row." },
    { id: "beat_24", action: "The wind settles; paw in paw they walk home into the evening.", narration: "The wind settled, and paw in paw they walked home into the gentle evening." },
  ],
  shots: [
    { shotId: "shot_01", beatId: "beat_01", framing: "medium", cast: "milo", visualIntent: "Milo opens one eye in his hilltop burrow as dawn light slips under the door and the wind rattles the latch.", motionIntent: "Slow push-in as Milo blinks awake; the round door trembles in its frame." },
    { shotId: "shot_02", beatId: "beat_02", framing: "close", cast: "milo", visualIntent: "Milo knots his red scarf tight beneath his chin with both paws.", motionIntent: "Close on the small paws tying the knot; one confident final tug." },
    { shotId: "shot_03", beatId: "beat_03", framing: "medium_wide", cast: "milo", visualIntent: "Milo pushes the burrow door open and steps out into the rushing golden morning.", motionIntent: "The door swings wide and the wind combs the grass beyond it." },
    { shotId: "shot_04", beatId: "beat_04", framing: "extreme_wide", cast: "milo", visualIntent: "From the hilltop the whole meadow waves like a golden sea under racing clouds.", motionIntent: "Slow pan across the wind-combed meadow to the far horizon." },
    { shotId: "shot_05", beatId: "beat_05", framing: "wide", cast: "milo", visualIntent: "Milo starts down the winding hill path, leaning into the wind.", motionIntent: "Gentle lateral tracking as Milo walks, scarf streaming behind him." },
    { shotId: "shot_06", beatId: "beat_06", framing: "medium", cast: "milo", visualIntent: "Dry leaves spin around Milo's ears like small hurried birds.", motionIntent: "Leaves swirl past the lens as Milo grins and ducks one." },
    { shotId: "shot_07", beatId: "beat_07", framing: "close", cast: "milo", visualIntent: "A gust tugs the red scarf from Milo's neck and he catches the corner just in time.", motionIntent: "A sharp gust snaps the scarf taut between his gripping paws." },
    { shotId: "shot_08", beatId: "beat_08", framing: "wide", cast: "both", visualIntent: "At the old stone well stands Pip, pressing her blue ribbon down with both paws.", motionIntent: "Milo arrives on the path; Pip looks up and holds the ribbon tighter." },
    { shotId: "shot_09", beatId: "beat_09", framing: "medium_wide", cast: "both", visualIntent: "Pip waves a greeting and the wind streams her long ears out sideways.", motionIntent: "Pip's long ears ripple in the wind as she waves with one paw." },
    { shotId: "shot_10", beatId: "beat_10", framing: "medium", cast: "both", visualIntent: "Pip points at the well yard where the wind has scattered her apple blossoms everywhere.", motionIntent: "A pan across swirling petals; Pip stamps one paw in dismay." },
    { shotId: "shot_11", beatId: "beat_11", framing: "close", cast: "both", visualIntent: "Milo opens his satchel: coil of string, a woven basket and one bright paper kite.", motionIntent: "Overhead close-up as each item is laid out on the grass." },
    { shotId: "shot_12", beatId: "beat_12", framing: "medium_wide", cast: "both", visualIntent: "The two friends tie the string to the basket with careful, practiced knots.", motionIntent: "Over-the-shoulder view as four small paws tie the knots together." },
    { shotId: "shot_13", beatId: "beat_13", framing: "extreme_wide", cast: "both", visualIntent: "The bright kite climbs and lifts the basket up into the swirling sky.", motionIntent: "Tilt up following the kite string; the basket swings free against the clouds." },
    { shotId: "shot_14", beatId: "beat_14", framing: "wide", cast: "both", visualIntent: "Milo and Pip chase the bouncing basket down the grassy hillside.", motionIntent: "Tracking shot of the chase with petals streaming past." },
    { shotId: "shot_15", beatId: "beat_15", framing: "medium", cast: "both", visualIntent: "Milo leaps from a grass tussock and catches the string with both paws.", motionIntent: "A brief slow-motion leap; the string pulls taut in his grip." },
    { shotId: "shot_16", beatId: "beat_16", framing: "medium_wide", cast: "both", visualIntent: "High above, the rescued apple blossoms drift one by one back into the basket.", motionIntent: "Gentle tilt up as petals spiral slowly down into the basket." },
    { shotId: "shot_17", beatId: "beat_17", framing: "close", cast: "both", visualIntent: "Pip counts the rescued blossoms twice and frowns: one is still missing.", motionIntent: "Close on counting paws; the frown settles on the empty gap." },
    { shotId: "shot_18", beatId: "beat_18", framing: "wide", cast: "both", visualIntent: "They search the tall grass, parting it paw by paw in the wind.", motionIntent: "Low tracking shot through parting grass blades." },
    { shotId: "shot_19", beatId: "beat_19", framing: "close", cast: "both", visualIntent: "On the well's weathered stone lip sits the last apple blossom, wobbling in the breeze.", motionIntent: "Slow push-in as the blossom trembles at the stone edge." },
    { shotId: "shot_20", beatId: "beat_20", framing: "medium_wide", cast: "both", visualIntent: "Milo reaches out gently and Pip cups the blossom into the basket with her ribbon.", motionIntent: "Two-shot as the blossom is tucked safely beneath the ribbon." },
    { shotId: "shot_21", beatId: "beat_21", framing: "wide", cast: "both", visualIntent: "They carry the basket home together beneath a slowly calming sky.", motionIntent: "Slow pull-away as the two friends walk the path under softening clouds." },
    { shotId: "shot_22", beatId: "beat_22", framing: "medium", cast: "both", visualIntent: "By Pip's door they tuck the blossoms into a little row of soft earth.", motionIntent: "Static medium shot as small paws press the blossoms into the soil." },
    { shotId: "shot_23", beatId: "beat_23", framing: "close", cast: "both", visualIntent: "Milo shares his canteen and they water the little planted row.", motionIntent: "Close on the bright water arc falling across the planted row." },
    { shotId: "shot_24", beatId: "beat_24", framing: "extreme_wide", cast: "both", visualIntent: "The wind settles; paw in paw, Milo and Pip walk home into the gentle evening.", motionIntent: "Static wide as the sky melts to rose and two small figures wander home." },
  ],
});

/* ------------------------------ tiny utilities ------------------------------ */

const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const nowIso = () => new Date().toISOString();
const isHex64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const h3Legal = (frames) => Number.isSafeInteger(frames) && frames >= 124 && frames <= 362 && (frames - 124) % 17 === 0;

/**
 * Canonical JSON for creator-side approval-hash computation ONLY. Same recipe as
 * lib/production/hash.ts (sorted keys, NFC strings, ordered arrays); the server route
 * recomputes every hash and rejects mismatches, so this can never relax validation.
 */
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}
const hashCanonicalJson = (value) => sha256Hex(Buffer.from(canonicalJson(value), "utf8"));

/* --------------------------------- CLI parse -------------------------------- */

function usage(exitCode = 2) {
  console.log(`C14 long-landscape pilot orchestration

Usage:
  node scripts/pilot-long-landscape.mjs --preflight [baseURL] [audio flags]
      Offline RED walk (no SOGNI_API_KEY needed). Never sends a paid enqueue.
      Exits 0 with the structured blockers report. With the creator audio flags the
      48 kHz pre-probe runs as part of the offline walk; without them the missing
      audio is recorded as a blocker.

  node scripts/pilot-long-landscape.mjs --final [baseURL] [flags]
      Live run. Fail-closed env gate: requires SOGNI_API_KEY and
      PERABYTE_STUDIO_REVIEWED_POLICY_PATH in this shell (start the server and
      worker with the same env). Flags:
        --narration <file>     one creator narration file per narrated beat, in beat
                               order (repeat the flag; the long fixture has ${SHOT_COUNT} beats)
        --music <file>         creator music bed (one file, spans the timeline)
        --sfx <file>           creator SFX accent; the i-th file accents shot i+1
                               (repeatable, max ${SHOT_COUNT - 1})
        --anchor-model <id>    image model covered by the reviewed policy
                               (default ${DEFAULT_ANCHOR_MODEL})
        --take-model <id>      H3 video model covered by the reviewed policy
                               (default ${DEFAULT_TAKE_MODEL})
        --data-dir <dir>       server's PERABYTE_STUDIO_DATA_DIR (read-only creator-side
                               asset checksum lookup for first approval hashes)
        --out-dir <dir>        run artifact directory (default: fresh temp dir)
        --job-timeout-minutes <n>    per-job poll budget (default 15)
        --export-timeout-minutes <n> export render budget for the 226 s film (default 60)
        --budget-wait-seconds <n>    budget-gate wait budget: when the seeded project's
                               budget read model is still unavailable, re-check both
                               scopes every 15s for up to <n> seconds so the operator
                               can authorize the project mid-run (default 600;
                               0 restores the immediate stop). No media quote or
                               enqueue is ever sent before a scope resolves available.
        --seed-base <n>        deterministic seed base (default 11)
        --yes                  non-TTY acknowledgment that the creator supervises approvals
        --restart-after-shot <n>  exit cleanly after shot <n>'s take selection (1..${SHOT_COUNT}),
                               saving a resumable batch state file (restart drill)
        --resume <file>        batch resume: load the batch state saved by --restart-after-shot
                               and continue from shot N+1 (skips completed shots)
        --state <file>         step-8 resume: load the pilot state saved at the final stop
        --creator-approved <file>  step-8 resume: creator's written final-review evidence
                               (must name narrative/visual/audio/captions and give an
                               "ack <advisory-code>: <reason>" line per QC advisory)
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { mode: null, base: null, narrations: [], sfx: [], music: null, creatorApproved: null, state: null, resume: null, restartAfterShot: null, outDir: null, yes: false, dataDir: process.env.PERABYTE_STUDIO_DATA_DIR?.trim() || null, anchorModel: DEFAULT_ANCHOR_MODEL, takeModel: DEFAULT_TAKE_MODEL, jobTimeoutMinutes: 15, exportTimeoutMinutes: 60, budgetWaitSeconds: 600, seedBase: 11 };
  const needValue = (flag) => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) { console.error(`ERROR: ${flag} requires a value.`); usage(2); }
    argv.splice(index, 2);
    return value;
  };
  if (argv.includes("--preflight")) { args.mode = "preflight"; argv.splice(argv.indexOf("--preflight"), 1); }
  if (argv.includes("--final")) { args.mode = "final"; argv.splice(argv.indexOf("--final"), 1); }
  args.yes = argv.includes("--yes");
  if (args.yes) argv.splice(argv.indexOf("--yes"), 1);
  for (const [flag, key] of [["--base", "base"], ["--creator-approved", "creatorApproved"], ["--state", "state"], ["--resume", "resume"], ["--out-dir", "outDir"], ["--data-dir", "dataDir"], ["--anchor-model", "anchorModel"], ["--take-model", "takeModel"], ["--music", "music"]]) {
    const value = needValue(flag);
    if (value !== null) args[key] = value;
  }
  while (argv.includes("--narration")) args.narrations.push(needValue("--narration"));
  while (argv.includes("--sfx")) args.sfx.push(needValue("--sfx"));
  for (const flag of ["--job-timeout-minutes", "--export-timeout-minutes", "--seed-base", "--restart-after-shot"]) {
    const raw = needValue(flag);
    if (raw !== null) {
      const key = flag === "--job-timeout-minutes" ? "jobTimeoutMinutes" : flag === "--export-timeout-minutes" ? "exportTimeoutMinutes" : flag === "--seed-base" ? "seedBase" : "restartAfterShot";
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) { console.error(`ERROR: ${flag} must be a positive integer.`); usage(2); }
      if (key === "restartAfterShot" && parsed > SHOT_COUNT) { console.error(`ERROR: --restart-after-shot must be between 1 and ${SHOT_COUNT} (the fixture has ${SHOT_COUNT} shots).`); usage(2); }
      args[key] = parsed;
    }
  }
  {
    // 0 is a meaningful value here: it restores the immediate stop at the budget gate.
    const raw = needValue("--budget-wait-seconds");
    if (raw !== null) {
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 0) { console.error("ERROR: --budget-wait-seconds must be a non-negative integer (seconds; 0 stops immediately at an unavailable budget read model)."); usage(2); }
      args.budgetWaitSeconds = parsed;
    }
  }
  // needValue already consumed every flag+value pair; anything left is the positional base URL.
  const unknownFlags = argv.filter((arg) => arg.startsWith("--"));
  if (unknownFlags.length > 0) { console.error(`ERROR: unknown flag(s): ${unknownFlags.join(", ")}`); usage(2); }
  const leftovers = argv.filter((arg) => !arg.startsWith("--"));
  if (leftovers.length > 1) { console.error("ERROR: more than one base URL given."); usage(2); }
  if (leftovers.length === 1) args.base = leftovers[0];
  if (args.mode !== "final") {
    const finalOnly = ["--state", "--creator-approved", "--resume", "--restart-after-shot"].filter((flag) => argv.includes(flag));
    if (finalOnly.length > 0) { console.error(`ERROR: ${finalOnly.join(", ")} only apply to --final runs.`); usage(2); }
    if (args.state || args.creatorApproved || args.resume || args.restartAfterShot) { console.error("ERROR: --state/--creator-approved/--resume/--restart-after-shot only apply to --final runs."); usage(2); }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.mode) { console.error("ERROR: choose --preflight or --final (see --help usage below)."); usage(2); }

/* --------------------------- fail-closed env gate --------------------------- */

if (args.mode === "final") {
  const missing = [];
  if (!process.env.SOGNI_API_KEY?.trim()) missing.push("SOGNI_API_KEY (the Sogni credential the SERVER uses for live renders)");
  if (!process.env.PERABYTE_STUDIO_REVIEWED_POLICY_PATH?.trim()) missing.push("PERABYTE_STUDIO_REVIEWED_POLICY_PATH (the reviewed pricing/coverage policy installed per B6-POLICY-LOAD)");
  if (missing.length > 0) {
    console.error("REFUSING TO RUN --final: the live pilot's fail-closed env gate is not satisfied.");
    for (const item of missing) console.error(`  missing: ${item}`);
    console.error("The server AND worker must be started in a shell that exports BOTH variables with the same values.");
    console.error("No paid or mutating request was sent. For the offline RED walk use --preflight instead.");
    process.exit(1);
  }
  // C13 review finding (carried into C14): `--state <file>` without `--creator-approved <file>`
  // must never fall through into a brand-new live run (the saved step-8 state would be ignored).
  if (args.state && !args.creatorApproved) {
    console.error("REFUSING TO RUN --final: --state <file> was given without --creator-approved <file>.");
    console.error("A step-8 resume needs BOTH flags; starting without --creator-approved would seed a NEW project and ignore the saved state.");
    console.error(`  step-8 resume:  node scripts/pilot-long-landscape.mjs --final <baseURL> --state ${args.state} --creator-approved <your-review-file> --out-dir <run-artifacts>`);
    console.error("  batch resume (continue shots N+1): use --resume <batch-state> instead. No request was sent.");
    process.exit(1);
  }
  if (args.resume && (args.state || args.creatorApproved)) {
    console.error("REFUSING TO RUN --final: --resume <batch-state> and --state/--creator-approved (step-8 resume) are mutually exclusive.");
    console.error("No request was sent.");
    process.exit(1);
  }
  if (args.restartAfterShot && (args.state || args.creatorApproved)) {
    console.error("REFUSING TO RUN --final: --restart-after-shot drives batch production and cannot be combined with a step-8 resume (--state/--creator-approved).");
    console.error("It MAY be combined with --resume to stop again at a later batch boundary. No request was sent.");
    process.exit(1);
  }
}

/* ------------------------------- base URL gate ------------------------------ */

const BASE = (args.base ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const baseAuthority = (() => { try { return new URL(BASE); } catch { return null; } })();
if (!baseAuthority || !/^https?:$/.test(baseAuthority.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(baseAuthority.hostname)) {
  console.error(`REFUSING TO RUN: base URL must be a local loopback HTTP server (got ${BASE}).`);
  console.error("This script only ever talks to a local production dev server.");
  process.exit(1);
}

/* --------------------------------- logging ---------------------------------- */

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let BATCH_RUN_ID = runId; // stable across batch resumes: idempotency keys derive from it
const outDir = args.outDir ? resolve(args.outDir) : mkdtempSync(join(tmpdir(), `pilot-long-landscape-${runId}-`));
mkdirSync(outDir, { recursive: true });
let paidLogPath = join(outDir, "paid-steps.jsonl");
const statePath = join(outDir, "pilot-state.json");
let paidSteps = 0;

function log(message) { console.log(`[${nowIso()}] ${message}`); }
function paidLog(entry) {
  paidSteps += 1;
  const record = { at: nowIso(), runId, batchRunId: BATCH_RUN_ID, seq: paidSteps, reservationId: null, reservationNote: "budget reservations are worker-side and are not exposed by the accepted HTTP read surface; reconcile via the project budget read model", ...entry };
  appendFileSync(paidLogPath, `${JSON.stringify(record)}\n`, { flag: "a" });
  console.log(`[paid] ${JSON.stringify(record)}`);
}

/* ------------------------------- HTTP helpers ------------------------------- */

class PilotStop extends Error {
  constructor(message, detail = {}) { super(message); this.name = "PilotStop"; this.detail = detail; }
}

async function fetchJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { cache: "no-store", ...options });
  } catch (error) {
    throw new PilotStop(`Network failure talking to ${BASE}${path}: ${String(error).replace(/\s+/g, " ")}`, { kind: "network" });
  }
  const text = await response.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { unparsed: text.slice(0, 400) }; }
  return { status: response.status, ok: response.ok, body, text };
}

function envelopeOf(response) {
  const error = response.body && typeof response.body === "object" ? response.body.error ?? null : null;
  return {
    status: response.status,
    code: error?.code ?? `HTTP_${response.status}`,
    message: error?.message
      ?? (typeof response.body?.unparsed === "string" && response.body.unparsed.trim()
        ? `unparsable response body (HTTP ${response.status}; the route may not map composition-layer blocks to the standard envelope)`
        : `no parsable body (HTTP ${response.status})`),
    requestId: response.body?.requestId ?? "unknown",
  };
}

/** POST JSON with the same-origin Origin header; throws PilotStop carrying the error envelope. */
async function postJson(path, body, expectStatus = null) {
  const started = Date.now();
  const response = await fetchJson(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify(body),
  });
  const step = `POST ${path}`;
  if (!response.ok) {
    const envelope = envelopeOf(response);
    throw new PilotStop(`${step} failed: HTTP ${envelope.status} ${envelope.code} — ${envelope.message} (requestId ${envelope.requestId})`, { kind: "envelope", envelope, step });
  }
  if (expectStatus !== null && response.status !== expectStatus) {
    throw new PilotStop(`${step} returned HTTP ${response.status} (expected ${expectStatus}).`, { kind: "unexpected_status", step });
  }
  return { body: response.body, ms: Date.now() - started, status: response.status };
}

/** Multipart media import through POST /api/production/assets/import. */
async function importMedia(filePath, kindLabel) {
  const bytes = readFileSync(filePath);
  const extension = basename(filePath).toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
  if (extension === "mp3" ? !isMp3Header(bytes) : !isWavHeader(bytes)) {
    throw new PilotStop(`${kindLabel} file ${filePath} does not look like a ${extension === "mp3" ? "48 kHz MP3" : "48 kHz 16-bit PCM WAV"} the import route accepts; convert it first (see the run book).`, { kind: "input" });
  }
  const form = new FormData();
  form.append("source", `Long-landscape pilot run ${runId}: creator-supplied ${kindLabel} (${basename(filePath)})`);
  form.append("rightsAttestation", `The local creator attests they own or have rights to this ${kindLabel} audio and authorize its use in this pilot film (run ${runId}).`);
  form.append("rightsStatus", "creator_attested");
  form.append("file", new Blob([bytes], { type: extension === "mp3" ? "audio/mpeg" : "audio/wav" }), basename(filePath));
  const response = await fetch(`${BASE}/api/production/assets/import`, { method: "POST", headers: { origin: BASE }, body: form }).catch((error) => { throw new PilotStop(`Import of ${filePath} failed at the network layer: ${String(error).replace(/\s+/g, " ")}`, { kind: "network" }); });
  const text = await response.text().catch(() => "");
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { unparsed: text.slice(0, 400) }; }
  if (!response.ok || body?.asset?.id === undefined) {
    const error = body?.error;
    throw new PilotStop(`Import of ${kindLabel} ${filePath} failed: HTTP ${response.status} ${error?.code ?? "HTTP_ERROR"} — ${error?.message ?? text.slice(0, 200)} (requestId ${body?.requestId ?? "unknown"})`, { kind: "envelope", envelope: { status: response.status, code: error?.code ?? "HTTP_ERROR", message: error?.message ?? "", requestId: body?.requestId ?? "unknown" }, step: `import ${kindLabel}` });
  }
  return body.asset;
}

/* ---------------------- client-side audio pre-probe ------------------------- */

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
function isWavHeader(bytes) {
  if (bytes.length < 44) return false;
  if (bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WAVE") return false;
  let offset = 12; let format = null; let dataBytes = -1;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("latin1");
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > bytes.length) return false;
    if (id === "fmt ") {
      if (bytes.readUInt16LE(body) !== 1) return false;
      const channels = bytes.readUInt16LE(body + 2);
      const sampleRate = bytes.readUInt32LE(body + 4);
      const bits = bytes.readUInt16LE(body + 14);
      if (channels < 1 || channels > 2 || sampleRate !== 48_000 || bits !== 16) return false;
      format = { channels };
    } else if (id === "data") dataBytes = size;
    offset = body + size + (size % 2);
  }
  return format !== null && dataBytes > 0;
}
function isMp3Header(bytes) {
  let offset = 0;
  if (bytes.subarray(0, 3).toString("latin1") === "ID3") {
    if (bytes.length < 10) return false;
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  }
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;
    if (((bytes[offset + 1] >> 3) & 0x03) !== 0b11 || ((bytes[offset + 1] >> 1) & 0x03) !== 0b01) return false;
    const bitrateIndex = bytes[offset + 2] >> 4;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex !== 1) return false; // index 1 = 48 kHz
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    offset += Math.floor((144 * MP3_BITRATES[bitrateIndex] * 1000) / 48_000) + padding;
    frames += 1;
    if (frames > 200_000) return true;
  }
  return frames > 0;
}
/** Decoded 48 kHz sample count per the import route's own header rules (server re-probes). */
function audioSamples(bytes) {
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WAVE") {
    let offset = 12; let blockAlign = 0; let dataBytes = -1;
    while (offset + 8 <= bytes.length) {
      const id = bytes.subarray(offset, offset + 4).toString("latin1");
      const size = bytes.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === "fmt ") blockAlign = bytes.readUInt16LE(body + 12);
      else if (id === "data") dataBytes = size;
      offset = body + size + (size % 2);
    }
    if (blockAlign > 0 && dataBytes > 0 && dataBytes % blockAlign === 0) return dataBytes / blockAlign;
    return null;
  }
  let offset = 0;
  if (bytes.subarray(0, 3).toString("latin1") === "ID3") offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  let frames = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
    const bitrateIndex = bytes[offset + 2] >> 4;
    const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex !== 1) return null; // index 1 = 48 kHz
    offset += Math.floor((144 * MP3_BITRATES[bitrateIndex] * 1000) / 48_000) + padding;
    frames += 1;
  }
  return frames > 0 ? frames * 1152 : null;
}

/* ------------------- creator-side asset checksum (read-only) ----------------- */

let assetDbPath = null;
let assetDb = null;
function openAssetDb() {
  if (assetDb !== null) return assetDb;
  if (!args.dataDir) {
    throw new PilotStop("The first anchor/take approval hash needs the asset checksum, which the read model does not export (frozen C08 read-model gap). Pass --data-dir <the server's PERABYTE_STUDIO_DATA_DIR> so the pilot can look it up read-only from <dataDir>/production.sqlite.", { kind: "input" });
  }
  assetDbPath = join(resolve(args.dataDir), "production.sqlite");
  if (!existsSync(assetDbPath)) {
    throw new PilotStop(`No production store found at ${assetDbPath}. Pass --data-dir pointing at the server's PERABYTE_STUDIO_DATA_DIR.`, { kind: "input" });
  }
  try {
    assetDb = new DatabaseSync(assetDbPath, { readOnly: true });
  } catch (error) {
    throw new PilotStop(`Could not open ${assetDbPath} read-only: ${String(error).replace(/\s+/g, " ")}. Keep the server process running (WAL side files must exist) or pass the correct --data-dir.`, { kind: "input" });
  }
  return assetDb;
}
function assetSha256(assetId) {
  const row = openAssetDb().prepare("SELECT sha256 FROM assets WHERE asset_id = ?").get(assetId);
  if (!row || !isHex64(row.sha256)) {
    throw new PilotStop(`Asset ${assetId} has no usable sha256 row in ${assetDbPath}; refusing to guess an approval hash.`, { kind: "input" });
  }
  return row.sha256;
}
const anchorApprovalHash = (anchor, assetChecksum) => hashCanonicalJson({ recipeVersion: 1, anchorId: anchor.id, shotRevisionId: anchor.shotRevisionId, inputsHash: anchor.inputsHash, assetSha256: assetChecksum });
const takeApprovalHash = (take, assetChecksum) => hashCanonicalJson({ recipeVersion: 1, takeId: take.id, shotRevisionId: take.shotRevisionId, anchorId: take.anchorId, approvalId: take.approvalId, inputsHash: take.inputsHash, assetSha256: assetChecksum });

/* ------------------------------ interactive gate ---------------------------- */

async function creatorGate(label) {
  if (args.yes) {
    log(`GATE (recorded via --yes, supervised run): ${label}`);
    return;
  }
  if (!process.stdin.isTTY || process.stdin.destroyed) {
    throw new PilotStop(`Human approval gate reached in a non-interactive session: ${label}. Re-run with --yes to record the creator's explicit supervised-run acknowledgment, or run interactively.`, { kind: "gate" });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`[gate] ${label}\n[gate] Type "approve" to record the creator approval and continue (anything else aborts): `)).trim().toLowerCase();
    if (answer !== "approve") {
      throw new PilotStop(`Creator withheld the approval at the gate: ${label}. The run stops; nothing was approved.`, { kind: "gate" });
    }
  } finally {
    rl.close();
  }
}

/* ------------------------------ domain helpers ------------------------------ */

const checklistFor = (kind, notePrefix) => CHECKLISTS[kind].map((id) => ({ id, passed: true, note: `${notePrefix} — ${id} checked by the supervising creator` }));
const shotStartFrame = (index) => index * SHOT_FRAMES;
const shotStartSample = (index) => shotStartFrame(index) * SAMPLES_PER_FRAME;

function assertReadModelShape(model) {
  if (!model || model.schemaVersion !== 2 || !model.project?.id) {
    throw new PilotStop("Project read model response is not the expected v2 shape.", { kind: "shape" });
  }
  return model;
}

async function readProject(projectId) {
  const response = await fetchJson(`/api/production/projects/${projectId}`);
  if (!response.ok) {
    const envelope = envelopeOf(response);
    throw new PilotStop(`GET project read model failed: ${envelope.code} — ${envelope.message} (requestId ${envelope.requestId})`, { kind: "envelope", envelope, step: "read model" });
  }
  return assertReadModelShape(response.body);
}

/** Poll GET /api/production/jobs/[id] until a terminal status; prints live progress. */
async function pollJob(jobId, label, timeoutMinutes) {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastLine = "";
  while (Date.now() < deadline) {
    const response = await fetchJson(`/api/production/jobs/${jobId}`);
    if (!response.ok) {
      const envelope = envelopeOf(response);
      throw new PilotStop(`Job poll for ${label} failed: ${envelope.code} — ${envelope.message} (requestId ${envelope.requestId})`, { kind: "envelope", envelope, step: `poll ${label}` });
    }
    const { job, events, recoveryAction } = response.body;
    const latest = events.length > 0 ? events[events.length - 1] : null;
    const line = `${job.status}${latest?.progress != null ? ` ${Math.round(latest.progress)}%` : ""}${latest?.message ? ` — ${String(latest.message).slice(0, 120)}` : ""}`;
    if (line !== lastLine) { log(`[poll] ${label} job ${jobId}: ${line}`); lastLine = line; }
    if (job.status === "completed") return job;
    if (["failed", "canceled", "submission_unknown", "blocked"].includes(job.status)) {
      throw new PilotStop(`Job ${jobId} (${label}) reached terminal status ${job.status}: ${job.errorCode ?? "no code"} — ${job.errorMessage ?? "no message"}${recoveryAction ? ` Recovery: ${recoveryAction}` : ""}`, { kind: "job_terminal", job, step: `poll ${label}` });
    }
    await sleep(5_000);
  }
  throw new PilotStop(`Job ${jobId} (${label}) did not reach a terminal status within ${timeoutMinutes} minutes; the run stops (no retry is attempted).`, { kind: "timeout", step: `poll ${label}` });
}

function resolveShotModels(model, shotRevisionId) {
  const shot = model.shots.find((entry) => entry.shotRevision.id === shotRevisionId);
  if (!shot) throw new PilotStop(`Shot revision ${shotRevisionId} missing from the read model.`, { kind: "shape" });
  return shot;
}

function latestByJobId(records, jobId) {
  const matches = records.filter((record) => record.jobId === jobId);
  matches.sort((left, right) => right.createdAt - left.createdAt);
  return matches[0] ?? null;
}

function approvedApprovalFor(readShot, targetKind, targetId) {
  return readShot.approvals.find((approval) => approval.targetKind === targetKind && approval.targetId === targetId && approval.decision === "approved") ?? null;
}

/**
 * Long-plan order/pagination invariants, asserted against the project read model (v2).
 * Survey note (frozen C14): the accepted read model exports the shots of the active plan as ONE
 * bounded ordered array (max 10_000) — there is no per-shot HTTP paging route yet. The lib's
 * deterministic offset paging (lib/production/shot-plan.ts paginateShots, cursor "offset:N") is
 * the reading discipline this pilot applies client-side: the plan is read page by page from TWO
 * independent GETs, and every page must match across reads AND the authoritative
 * orderedShotRevisionIds AND the gapless animatic timeline.
 */
async function assertLongPlanInvariants(projectId) {
  const modelA = await readProject(projectId);
  const modelB = await readProject(projectId);
  if (!modelA.shotPlanRevision || !modelA.animaticRevision) {
    throw new PilotStop("Project read model has no active shot plan/animatic.", { kind: "shape" });
  }
  const shotsA = modelA.shots;
  const shotsB = modelB.shots;
  if (shotsA.length !== SHOT_COUNT || shotsB.length !== SHOT_COUNT) {
    throw new PilotStop(`Long plan must hold exactly ${SHOT_COUNT} shot rows in the read model (got ${shotsA.length}/${shotsB.length}); the short-pilot 6-shot ceiling must not apply.`, { kind: "shape" });
  }
  const idsA = shotsA.map((entry) => entry.shotRevision.id);
  const idsB = shotsB.map((entry) => entry.shotRevision.id);
  if (idsA.some((id, index) => id !== idsB[index])) {
    throw new PilotStop("Shot order differs between two independent read-model reads; pagination is not stable.", { kind: "shape" });
  }
  const orderedIds = modelA.shotPlanRevision.orderedShotRevisionIds;
  if (orderedIds.length !== SHOT_COUNT || idsA.some((id, index) => id !== orderedIds[index])) {
    throw new PilotStop("Read-model shots array does not match shotPlanRevision.orderedShotRevisionIds in order.", { kind: "shape" });
  }
  for (const [index, entry] of shotsA.entries()) {
    if (entry.shotRevision.order !== index) {
      throw new PilotStop(`Shot ${entry.shotRevision.shotId} carries order ${entry.shotRevision.order}, expected ${index}.`, { kind: "shape" });
    }
  }
  const pagesA = [];
  for (let offset = 0; offset < shotsA.length; offset += PAGE_SIZE) pagesA.push(idsA.slice(offset, offset + PAGE_SIZE));
  const pagesB = [];
  for (let offset = 0; offset < shotsB.length; offset += PAGE_SIZE) pagesB.push(idsB.slice(offset, offset + PAGE_SIZE));
  const pagesStable = pagesA.every((page, pageIndex) => page.every((id, itemIndex) => id === pagesB[pageIndex][itemIndex]));
  if (!pagesStable) {
    throw new PilotStop(`Offset-windowed pages of ${PAGE_SIZE} differ between reads; order is not stable across pages.`, { kind: "shape" });
  }
  const pageIds = pagesA.flat();
  if (pageIds.length !== SHOT_COUNT || new Set(pageIds).size !== SHOT_COUNT || pageIds.some((id, index) => id !== orderedIds[index])) {
    throw new PilotStop("Paged reading dropped, duplicated or reordered shots.", { kind: "shape" });
  }
  const annotations = [...modelA.animaticRevision.timingAnnotations].sort((left, right) => left.startFrame - right.startFrame);
  if (annotations.length !== SHOT_COUNT) {
    throw new PilotStop(`Animatic carries ${annotations.length} timing annotations for ${SHOT_COUNT} shots.`, { kind: "shape" });
  }
  let gapless = true;
  for (const [index, annotation] of annotations.entries()) {
    if (annotation.shotRevisionId !== idsA[index]) gapless = false;
    if (annotation.startFrame !== shotStartFrame(index) || annotation.endFrame !== shotStartFrame(index) + SHOT_FRAMES) gapless = false;
    if (index > 0 && annotation.startFrame !== annotations[index - 1].endFrame) gapless = false;
  }
  if (!gapless) {
    throw new PilotStop("Animatic timeline is not gapless and aligned with the ordered shots.", { kind: "shape" });
  }
  const sumFrames = shotsA.reduce((total, entry) => total + entry.shotRevision.targetFrames, 0);
  if (sumFrames !== TOTAL_FRAMES || modelA.animaticRevision.totalFrames !== TOTAL_FRAMES) {
    throw new PilotStop(`Animatic pins ${modelA.animaticRevision.totalFrames} frames / shots sum to ${sumFrames}, but the frozen long fixture requires exactly ${TOTAL_FRAMES}.`, { kind: "shape" });
  }
  return {
    shotCount: SHOT_COUNT,
    pageSize: PAGE_SIZE,
    pages: pagesA.length,
    stableAcrossReads: true,
    matchesOrderedShotRevisionIds: true,
    timelineGapless: true,
    totalFrames: modelA.animaticRevision.totalFrames,
    readModelNote: "the v2 read model exports the plan's shots as one bounded ordered array; pagination is asserted page-by-page (offset windows) across two independent reads against orderedShotRevisionIds and the gapless animatic timeline",
  };
}

/* --------------------------------- seeding ---------------------------------- */

const castFor = (index, canon) => STORY.shots[index].cast === "milo"
  ? [{ characterId: STORY.canon.characterMilo.entityId, canonRevisionId: canon.characterMilo.id, wardrobe: STORY.canon.characterMilo.wardrobe }]
  : [
      { characterId: STORY.canon.characterMilo.entityId, canonRevisionId: canon.characterMilo.id, wardrobe: STORY.canon.characterMilo.wardrobe },
      { characterId: STORY.canon.characterPip.entityId, canonRevisionId: canon.characterPip.id, wardrobe: STORY.canon.characterPip.wardrobe },
    ];

async function seedWorkflow(projectName, modeLabel) {
  const seeded = { projectId: null };
  log(`[seed] creating project "${projectName}" (profile ${PROFILE_ID}, 16:9)`);
  seeded.projectId = (await postJson("/api/production/projects", { name: projectName, profileId: PROFILE_ID }, 201)).body.id;

  const canon = {};
  for (const [key, entity] of Object.entries(STORY.canon)) {
    const revision = (await postJson(`/api/production/projects/${seeded.projectId}/canon`, {
      projectId: seeded.projectId, entityId: entity.entityId, expectedRevisionId: null,
      entityKind: entity.entityKind, description: entity.description, attributes: {}, assetIds: [],
    }, 201)).body;
    await postJson(`/api/production/projects/${seeded.projectId}/canon/selection`, {
      projectId: seeded.projectId, entityId: entity.entityId, expectedRevisionId: revision.id, canonRevisionId: revision.id,
    }, 200);
    canon[key] = revision;
    log(`[seed] canon ${entity.entityKind} ${entity.entityId} -> revision ${revision.id}`);
  }
  seeded.canon = canon;

  const story = (await postJson(`/api/production/projects/${seeded.projectId}/stories`, {
    projectId: seeded.projectId, expectedStoryRevisionId: null,
    scriptText: STORY.scriptText,
    beats: STORY.beats.map(({ id, action, narration }) => ({ id, action, narration, dialogue: [] })),
    canonRevisionIds: [canon.characterMilo.id, canon.characterPip.id, canon.location.id, canon.style.id],
  }, 201)).body;
  log(`[seed] story revision ${story.id} (${STORY.beats.length} beats)`);
  seeded.story = story;

  await postJson("/api/production/approvals", {
    projectId: seeded.projectId, idempotencyKey: `pilot-${runId}-story-approval`,
    command: {
      targetKind: "story", targetId: story.id, expectedHash: story.contentHash, decision: "approved",
      checklist: checklistFor("story", modeLabel),
      notes: "Story approved for the C14 long-landscape pilot (fixture Milo/Pip 24-shot 226 s storybook film).",
      advisoryAcknowledgements: [],
    },
  }, 201);
  log("[seed] story approved");

  // Canon selection pins are resolved AFTER the canon revisions exist (ids above).
  const plan = (await postJson(`/api/production/projects/${seeded.projectId}/shot-plans`, {
    projectId: seeded.projectId, storyRevisionId: story.id, approvedStoryHash: story.contentHash,
    shots: STORY.shots.map((shot, index) => ({
      shotId: shot.shotId, beatIds: [shot.beatId],
      visualIntent: shot.visualIntent, motionIntent: shot.motionIntent,
      castBindings: castFor(index, canon),
      locationRevisionId: canon.location.id,
      propRevisionIds: [], styleRevisionId: canon.style.id,
      framing: shot.framing, targetFrames: SHOT_FRAMES, continuation: null,
    })),
  }, 201)).body;
  seeded.plan = plan;
  log(`[seed] LONG shot plan ${plan.shotPlanRevision.id} with ${plan.shotRevisions.length} shot revisions (x ${SHOT_FRAMES} frames), animatic ${plan.animaticRevision.id} (totalFrames ${plan.animaticRevision.totalFrames})`);

  if (plan.shotRevisions.length !== SHOT_COUNT) {
    throw new PilotStop(`Seeded plan holds ${plan.shotRevisions.length} shots, expected ${SHOT_COUNT} (the long film has no 6-shot ceiling).`, { kind: "shape" });
  }
  if (plan.animaticRevision.totalFrames !== TOTAL_FRAMES) {
    throw new PilotStop(`Animatic pins ${plan.animaticRevision.totalFrames} frames but the frozen long fixture requires exactly ${TOTAL_FRAMES} (${SHOT_COUNT} x ${SHOT_FRAMES}).`, { kind: "shape" });
  }
  for (const shotRevision of plan.shotRevisions) {
    if (!h3Legal(shotRevision.targetFrames)) {
      throw new PilotStop(`Shot ${shotRevision.shotId} targetFrames ${shotRevision.targetFrames} is not on the H3 grid (124 + 17n, max 362); takes would be unrenderable.`, { kind: "shape" });
    }
  }
  log(`[seed] profile ${PROFILE_ID} targetFrames ${PROFILE_TARGET_FRAMES} is the planning target; schema pins only the shot-sum ${TOTAL_FRAMES} (surveyed lib/production/contracts.ts + lib/services/production/shot-plan.ts)`);

  for (const [kind, target] of [["shotplan", plan.shotPlanRevision], ["animatic", plan.animaticRevision]]) {
    await postJson("/api/production/approvals", {
      projectId: seeded.projectId, idempotencyKey: `pilot-${runId}-${kind}-approval`,
      command: {
        targetKind: kind, targetId: target.id, expectedHash: target.contentHash, decision: "approved",
        checklist: checklistFor(kind, modeLabel),
        notes: `${kind} approved for the C14 long-landscape pilot.`,
        advisoryAcknowledgements: [],
      },
    }, 201);
    log(`[seed] ${kind} approved`);
  }
  return seeded;
}

/* ------------------------------ RED report (preflight) ---------------------- */

const blockers = [];
const offlineWalk = [];
function recordOffline(step, state, detail) {
  offlineWalk.push({ step, state, detail });
  log(`[walk] ${state.toUpperCase()} ${step}${detail ? ` — ${detail}` : ""}`);
}
function recordBlocker(code, step, message, hint) {
  blockers.push({ code, step, message, hint });
  log(`[BLOCKER] ${code} at ${step}: ${message}`);
  log(`          hint: ${hint}`);
}

/** Client-side 48 kHz pre-probe shared by --preflight (offline walk) and --final (before any spend). */
function probeCreatorAudio(narrations, music, sfx) {
  if (narrations.length !== STORY.beats.length) {
    throw new PilotStop(`--narration must be given exactly ${STORY.beats.length} times (one 48 kHz file per narrated beat, in beat order); received ${narrations.length}.`, { kind: "input" });
  }
  if (!music) throw new PilotStop("--music <file> is required: the film pilot requires a narration bed, music and at least one SFX cue (QUALITY_GATES pilot protocol).", { kind: "input" });
  if (sfx.length < 1) throw new PilotStop("At least one --sfx <file> is required: the film pilot requires at least one deliberate SFX cue (QUALITY_GATES pilot protocol).", { kind: "input" });
  if (sfx.length > SHOT_COUNT - 1) throw new PilotStop(`At most ${SHOT_COUNT - 1} SFX files can be placed (one per shot boundary after the first).`, { kind: "input" });
  const audioInputs = [];
  for (const [label, file] of [...narrations.map((f) => ["narration", f]), ["music", music], ...sfx.map((f) => ["sfx", f])]) {
    if (!existsSync(file)) throw new PilotStop(`${label} file does not exist: ${file}`, { kind: "input" });
    const bytes = readFileSync(file);
    const samples = audioSamples(bytes);
    if (samples === null) throw new PilotStop(`${label} file ${file} is not a parsable 48 kHz 16-bit PCM WAV or 48 kHz MPEG-1 Layer III MP3 (the import route rejects anything else).`, { kind: "input" });
    audioInputs.push({ label, file: resolve(file), bytes, samples });
  }
  const narrationInputs = audioInputs.slice(0, STORY.beats.length);
  const musicInput = audioInputs[STORY.beats.length];
  const sfxInputs = audioInputs.slice(STORY.beats.length + 1);
  const slotSamples = SHOT_FRAMES * SAMPLES_PER_FRAME;
  narrationInputs.forEach((input, index) => {
    if (input.samples > slotSamples) {
      throw new PilotStop(`Narration ${index + 1} (${input.file}) is ${input.samples} samples (${(input.samples / 48_000).toFixed(1)}s) but its ${SHOT_FRAMES}-frame shot slot allows at most ${slotSamples}; re-time or trim the file.`, { kind: "input" });
    }
  });
  if (musicInput.samples < TOTAL_SAMPLES) {
    log(`[audio] NOTE: music bed ${musicInput.file} spans ${(musicInput.samples / 48_000).toFixed(1)}s of the ${(TOTAL_SAMPLES / 48_000).toFixed(1)}s timeline; the mix pins it to the first ${(musicInput.samples / 48_000).toFixed(1)}s. For the release long film supply a full-length bed.`);
  }
  for (const input of sfxInputs) {
    if (input.samples > TOTAL_SAMPLES) throw new PilotStop(`SFX ${input.file} is longer than the ${TOTAL_SAMPLES}-sample timeline; use a shorter file.`, { kind: "input" });
  }
  return { narrationInputs, musicInput, sfxInputs };
}

async function runPreflight() {
  log(`PREFLIGHT (offline RED walk) against ${BASE}; artifacts: ${outDir}`);
  const health = await fetchJson("/api/production/health");
  if (!health.ok) {
    console.error(`BLOCKED: no healthy production server at ${BASE} (HTTP ${health.status}).`);
    console.error("start:   PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> npx next dev -p 3100");
    process.exit(1);
  }
  recordOffline("health", "ok", `storage ${health.body.storage}, worker available ${health.body.worker.available}`);
  if (!health.body.worker.available) {
    recordBlocker("WORKER_OFFLINE", "health", "No live production worker heartbeat is visible.", "Start the worker with the live env: PERABYTE_STUDIO_DATA_DIR=<dir> SOGNI_API_KEY=... npm run studio:worker");
  }

  // Optional creator-audio pre-probe inside the offline walk (no import happens in preflight).
  const audioGiven = args.narrations.length > 0 || !!args.music || args.sfx.length > 0;
  if (audioGiven) {
    try {
      const probed = probeCreatorAudio(args.narrations, args.music, args.sfx);
      recordOffline(`creator-audio pre-probe (48 kHz headers + ${SHOT_FRAMES}-frame slot math)`, "ok",
        `${probed.narrationInputs.length} narrations, 1 music bed (${(probed.musicInput.samples / 48_000).toFixed(1)}s), ${probed.sfxInputs.length} sfx`);
    } catch (error) {
      recordOffline("creator-audio pre-probe", "FAILED", String(error).replace(/\s+/g, " ").slice(0, 300));
      console.error("\nThe creator-audio pre-probe failed — this is a true failure, not the expected RED state.");
      console.error(String(error));
      process.exit(1);
    }
  } else {
    recordBlocker("NARRATION_ASSETS_ABSENT", "assets/import + audio mix", "The final film requires creator-supplied narration (one file per narrated beat), music and at least one SFX file; none were provided to preflight.", "Prepare 48 kHz WAV/MP3 files and pass --narration/--music/--sfx (the C14 preflight accepts the C13 48 kHz placeholders).");
  }

  let seeded = null;
  let pagination = null;
  try {
    seeded = await seedWorkflow(`Long landscape pilot (preflight RED) ${runId}`, "Preflight offline seed walk of the frozen C14 long fixture");
    recordOffline("seed:project/canon/story/approvals/LONG-shot-plan", "ok", `project ${seeded.projectId}, story ${seeded.story.id}, plan ${seeded.plan.shotPlanRevision.id} (${SHOT_COUNT} shots x ${SHOT_FRAMES} frames)`);
    pagination = await assertLongPlanInvariants(seeded.projectId);
    recordOffline("long-plan pagination/order stability", "ok", `${pagination.pages} pages of ${pagination.pageSize} across two independent reads; orderedShotRevisionIds match; animatic gapless; totalFrames ${pagination.totalFrames}`);
  } catch (error) {
    recordOffline("seed", "FAILED", String(error).replace(/\s+/g, " ").slice(0, 300));
    console.error("\nThe offline seeding walk failed — this is a true failure, not the expected RED state.");
    console.error(String(error));
    process.exit(1);
  }

  // Budget identity availability (both scopes; identity resolution is scope-independent).
  for (const scope of ["unit=spark_token", "unit=minor_currency&currency=USD"]) {
    const budget = await fetchJson(`/api/production/projects/${seeded.projectId}/budget?providerId=${PROVIDER_ID}&${scope}`);
    if (!budget.ok) {
      recordBlocker("BUDGET_READ_FAILED", `budget?${scope}`, envelopeOf(budget).message, "Without SOGNI_API_KEY the provider composition blocks the budget read (often a bare 500 from the composition layer). Start the server with the live env, install the reviewed policy (B6-POLICY-LOAD) and authorize the project.");
      continue;
    }
    const reasons = Array.isArray(budget.body.reasons) ? budget.body.reasons : [];
    if (budget.body.availability === "available" && reasons.length === 0) {
      recordOffline(`budget identity (${scope})`, "ok", "identity + policy + authorization resolved (unexpected in offline RED)");
    } else {
      recordBlocker("BUDGET_IDENTITY_UNAVAILABLE", `budget?${scope}`,
        `availability ${budget.body.availability}; reasons: ${reasons.join(", ") || "none reported"}`,
        "The standing policy authorization is PER-PROJECT: authorize this freshly seeded project via the budget routes (docs/production/pilots/long-landscape.md section 4) after starting the server with SOGNI_API_KEY and the reviewed policy (B6-POLICY-LOAD).");
    }
  }

  // Media quote: observe the exact closed paid path without ever enqueueing.
  const firstShot = seeded.plan.shotRevisions[0];
  const quoteBody = {
    kind: "anchor",
    command: {
      projectId: seeded.projectId, shotRevisionId: firstShot.id,
      renderSettings: { providerId: PROVIDER_ID, modelId: args.anchorModel, aspect: ASPECT, resolution: ANCHOR_RESOLUTION, seed: args.seedBase, referenceAssetIds: [] },
    },
  };
  try {
    const quote = await postJson("/api/production/media-quotes", quoteBody);
    const body = quote.body;
    if (body?.entitlement === "unknown" || body?.withinAuthorizedCap !== "yes") {
      recordBlocker("QUOTE_NOT_BOUND", "media-quotes (anchor)", `quote ${body?.id} is entitlement=${body?.entitlement}, withinAuthorizedCap=${body?.withinAuthorizedCap}; the paid path is closed.`, "Install the reviewed policy (B6-POLICY-LOAD) and authorize the project; rerun preflight, then use --final.");
    } else {
      recordOffline("media-quotes (anchor)", "ok", `BOUND quote ${body.id} unexpectedly succeeded in preflight; enqueue intentionally NOT sent`);
    }
  } catch (error) {
    const envelope = error.detail?.envelope;
    recordBlocker("MEDIA_QUOTE_BLOCKED", "media-quotes (anchor)",
      envelope ? `HTTP ${envelope.status} ${envelope.code} — ${envelope.message}` : String(error).replace(/\s+/g, " ").slice(0, 200),
      "This is the expected offline RED: quote composition needs the reviewed billing policy (B6-POLICY-LOAD) plus live provider evidence and per-project authorization. No paid enqueue is ever sent in preflight.");
  }

  recordBlocker("PAID_ENQUEUE_WITHHELD", "anchors enqueue", "Preflight never sends a paid enqueue by construction (48 anchors + 48 takes would be the long-film spend).", "Use --final with the env gate satisfied and a bound quote; the standing authorization is per-project.");
  recordBlocker("ANCHOR_APPROVAL_UNAVAILABLE", "approvals (anchor)", "No anchor candidate can exist without a completed live render.", "Run --final after policy install and project authorization.");
  recordBlocker("TAKE_CHAIN_UNAVAILABLE", "media-quotes/enqueue/approve (take)", "Takes require an approved anchor and live provider capacity.", "Run --final after policy install and project authorization.");
  recordBlocker("SELECTION_UNAVAILABLE", "shots/[shotId]/selection", "No approved take exists to select.", "Run --final after policy install and project authorization.");
  if (!audioGiven) {
    recordBlocker("AUDIO_APPROVAL_UNAVAILABLE", "approvals (audio)", "No audio mix revision can exist without imported creator audio.", "Run --final after policy install with the audio files.");
  } else {
    recordBlocker("AUDIO_PIPELINE_WITHHELD", "assets/import + audio mix", "Creator audio passed the offline pre-probe, but preflight never imports assets or saves the mix; that happens in --final after the shots are produced.", "Run --final with the same audio flags.");
  }
  recordBlocker("MANIFEST_EXPORT_QC_UNAVAILABLE", "manifests/exports/run_qc", "Manifest compilation requires selected approved takes; export/QC require the rendered artifact.", "Run --final after policy install.");
  recordBlocker("FINAL_REVIEW_UNAVAILABLE", "final review + download", "The human G09 review and checksum-bound download require an approved export.", "Run --final, then perform the step-8 creator review.");

  const report = {
    packet: "C14-PILOT-SCRIPT",
    mode: "preflight",
    base: BASE,
    recordedAt: nowIso(),
    expectedState: "RED",
    projectId: seeded.projectId,
    artifactsDir: outDir,
    fixture: {
      profileId: PROFILE_ID, format: "16:9", shots: SHOT_COUNT, shotFrames: SHOT_FRAMES,
      totalFrames: TOTAL_FRAMES, durationSeconds: TOTAL_FRAMES / FPS,
      profileTargetFrames: PROFILE_TARGET_FRAMES,
      profileTargetNote: "profile targetFrames (5760) is the planning target; the shot-plan/animatic schemas pin only the gapless shot sum, which this fixture asserts as 24 x 226 = 5424 (surveyed lib/production/contracts.ts, lib/services/production/shot-plan.ts)",
      h3Grid: "124 + 17n, max 362 (226 = 124 + 17*6)",
    },
    pagination,
    offlineWalk,
    blockers,
    exitMeaning: "exit 0 with recorded blockers = the contract RED state (offline walk succeeded; live-dependent steps are blocked)",
  };
  writeFileSync(join(outDir, "preflight-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n=== PREFLIGHT RED REPORT (exit 0) ===`);
  console.log(`offline walk: ${offlineWalk.filter((entry) => entry.state === "ok").length} ok / ${offlineWalk.length} steps`);
  console.log(`long plan: ${SHOT_COUNT} shots x ${SHOT_FRAMES} frames = ${TOTAL_FRAMES} frames (${(TOTAL_FRAMES / FPS).toFixed(0)}s) on ${PROFILE_ID}; pagination stable across ${pagination.pages} pages x 2 reads`);
  console.log(`blockers: ${blockers.length}`);
  for (const blocker of blockers) console.log(`  - [${blocker.code}] ${blocker.step}: ${blocker.message}`);
  console.log(`report: ${join(outDir, "preflight-report.json")}`);
  process.exit(0);
}

/* --------------------- restart/resume batch state (C14) --------------------- */

function batchStatePathFor(completedCount) {
  return join(outDir, `pilot-batch-state-after-${completedCount}-shots.json`);
}

function saveBatchState(seeded, shotStates, restartedAfterShot) {
  const path = batchStatePathFor(shotStates.length);
  const state = {
    kind: "pilot-long-landscape-batch",
    runId: BATCH_RUN_ID, mode: "batch", base: BASE, profileId: PROFILE_ID,
    projectId: seeded.projectId, storyRevisionId: seeded.story.id,
    // The fresh-run plan is the POST shot-plans response ({ shotRevisions, shotPlanRevision, animaticRevision });
    // the resume path builds the same ids as plain strings. Normalize BOTH shapes so the state file
    // always carries non-empty revision ids (C14-RESUME-FIX: a pre-fix state saved neither id, which
    // made every --resume fail the story/plan/animatic verification pre-spend).
    shotPlanRevisionId: seeded.plan.shotPlanRevision?.id ?? seeded.plan.shotPlanRevisionId, animaticRevisionId: seeded.plan.animaticRevision?.id ?? seeded.plan.animaticRevisionId,
    completedShots: shotStates, nextShotIndex: shotStates.length,
    audio: { narrations: args.narrations.map((file) => resolve(file)), music: args.music ? resolve(args.music) : null, sfx: args.sfx.map((file) => resolve(file)) },
    models: { anchor: args.anchorModel, take: args.takeModel },
    seedBase: args.seedBase,
    restartedAfterShot, paidLogPath, outDir, savedAt: nowIso(),
  };
  if (typeof state.shotPlanRevisionId !== "string" || state.shotPlanRevisionId.length === 0 ||
      typeof state.animaticRevisionId !== "string" || state.animaticRevisionId.length === 0) {
    throw new PilotStop(`Refusing to save a batch state without non-empty shotPlanRevisionId/animaticRevisionId (plan keys: ${Object.keys(seeded.plan ?? {}).sort().join(", ") || "none"}); a resume could never verify the batch's plan identity.`, { kind: "shape" });
  }
  try {
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    throw new PilotStop(`Could not save the batch state file ${path} (noclobber): ${String(error).replace(/\s+/g, " ")}. Reuse a fresh --out-dir or remove the stale batch state file first.`, { kind: "input" });
  }
  return path;
}

function loadBatchState(filePath) {
  let state;
  try {
    state = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new PilotStop(`--resume file ${filePath} is not readable batch state: ${String(error).replace(/\s+/g, " ").slice(0, 160)}`, { kind: "input" });
  }
  if (!state || typeof state !== "object" || state.kind !== "pilot-long-landscape-batch" || state.mode !== "batch" || !state.projectId || !Array.isArray(state.completedShots)) {
    throw new PilotStop(`${filePath} is not a C14 batch state file saved by --restart-after-shot.`, { kind: "input" });
  }
  if (typeof state.storyRevisionId !== "string" || state.storyRevisionId.length === 0 ||
      typeof state.shotPlanRevisionId !== "string" || state.shotPlanRevisionId.length === 0 ||
      typeof state.animaticRevisionId !== "string" || state.animaticRevisionId.length === 0) {
    throw new PilotStop(`${filePath} is missing a non-empty storyRevisionId, shotPlanRevisionId or animaticRevisionId; a resume must verify that the project still runs this batch's story/plan/animatic (batch states saved before the C14-RESUME-FIX carried no plan/animatic ids and cannot be resumed — re-run the batch boundary).`, { kind: "input" });
  }
  if (state.nextShotIndex !== state.completedShots.length || state.completedShots.length < 1 || state.completedShots.length > SHOT_COUNT) {
    throw new PilotStop(`${filePath} records ${state.completedShots.length} completed shots (nextShotIndex ${state.nextShotIndex}); a resumable batch covers 1..${SHOT_COUNT}. A full-coverage state resumes straight into the audio/manifest/export tail.`, { kind: "input" });
  }
  return state;
}

function verifyCompletedShots(model, completedShots) {
  for (const shotState of completedShots) {
    const readShot = model.shots.find((entry) => entry.shotRevision.id === shotState.shotRevisionId);
    if (!readShot || readShot.shotRevision.shotId !== shotState.shotId) {
      throw new PilotStop(`Completed shot ${shotState.shotId} (${shotState.shotRevisionId}) is missing or reordered in the read model; refusing to resume.`, { kind: "shape" });
    }
    if (readShot.takeSelection.takeId !== shotState.takeId) {
      throw new PilotStop(`Completed shot ${shotState.shotId} now selects ${readShot.takeSelection.takeId ?? "nothing"}, but the batch state recorded take ${shotState.takeId}; refusing to resume over a changed selection.`, { kind: "shape" });
    }
    if (!approvedApprovalFor(readShot, "take", shotState.takeId)) {
      throw new PilotStop(`Completed shot ${shotState.shotId} has no approved take approval for ${shotState.takeId} in the read model; refusing to resume.`, { kind: "shape" });
    }
  }
}

/* ------------------------------ live final mode ----------------------------- */

function assertBoundQuote(quote, label) {
  if (!quote || typeof quote.id !== "string") throw new PilotStop(`${label}: media quote response has no id.`, { kind: "shape" });
  if (quote.entitlement === "unknown" || quote.withinAuthorizedCap !== "yes") {
    throw new PilotStop(`${label}: quote ${quote.id} is not a BOUND quote (entitlement=${quote.entitlement}, withinAuthorizedCap=${quote.withinAuthorizedCap}). Refusing to enqueue paid work — install the reviewed policy and project authorization first.`, { kind: "quote", quote });
  }
  return quote;
}

const BAD_TERMINAL_JOB_STATUSES = ["failed", "canceled", "submission_unknown", "blocked"];
function findJobByIdempotencyKey(model, key) {
  return model.jobs.find((job) => job.idempotencyKey === key) ?? null;
}

function shotListFromModel(model) {
  return model.shots.map((entry) => ({ id: entry.shotRevision.id, shotId: entry.shotRevision.shotId, targetFrames: entry.shotRevision.targetFrames }));
}

async function selectShotTake(projectId, shotState) {
  // The selection version is project-global CAS state; read it fresh per selection so a resumed
  // process never replays a stale version recorded by a dead process.
  const selectionVersion = (await readProject(projectId)).project.takeSelectionVersion;
  const selection = (await postJson(`/api/production/shots/${shotState.shotId}/selection`, {
    projectId, shotRevisionId: shotState.shotRevisionId, takeId: shotState.takeId, expectedSelectionVersion: selectionVersion,
  }, 200)).body;
  return selection.selection.version;
}

async function produceAndApproveAnchor(seeded, shot, index) {
  const renderSettings = { providerId: PROVIDER_ID, modelId: args.anchorModel, aspect: ASPECT, resolution: ANCHOR_RESOLUTION, seed: seeded.seedBase + index * 2, referenceAssetIds: [] };
  // Idempotency keys derive from the BATCH run id (stable across --resume processes), so a job
  // enqueued before a hard kill is recovered by polling instead of double-spent on re-enqueue.
  const idempotencyKey = `pilot-${seeded.batchRunId}-anchor-${shot.shotId}`;
  let model = await readProject(seeded.projectId);
  let job = findJobByIdempotencyKey(model, idempotencyKey);
  let created = true;
  let quoteId = null;
  let quoteEntitlement = null;
  let enqueueStarted = Date.now();
  if (job) {
    created = false;
    enqueueStarted = Date.now();
    if (BAD_TERMINAL_JOB_STATUSES.includes(job.status)) {
      throw new PilotStop(`Anchor job ${job.id} for ${shot.shotId} already reached terminal status ${job.status} in an earlier batch; the script never retries a paid enqueue — reconcile manually (see paid-steps and the anchors UI).`, { kind: "job_terminal", job, step: "anchor resume" });
    }
    log(`[anchor] ${shot.shotId} recovering job ${job.id} from an earlier batch (status ${job.status}); NO new enqueue is sent`);
  } else {
    const quoteStarted = nowIso();
    const quote = assertBoundQuote((await postJson("/api/production/media-quotes", { kind: "anchor", command: { projectId: seeded.projectId, shotRevisionId: shot.id, renderSettings } })).body, `anchor quote for ${shot.shotId}`);
    quoteId = quote.id;
    quoteEntitlement = quote.entitlement;
    log(`[anchor] ${shot.shotId} bound quote ${quote.id} (entitlement ${quote.entitlement}, estimate ${quote.estimateMinMinor}..${quote.estimateMaxMinor} ${quote.currency ?? quote.entitlement})`);
    paidLog({ step: "media-quote:anchor", quoteId: quote.id, providerId: quote.providerId, modelId: quote.modelId, billingMode: quote.entitlement, wallTimeNote: `quoted at ${quoteStarted}` });
    enqueueStarted = Date.now();
    const { body: enqueue } = await postJson(`/api/production/shots/${shot.shotId}/anchors`, {
      projectId: seeded.projectId, shotRevisionId: shot.id, quoteId: quote.id,
      idempotencyKey, renderSettings,
    }, 201);
    job = enqueue.job;
    created = enqueue.created !== false;
    log(`[anchor] ${shot.shotId} job ${job.id} queued (created=${enqueue.created})`);
  }
  const completed = await pollJob(job.id, `anchor ${shot.shotId}`, args.jobTimeoutMinutes);
  paidLog({
    step: created ? "enqueue+render:anchor" : "enqueue+render:anchor:replay", replayed: !created,
    jobId: job.id, providerId: completed.providerId, modelId: completed.modelId,
    providerRef: completed.providerRef, billingMode: created ? quoteEntitlement : "replayed_no_new_enqueue",
    quoteId: created ? quoteId : completed.quoteId,
    resultAssetIds: completed.resultAssetIds, wallTimeMs: Date.now() - enqueueStarted,
  });

  model = await readProject(seeded.projectId);
  const readShot = resolveShotModels(model, shot.id);
  const anchor = latestByJobId(readShot.anchorHistory, job.id);
  if (!anchor) throw new PilotStop(`Completed anchor job ${job.id} has no anchor candidate in the read model.`, { kind: "shape" });
  const visionStatus = anchor.visionAssessment?.status ?? "unavailable";
  let approval = approvedApprovalFor(readShot, "anchor", anchor.id);
  if (approval) {
    log(`[anchor] ${shot.shotId} anchor ${anchor.id} was already approved (${approval.id}) in an earlier batch; keeping that approval`);
  } else {
    const expectedHash = anchorApprovalHash(anchor, assetSha256(anchor.assetId));
    const acks = visionStatus === "pass" ? [] : [{
      code: `vision_${visionStatus}`,
      reason: `Vision advisory was "${visionStatus}" for anchor ${anchor.id}; the supervising creator performed the identity/wardrobe/location/props/framing checks visually in the anchors UI before approving.`,
    }];
    await creatorGate(`approve ANCHOR ${anchor.id} for ${shot.shotId} (asset ${anchor.assetId}, vision ${visionStatus}) — inspect ${BASE}/production/${seeded.projectId}/anchors`);
    approval = (await postJson("/api/production/approvals", {
      projectId: seeded.projectId, idempotencyKey: `pilot-${seeded.batchRunId}-anchor-approval-${shot.shotId}`,
      command: {
        targetKind: "anchor", targetId: anchor.id, expectedHash, decision: "approved",
        checklist: checklistFor("anchor", `Supervised pilot review of anchor ${anchor.id} (${shot.shotId})`),
        notes: `Anchor approved during the C14 supervised pilot run ${seeded.batchRunId}; job ${job.id}, asset ${anchor.assetId}, vision ${visionStatus}.`,
        advisoryAcknowledgements: acks,
      },
    }, 201)).body.approval;
  }
  log(`[anchor] ${shot.shotId} approved (${approval.id})`);
  return { anchor, anchorJob: job, anchorApproval: approval, visionStatus };
}

async function produceAndApproveTake(seeded, shot, index, anchorOutcome) {
  const motionSettings = {
    providerId: PROVIDER_ID, modelId: args.takeModel,
    prompt: `${shot.visualIntent} Motion: ${shot.motionIntent} Keep the approved anchor's composition, identity and storybook style.`,
    targetFrames: shot.targetFrames, aspect: ASPECT, seed: seeded.seedBase + index * 2 + 1,
  };
  const idempotencyKey = `pilot-${seeded.batchRunId}-take-${shot.shotId}`;
  let model = await readProject(seeded.projectId);
  let job = findJobByIdempotencyKey(model, idempotencyKey);
  let created = true;
  let quoteId = null;
  let quoteEntitlement = null;
  let enqueueStarted = Date.now();
  if (job) {
    created = false;
    enqueueStarted = Date.now();
    if (BAD_TERMINAL_JOB_STATUSES.includes(job.status)) {
      throw new PilotStop(`Take job ${job.id} for ${shot.shotId} already reached terminal status ${job.status} in an earlier batch; the script never retries a paid enqueue — reconcile manually (see paid-steps and the takes UI).`, { kind: "job_terminal", job, step: "take resume" });
    }
    log(`[take] ${shot.shotId} recovering job ${job.id} from an earlier batch (status ${job.status}); NO new enqueue is sent`);
  } else {
    const quote = assertBoundQuote((await postJson("/api/production/media-quotes", {
      kind: "take",
      command: { projectId: seeded.projectId, shotRevisionId: shot.id, anchorId: anchorOutcome.anchor.id, approvalId: anchorOutcome.anchorApproval.id, motionSettings },
    })).body, `take quote for ${shot.shotId}`);
    quoteId = quote.id;
    quoteEntitlement = quote.entitlement;
    log(`[take] ${shot.shotId} bound quote ${quote.id} (entitlement ${quote.entitlement})`);
    paidLog({ step: "media-quote:take", quoteId: quote.id, providerId: quote.providerId, modelId: quote.modelId, billingMode: quote.entitlement });
    enqueueStarted = Date.now();
    const { body: enqueue } = await postJson(`/api/production/shots/${shot.shotId}/takes`, {
      projectId: seeded.projectId, shotRevisionId: shot.id, anchorId: anchorOutcome.anchor.id,
      approvalId: anchorOutcome.anchorApproval.id, quoteId: quote.id,
      idempotencyKey, motionSettings,
    }, 201);
    job = enqueue.job;
    created = enqueue.created !== false;
    log(`[take] ${shot.shotId} job ${job.id} queued (created=${enqueue.created})`);
  }
  const completed = await pollJob(job.id, `take ${shot.shotId}`, args.jobTimeoutMinutes);
  paidLog({
    step: created ? "enqueue+render:take" : "enqueue+render:take:replay", replayed: !created,
    jobId: job.id, providerId: completed.providerId, modelId: completed.modelId,
    providerRef: completed.providerRef, billingMode: created ? quoteEntitlement : "replayed_no_new_enqueue",
    quoteId: created ? quoteId : completed.quoteId,
    resultAssetIds: completed.resultAssetIds, wallTimeMs: Date.now() - enqueueStarted,
  });

  model = await readProject(seeded.projectId);
  const readShot = resolveShotModels(model, shot.id);
  const take = latestByJobId(readShot.takeHistory, job.id);
  if (!take) throw new PilotStop(`Completed take job ${job.id} has no take record in the read model.`, { kind: "shape" });
  if (take.actualFrames < shot.targetFrames) {
    throw new PilotStop(`Take ${take.id} has ${take.actualFrames} frames, shorter than the approved ${shot.targetFrames}-frame shot length; compilation would fail. Reject/retake manually.`, { kind: "shape" });
  }
  let approval = approvedApprovalFor(readShot, "take", take.id);
  if (approval) {
    log(`[take] ${shot.shotId} take ${take.id} was already approved (${approval.id}) in an earlier batch; keeping that approval`);
  } else {
    const expectedHash = takeApprovalHash(take, assetSha256(take.assetId));
    await creatorGate(`approve TAKE ${take.id} for ${shot.shotId} (asset ${take.assetId}, ${take.actualFrames} frames) — watch ${BASE}/production/${seeded.projectId}/takes`);
    approval = (await postJson("/api/production/approvals", {
      projectId: seeded.projectId, idempotencyKey: `pilot-${seeded.batchRunId}-take-approval-${shot.shotId}`,
      command: {
        targetKind: "take", targetId: take.id, expectedHash, decision: "approved",
        checklist: checklistFor("take", `Supervised pilot review of take ${take.id} (${shot.shotId})`),
        notes: `Take approved during the C14 supervised pilot run ${seeded.batchRunId}; job ${job.id}, asset ${take.assetId}, ${take.actualFrames} frames.`,
        advisoryAcknowledgements: [],
      },
    }, 201)).body.approval;
  }
  log(`[take] ${shot.shotId} approved (${approval.id})`);
  return { take, takeJob: job, takeApproval: approval };
}

function buildCuePlan(importedNarrations, importedMusic, importedSfx) {
  const cues = [];
  STORY.beats.forEach((beat, index) => {
    const asset = importedNarrations[index];
    const slotEnd = index < STORY.beats.length - 1 ? shotStartSample(index + 1) : TOTAL_SAMPLES;
    const end = shotStartSample(index) + asset.samples;
    if (end > slotEnd) {
      throw new PilotStop(`Narration ${index + 1} (${asset.file}) is ${asset.samples} samples (${(asset.samples / 48_000).toFixed(1)}s) but its beat slot allows at most ${slotEnd - shotStartSample(index)} samples; re-time or trim the file so each beat's narration fits its ${SHOT_FRAMES}-frame shot.`, { kind: "input" });
    }
    cues.push({
      assetId: asset.asset.id, sourceStartSample: 0, sourceEndSample: asset.samples,
      timelineStartSample: shotStartSample(index), gainDb: 0, role: "narration",
      scriptSegmentId: beat.id, sourceText: beat.narration, sourceRights: "creator_attested",
    });
  });
  if (importedMusic) {
    const span = Math.min(importedMusic.samples, TOTAL_SAMPLES);
    cues.push({ assetId: importedMusic.asset.id, sourceStartSample: 0, sourceEndSample: span, timelineStartSample: 0, gainDb: -16, role: "music", scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested" });
  }
  importedSfx.forEach((asset, index) => {
    const shotIndex = index + 1;
    if (shotIndex >= SHOT_COUNT) throw new PilotStop(`Only ${SHOT_COUNT - 1} SFX files can be placed (one per shot boundary after the first).`, { kind: "input" });
    const end = shotStartSample(shotIndex) + asset.samples;
    if (end > TOTAL_SAMPLES) throw new PilotStop(`SFX ${asset.file} would end past the ${TOTAL_SAMPLES}-sample timeline; use a shorter file.`, { kind: "input" });
    cues.push({ assetId: asset.asset.id, sourceStartSample: 0, sourceEndSample: asset.samples, timelineStartSample: shotStartSample(shotIndex), gainDb: -12, role: "sfx", scriptSegmentId: null, sourceText: null, sourceRights: "creator_attested" });
  });
  return cues;
}

function printRestartBlock(savedPath, shotStates) {
  console.log(`
==============================================================================
 BATCH BOUNDARY — ${shotStates.length}/${SHOT_COUNT} shots complete (anchor + take approved, take selected)
==============================================================================
 Restart drill (docs/production/pilots/long-landscape.md section 5):
  1. Stop the worker now (Ctrl-C in the worker shell).
  2. Restart it with the same env: PERABYTE_STUDIO_DATA_DIR=<dir> SOGNI_API_KEY=... \\
     PERABYTE_STUDIO_REVIEWED_POLICY_PATH=... npm run studio:worker
  3. Resume the run from shot ${shotStates.length + 1}:
     node scripts/pilot-long-landscape.mjs --final ${BASE} \\
       --resume ${savedPath} \\
       --out-dir ${outDir}${args.dataDir ? ` \\\n       --data-dir ${args.dataDir}` : ""}${args.yes ? " \\\n       --yes" : ""}
 The resume re-checks the env gate, health, worker heartbeat and budget identity,
 verifies every completed shot's approval + selection in the read model, re-asserts
 long-plan pagination/order stability, and continues from shot ${shotStates.length + 1}.
 Batch state: ${savedPath}
 Paid-step ledger so far: ${paidLogPath}
==============================================================================`);
  log(`STOPPED cleanly at the batch boundary after shot ${shotStates.length} (exit 0).`);
}

async function runFinal() {
  log(`FINAL (live) against ${BASE}; artifacts: ${outDir}`);
  const env = { key: "set", policy: process.env.PERABYTE_STUDIO_REVIEWED_POLICY_PATH };

  // Batch-resume state (local input; validated before any request beyond the health check below).
  let resumeState = null;
  if (args.resume) {
    resumeState = loadBatchState(args.resume);
    BATCH_RUN_ID = resumeState.runId;
    // Deterministic continuation: the saved batch's models/seeds/audio are authoritative.
    if (resumeState.models?.anchor) args.anchorModel = resumeState.models.anchor;
    if (resumeState.models?.take) args.takeModel = resumeState.models.take;
    if (Number.isSafeInteger(resumeState.seedBase)) args.seedBase = resumeState.seedBase;
    const stateAudio = resumeState.audio ?? {};
    const flagsMatchState = (flagFiles, stateFiles) => flagFiles.length === stateFiles.length && flagFiles.every((file, index) => resolve(file) === stateFiles[index]);
    const flagsGiven = args.narrations.length > 0 || !!args.music || args.sfx.length > 0;
    if (Array.isArray(stateAudio.narrations) && stateAudio.narrations.length > 0) {
      if (flagsGiven && (!flagsMatchState(args.narrations, stateAudio.narrations) || resolve(args.music ?? "") !== stateAudio.music || !flagsMatchState(args.sfx, stateAudio.sfx ?? []))) {
        throw new PilotStop("--resume: the audio flags given do not match the files recorded in the batch state; the mix must be built from the exact provenance recorded at the batch boundary. Re-run with the state's files or without audio flags.", { kind: "input" });
      }
      args.narrations = stateAudio.narrations;
      args.music = stateAudio.music;
      args.sfx = stateAudio.sfx ?? [];
    }
    if (typeof resumeState.paidLogPath === "string" && existsSync(resumeState.paidLogPath)) {
      paidLogPath = resumeState.paidLogPath;
      paidSteps = readFileSync(paidLogPath, "utf8").split("\n").filter((line) => line.trim().length > 0).length;
    }
    if (args.restartAfterShot !== null && args.restartAfterShot <= resumeState.completedShots.length) {
      throw new PilotStop(`--restart-after-shot ${args.restartAfterShot} is not ahead of the resumed progress (${resumeState.completedShots.length} shots already complete).`, { kind: "input" });
    }
    log(`RESUME of batch run ${resumeState.runId}: project ${resumeState.projectId}, ${resumeState.completedShots.length}/${SHOT_COUNT} shots complete; continuing from shot ${resumeState.completedShots.length + 1}`);
  }

  // Step 1: preflight-lite — health + worker heartbeat BEFORE anything else.
  const health = await fetchJson("/api/production/health");
  if (!health.ok) {
    console.error(`BLOCKED: no healthy production server at ${BASE} (HTTP ${health.status}).`);
    console.error("start:   PERABYTE_STUDIO_DATA_DIR=<fresh tmpdir> SOGNI_API_KEY=... PERABYTE_STUDIO_REVIEWED_POLICY_PATH=... npx next dev -p 3100");
    console.error("worker:  PERABYTE_STUDIO_DATA_DIR=<same dir> SOGNI_API_KEY=... PERABYTE_STUDIO_REVIEWED_POLICY_PATH=... npm run studio:worker");
    process.exit(1);
  }
  if (health.body.storage !== "ready") throw new PilotStop(`Server storage is ${health.body.storage}; fix the data dir before the pilot.`, { kind: "health" });
  if (!health.body.worker.available) {
    throw new PilotStop("No live production worker heartbeat. Start the worker with the same env before the pilot: PERABYTE_STUDIO_DATA_DIR=<dir> SOGNI_API_KEY=... PERABYTE_STUDIO_REVIEWED_POLICY_PATH=... npm run studio:worker", { kind: "health" });
  }
  log(`[1] health ok (worker heartbeat ${health.body.worker.heartbeatAgeMs}ms; env: key ${env.key}, policy ${env.policy})`);

  // Creator-audio pre-probe BEFORE any paid call (fail-closed before spend). On resume the file
  // list comes from the batch state, so the tail process uses the exact recorded provenance.
  const probed = probeCreatorAudio(args.narrations, args.music, args.sfx);
  for (const input of [...probed.narrationInputs.map((entry) => ["narration", entry]), ["music", probed.musicInput], ...probed.sfxInputs.map((entry) => ["sfx", entry])]) {
    log(`[1] ${input[0]} ${input[1].file}: ${input[1].samples} samples (${(input[1].samples / 48_000).toFixed(1)}s)`);
  }

  // Step 2: seed (fresh) or verify the recorded batch state (resume).
  let seeded;
  if (resumeState) {
    const model = await readProject(resumeState.projectId);
    if (model.project.activeStoryRevisionId !== resumeState.storyRevisionId ||
        model.project.activeShotPlanRevisionId !== resumeState.shotPlanRevisionId ||
        model.project.activeAnimaticRevisionId !== resumeState.animaticRevisionId) {
      throw new PilotStop(`Project ${resumeState.projectId} no longer runs the batch's story/plan/animatic (active story ${model.project.activeStoryRevisionId}, plan ${model.project.activeShotPlanRevisionId}); refusing to resume.`, { kind: "shape" });
    }
    verifyCompletedShots(model, resumeState.completedShots);
    const pagination = await assertLongPlanInvariants(resumeState.projectId);
    log(`[2] resume verified: story/plan/animatic still active; ${resumeState.completedShots.length} completed shots intact (approvals + selections); pagination stable across ${pagination.pages} pages`);
    seeded = {
      projectId: resumeState.projectId, story: { id: resumeState.storyRevisionId },
      // Object form mirrors the fresh-run POST shot-plans response shape, so every downstream
      // reader (manifest POST, step-8 state, G02 printout) sees the same seeded.plan shape on
      // both paths (C14-RESUME-FIX: the string-form fields crashed the tail after paid renders).
      plan: { shotPlanRevision: { id: resumeState.shotPlanRevisionId }, animaticRevision: { id: resumeState.animaticRevisionId }, shotRevisions: shotListFromModel(model) },
      batchRunId: resumeState.runId, seedBase: args.seedBase, completedShots: resumeState.completedShots,
    };
  } else {
    log("[2] seeding project, canon, story, approvals and the LONG shot plan");
    const fresh = await seedWorkflow(`Long landscape pilot ${runId}`, "Supervised live pilot seed walk of the frozen C14 long fixture");
    const pagination = await assertLongPlanInvariants(fresh.projectId);
    log(`[2] seeded project ${fresh.projectId}; long plan asserted: ${pagination.pages} pages of ${pagination.pageSize} shots, order stable across independent reads`);
    seeded = { ...fresh, batchRunId: runId, seedBase: args.seedBase, completedShots: [] };
  }

  // Budget identity: must resolve on THIS project BEFORE any media quote or enqueue (fail-closed
  // ordering; the standing authorization is per-project). While waiting, only read-only budget
  // GETs are sent so the operator can authorize mid-run.
  const budgetScopes = ["unit=spark_token", "unit=minor_currency&currency=USD"];
  const authorizeHint = `authorize this project now via the budget routes (POST ${BASE}/api/production/projects/${seeded.projectId}/budget) — see docs/production/pilots/long-landscape.md section 4`;
  const checkBudgetScope = async (scope) => {
    const budget = await fetchJson(`/api/production/projects/${seeded.projectId}/budget?providerId=${PROVIDER_ID}&${scope}`);
    if (budget.ok && budget.body.availability === "available" && (!Array.isArray(budget.body.reasons) || budget.body.reasons.length === 0)) {
      const policy = budget.body.policy;
      log(`[1] budget identity resolved via ${scope} (policy ${policy?.policyId ?? "n/a"}, dailyCap ${policy?.dailyCap ?? "n/a"} ${policy?.unit ?? ""})`);
      return true;
    }
    const reasons = budget.ok ? (budget.body.reasons ?? []).join(", ") : envelopeOf(budget).message;
    log(`[1] budget scope ${scope}: unavailable (${reasons})`);
    return false;
  };
  let identityResolved = false;
  for (const scope of budgetScopes) {
    if (await checkBudgetScope(scope)) { identityResolved = true; break; }
  }
  if (!identityResolved && args.budgetWaitSeconds > 0) {
    const deadline = Date.now() + args.budgetWaitSeconds * 1000;
    for (let attempt = 1; !identityResolved && Date.now() < deadline; attempt += 1) {
      const waitSeconds = Math.round(Math.min(15_000, deadline - Date.now()) / 1000);
      log(`[1] budget identity unavailable for project ${seeded.projectId}: waiting ${waitSeconds}s before re-check ${attempt}. ${authorizeHint}. No media quote or enqueue is sent while waiting (fail-closed ordering).`);
      await sleep(waitSeconds * 1000);
      for (const scope of budgetScopes) {
        if (await checkBudgetScope(scope)) { identityResolved = true; break; }
      }
    }
  }
  if (!identityResolved) {
    const waitedNote = args.budgetWaitSeconds > 0 ? ` after ${args.budgetWaitSeconds}s of re-checks` : " (immediate stop per --budget-wait-seconds 0)";
    throw new PilotStop(`Budget identity did not resolve on the seeded project ${seeded.projectId}${waitedNote} (stop before any enqueue). ${authorizeHint}; also install the reviewed policy (B6-POLICY-LOAD) and start the server/worker with SOGNI_API_KEY so live account observation works. See docs/production/pilots/long-landscape.md.`, { kind: "budget" });
  }

  // Steps 3+4 fused per shot: BOUND quote -> anchor -> poll -> gate, take -> poll -> gate,
  // then IMMEDIATE selection, so every completed shot is a safe restart boundary.
  const shotStates = [...seeded.completedShots];
  for (let index = shotStates.length; index < SHOT_COUNT; index += 1) {
    const shot = seeded.plan.shotRevisions[index];
    log(`[3] shot ${index + 1}/${SHOT_COUNT} (${shot.shotId}, ${shot.targetFrames} frames)`);
    const anchorOutcome = await produceAndApproveAnchor(seeded, shot, index);
    const takeOutcome = await produceAndApproveTake(seeded, shot, index, anchorOutcome);
    const shotState = { shotId: shot.shotId, shotRevisionId: shot.id, targetFrames: shot.targetFrames, anchorId: anchorOutcome.anchor.id, anchorApprovalId: anchorOutcome.anchorApproval.id, anchorJobId: anchorOutcome.anchorJob.id, takeId: takeOutcome.take.id, takeApprovalId: takeOutcome.takeApproval.id, takeJobId: takeOutcome.takeJob.id, selected: false };
    const selectionVersion = await selectShotTake(seeded.projectId, shotState);
    shotState.selected = true;
    shotStates.push(shotState);
    log(`[4] ${shot.shotId} -> take ${shotState.takeId} (selection version ${selectionVersion})`);
    if (args.restartAfterShot !== null && shotStates.length === args.restartAfterShot) {
      const savedPath = saveBatchState(seeded, shotStates, args.restartAfterShot);
      printRestartBlock(savedPath, shotStates);
      process.exit(0);
    }
  }
  log(`[4] all ${SHOT_COUNT} shots produced, approved and selected`);

  // Step 5: narration import + audio mix aligned to the 24 beat slots.
  log("[5] importing creator audio and saving the beat-aligned audio mix");
  const importedNarrations = [];
  for (let index = 0; index < probed.narrationInputs.length; index += 1) {
    const input = probed.narrationInputs[index];
    const asset = await importMedia(input.file, `narration beat ${index + 1}`);
    log(`[5] narration ${index + 1} imported as asset ${asset.id} (${asset.audioSamples} samples)`);
    importedNarrations.push({ asset, samples: asset.audioSamples, file: input.file });
  }
  const musicAsset = await importMedia(probed.musicInput.file, "music bed");
  log(`[5] music imported as asset ${musicAsset.id} (${musicAsset.audioSamples} samples)`);
  const importedSfx = [];
  for (let index = 0; index < probed.sfxInputs.length; index += 1) {
    const asset = await importMedia(probed.sfxInputs[index].file, `sfx ${index + 1}`);
    log(`[5] sfx ${index + 1} imported as asset ${asset.id} (${asset.audioSamples} samples)`);
    importedSfx.push({ asset, samples: asset.audioSamples, file: probed.sfxInputs[index].file });
  }
  const cues = buildCuePlan(importedNarrations, { asset: musicAsset, samples: musicAsset.audioSamples }, importedSfx);
  const mixModel = await readProject(seeded.projectId);
  const mix = (await postJson(`/api/production/projects/${seeded.projectId}/audio`, {
    projectId: seeded.projectId, expectedAudioVersion: mixModel.project.audioMixVersion,
    expectedStoryRevisionId: seeded.story.id, cues, mixSettings: { ...MIX_SETTINGS },
  }, 201)).body;
  log(`[5] audio mix ${mix.revision.id} saved (active=${mix.active}, cues=${mix.revision.cues.length}, contentHash ${mix.revision.contentHash.slice(0, 12)}...)`);

  // Step 6: audio approval.
  await creatorGate(`approve the AUDIO MIX ${mix.revision.id} (${mix.revision.cues.length} cues) — listen at ${BASE}/production/${seeded.projectId}/audio`);
  await postJson("/api/production/approvals", {
    projectId: seeded.projectId, idempotencyKey: `pilot-${seeded.batchRunId}-audio-approval`,
    command: {
      targetKind: "audio", targetId: mix.revision.id, expectedHash: mix.revision.contentHash, decision: "approved",
      checklist: checklistFor("audio", `Supervised pilot review of audio mix ${mix.revision.id}`),
      notes: `Audio approved during the C14 supervised pilot run ${seeded.batchRunId}: creator narration per beat, music bed, ${importedSfx.length} SFX cue(s); provider audio muted.`,
      advisoryAcknowledgements: [],
    },
  }, 201);
  log("[6] audio approved");

  // Step 7: manifest + export + poll + run_qc.
  log("[7] compiling the manifest and starting the export");
  const manifest = (await postJson(`/api/production/projects/${seeded.projectId}/manifests`, {
    projectId: seeded.projectId, shotPlanRevisionId: seeded.plan.shotPlanRevision.id,
    animaticRevisionId: seeded.plan.animaticRevision.id, audioMixRevisionId: mix.revision.id,
    selectedTakeIds: shotStates.map((state) => state.takeId), profileId: PROFILE_ID,
    expectedSelectionVersion: (await readProject(seeded.projectId)).project.takeSelectionVersion,
  }, 201)).body.manifest;
  log(`[7] manifest ${manifest.id} (${manifest.shots.length} shots, ${manifest.audioCues.length} audio cues, inputsHash ${manifest.inputsHash.slice(0, 12)}...)`);
  const exportRecord = (await postJson(`/api/production/projects/${seeded.projectId}/exports`, {
    projectId: seeded.projectId, manifestId: manifest.id, expectedManifestHash: manifest.inputsHash,
    idempotencyKey: `pilot-${seeded.batchRunId}-export`,
  }, 202)).body;
  log(`[7] export ${exportRecord.id} (${exportRecord.status})`);

  const exportDeadline = Date.now() + args.exportTimeoutMinutes * 60_000;
  let detail = null;
  while (Date.now() < exportDeadline) {
    const response = await fetchJson(`/api/production/exports/${exportRecord.id}?projectId=${seeded.projectId}`);
    if (!response.ok) throw new PilotStop(`Export detail poll failed: ${envelopeOf(response).message}`, { kind: "envelope", step: "export poll" });
    detail = response.body;
    log(`[7] export ${exportRecord.id} status ${detail.export.status}`);
    if (detail.export.status === "qc_pending" || ["qc_failed", "ready_for_review", "approved", "failed", "canceled"].includes(detail.export.status)) break;
    await sleep(10_000);
  }
  if (detail?.export?.status !== "qc_pending") {
    const failure = detail?.failure ? ` Failure: ${detail.failure.code} at ${detail.failure.stage} — ${detail.failure.redactedStderr.slice(0, 300)}` : "";
    throw new PilotStop(`Export ${exportRecord.id} did not reach qc_pending within ${args.exportTimeoutMinutes} minutes (status ${detail?.export?.status}).${failure}`, { kind: "timeout", step: "export render" });
  }
  log("[7] running technical QC");
  const qc = (await postJson(`/api/production/exports/${exportRecord.id}`, { kind: "run_qc" }, 200)).body;
  const passed = qc.report.verdict === "passed" && qc.exportRecord.status === "ready_for_review";
  paidLog({ step: "export+qc", jobId: qc.exportRecord.jobId, quoteId: null, providerId: PROVIDER_ID, modelId: "local-ffmpeg", providerRef: qc.exportRecord.assetId, billingMode: "local_assembly", resultAssetIds: qc.exportRecord.assetId ? [qc.exportRecord.assetId] : [] });
  if (!passed) {
    writeFileSync(join(outDir, "qc-report-failed.json"), `${JSON.stringify(qc.report, null, 2)}\n`);
    throw new PilotStop(`Technical QC FAILED for export ${exportRecord.id}: blockers ${qc.report.blockers.map((b) => b.code).join(", ") || "unknown"}. Report saved to ${join(outDir, "qc-report-failed.json")}. The draft artifact stays inspectable; fix the named stage and retry.`, { kind: "qc_failed" });
  }
  log(`[7] QC passed (output sha256 ${qc.report.outputSha256.slice(0, 12)}..., advisories: ${qc.report.advisories.length})`);
  for (const advisory of qc.report.advisories) log(`[7] advisory ${advisory.code}: ${advisory.message}`);

  // Step 8: STOP for the human act.
  const state = {
    kind: "pilot-long-landscape-final", runId, batchRunId: seeded.batchRunId, mode: "final", base: BASE,
    profileId: PROFILE_ID, projectId: seeded.projectId,
    storyRevisionId: seeded.story.id, shotPlanRevisionId: seeded.plan.shotPlanRevision.id,
    animaticRevisionId: seeded.plan.animaticRevision.id, mixRevisionId: mix.revision.id,
    manifestId: manifest.id, manifestInputsHash: manifest.inputsHash,
    exportId: exportRecord.id, outputSha256: qc.report.outputSha256,
    advisoryCodes: qc.report.advisories.map((advisory) => advisory.code),
    shots: shotStates, models: { anchor: args.anchorModel, take: args.takeModel },
    outDir, savedAt: nowIso(),
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`
==============================================================================
 STEP 8 — HUMAN FINAL REVIEW (the film is rendered and QC-passed; the script stops)
==============================================================================
 Export:          ${exportRecord.id}   status: ready_for_review
 Output sha256:   ${qc.report.outputSha256}
 Download URL:    ${BASE}/api/production/exports/${exportRecord.id}/download?projectId=${seeded.projectId}
 Review UI:       ${BASE}/production/${seeded.projectId}/export
 Project:         ${seeded.projectId}

 CREATOR, DO THE HUMAN ACT NOW (G09 — QUALITY_GATES.md):
  1. Download the exact final bytes from the URL above (or the Export page) and
     reopen them in an independent player. Watch the full ${(TOTAL_FRAMES / FPS / 60).toFixed(0)} minutes (${TOTAL_FRAMES / FPS} seconds) end to end.
  2. Walk the G01-G09 checklist below on THIS checksum (not an earlier preview).
  3. Write your review evidence file (non-empty; must name narrative, visual,
     audio, captions${qc.report.advisories.length > 0 ? "; must include an \"ack <code>: <reason>\" line for EVERY advisory: " + qc.report.advisories.map((a) => a.code).join(", ") : ""}).
  4. Record the approval and download the verified final bytes:
     node scripts/pilot-long-landscape.mjs --final ${BASE} \\
       --state ${statePath} --creator-approved <your-review-file> --out-dir ${outDir}

 G01-G09 CHECKLIST (docs/production/QUALITY_GATES.md) — recorded against checksum ${qc.report.outputSha256.slice(0, 12)}...
  G01 Canon        character/location/style revisions approved; rights recorded   -> seeded canon ${seeded.canon?.characterMilo?.id ?? "(from batch run)"}/${seeded.canon?.location?.id ?? ""}/${seeded.canon?.style?.id ?? ""} + creator supervision
  G02 Story/plan   every approved beat covered; exact narration preserved          -> story ${seeded.story.id}, plan ${seeded.plan.shotPlanRevision.id} (human-approved)
  G03 Anchors      identity/wardrobe/location/props/framing true per shot          -> ${shotStates.length} anchor approvals (vision acks recorded where applicable)
  G04 Submission   quote/scope/cap authorized before every spend                   -> BOUND quotes logged in ${paidLogPath}
  G05 Takes        decodable; identity/action/motion/artifacts accepted            -> ${shotStates.length} take approvals
  G06 Audio        spoken lines present; rights attested; mix approved             -> audio approval on ${mix.revision.id}
  G07 Manifest     accepted takes only; deterministic hash; timeline exact         -> manifest ${manifest.id}
  G08 Export       full decode; profile dimensions/fps/codecs; loudness/peak; checksum -> QC report passed (${qc.report.outputSha256})
  G09 Final review creator watches the exact downloadable bytes and approves        -> YOU, now

 State for the resume command: ${statePath}
==============================================================================`);
  log("STOPPED for the human final review (exit 0). No final approval was recorded by the script.");
  process.exit(0);
}

/* ------------------------- resume: step 8 approve + 9 ----------------------- */

function parseCreatorEvidence(filePath, advisoryCodes) {
  let text;
  try { text = readFileSync(filePath, "utf8"); } catch (error) {
    throw new PilotStop(`--creator-approved file ${filePath} is unreadable: ${String(error).replace(/\s+/g, " ")}`, { kind: "input" });
  }
  if (!text.trim()) throw new PilotStop(`--creator-approved file ${filePath} is empty; the human review evidence must be written down.`, { kind: "input" });
  const lower = text.toLowerCase();
  for (const id of FINAL_REVIEW_CHECKLIST_IDS) {
    if (!lower.includes(id)) {
      throw new PilotStop(`--creator-approved file ${filePath} never mentions "${id}"; the creator evidence must address all four final checks: ${FINAL_REVIEW_CHECKLIST_IDS.join(", ")}.`, { kind: "input" });
    }
  }
  const acks = [];
  for (const code of advisoryCodes) {
    const line = text.split("\n").find((candidate) => {
      const trimmed = candidate.trim().toLowerCase();
      return trimmed.startsWith(`ack ${code}:`) || trimmed.startsWith(`ack:${code}:`) || trimmed.startsWith(`ack ${code} `) || trimmed.startsWith(`ack:${code} `);
    });
    const colonIndex = line ? line.indexOf(":") : -1;
    const reason = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : null;
    if (!line || !reason) {
      throw new PilotStop(`--creator-approved file ${filePath} has no "ack ${code}: <reason>" line; QC reported advisory "${code}" and approval requires an explicit human acknowledgment with a reason.`, { kind: "input" });
    }
    acks.push({ code, reason });
  }
  return { text, acks };
}

async function runFinalResume() {
  if (!args.state) throw new PilotStop("--creator-approved requires --state <the pilot-state.json saved at the step-8 stop>.", { kind: "input" });
  let state;
  try {
    state = JSON.parse(readFileSync(args.state, "utf8"));
  } catch (error) {
    throw new PilotStop(`--state file ${args.state} is not readable pilot-state.json: ${String(error).replace(/\s+/g, " ").slice(0, 160)}`, { kind: "input" });
  }
  if (!state || typeof state !== "object" || state.mode !== "final" || !state.exportId || !state.projectId) {
    throw new PilotStop(`${args.state} is not a step-8 pilot state file (mode=${state?.mode}).`, { kind: "input" });
  }
  if (state.profileId !== PROFILE_ID) {
    throw new PilotStop(`${args.state} was saved by a ${state.profileId} run; this script resumes only ${PROFILE_ID} (16:9 long) runs.`, { kind: "input" });
  }
  log(`RESUME of final run ${state.runId ?? "unknown"}: export ${state.exportId}, output sha256 ${typeof state.outputSha256 === "string" ? state.outputSha256.slice(0, 12) : "unknown"}...`);
  const detailResponse = await fetchJson(`/api/production/exports/${state.exportId}?projectId=${state.projectId}`);
  if (!detailResponse.ok) throw new PilotStop(`Export detail read failed: ${envelopeOf(detailResponse).message}`, { kind: "envelope", step: "resume detail" });
  const detail = detailResponse.body;
  if (detail.export.status !== "ready_for_review") {
    throw new PilotStop(`Export ${state.exportId} is ${detail.export.status}, not ready_for_review; the human final review runs only from ready_for_review.`, { kind: "shape" });
  }
  if (!detail.qcReport || detail.qcReport.verdict !== "passed") {
    throw new PilotStop(`Export ${state.exportId} has no passed QC report; run technical QC again.`, { kind: "shape" });
  }
  const expectedSha = detail.qcReport.outputSha256;
  if (detail.export.status === "approved") {
    // A prior resume already recorded this exact approval; the checksum-bound download is what remains.
    if (detail.export.approvedSha256 !== expectedSha) {
      throw new PilotStop(`Export ${state.exportId} is approved against sha256 ${detail.export.approvedSha256}, which no longer matches the QC report output ${expectedSha}; a re-encode requires a new QC and review.`, { kind: "shape" });
    }
    log("[8] final review was already recorded (exact replay) for checksum " + expectedSha);
  } else {
    const evidence = parseCreatorEvidence(args.creatorApproved, detail.qcReport.advisories.map((advisory) => advisory.code));
    const evidenceSha = sha256Hex(Buffer.from(evidence.text, "utf8"));
    log(`[8] creator evidence ${args.creatorApproved} (sha256 ${evidenceSha.slice(0, 12)}..., ${evidence.acks.length} advisory ack(s))`);
    await postJson(`/api/production/exports/${state.exportId}`, {
      kind: "final_review",
      idempotencyKey: `pilot-${state.runId}-final-review`,
      decision: "approved",
      checklist: FINAL_REVIEW_CHECKLIST_IDS.map((id) => ({ id, passed: true, note: `Creator watched the exact downloadable bytes (${expectedSha.slice(0, 12)}...) and checked ${id}; evidence ${basename(args.creatorApproved)} sha256 ${evidenceSha.slice(0, 16)}...` })),
      notes: `G09 human final review recorded from creator evidence file ${resolve(args.creatorApproved)} (sha256 ${evidenceSha}). Pilot run ${state.runId}.`,
      advisoryAcknowledgements: evidence.acks,
      expectedOutputSha256: expectedSha,
    }, 201);
    log("[8] final review APPROVED and bound to checksum " + expectedSha);
  }

  // Step 9: download the final bytes, sha256, ffprobe reopen probe against the 16:9 long profile.
  const download = await fetch(`${BASE}/api/production/exports/${state.exportId}/download?projectId=${state.projectId}`, { cache: "no-store" }).catch((error) => { throw new PilotStop(`Final download failed at the network layer: ${String(error).replace(/\s+/g, " ")}`, { kind: "network" }); });
  if (!download.ok) {
    throw new PilotStop(`Final download returned HTTP ${download.status}: ${await download.text().catch(() => "")}`, { kind: "download" });
  }
  const bytes = Buffer.from(await download.arrayBuffer());
  const downloadedSha = sha256Hex(bytes);
  if (downloadedSha !== expectedSha) {
    throw new PilotStop(`DOWNLOADED BYTES DO NOT MATCH the approved checksum (${downloadedSha} != ${expectedSha}). The file was NOT verified; do not treat it as the film.`, { kind: "checksum" });
  }
  const finalPath = join(outDir, `pilot-final-${state.exportId}.mp4`);
  writeFileSync(finalPath, bytes, { flag: "wx" });
  log(`[9] final bytes ${finalPath} (${bytes.length} bytes, sha256 ${downloadedSha}) — checksum matches the approved export`);

  const ffprobe = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const probe = spawnSync(ffprobe, [
    "-v", "error", "-count_frames", "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,sample_rate,channels:format=format_name,duration",
    "-of", "json", finalPath,
  ], { encoding: "utf8", timeout: 120_000 });
  if (probe.error || probe.status !== 0) {
    throw new PilotStop(`Reopen probe failed: ffprobe ${probe.error ? String(probe.error) : `exit ${probe.status}`}: ${(probe.stderr || "").slice(0, 300)}`, { kind: "probe" });
  }
  const parsed = JSON.parse(probe.stdout);
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video");
  const audio = (parsed.streams ?? []).find((stream) => stream.codec_type === "audio");
  const frames = Number(video?.nb_read_frames ?? "0");
  const reopen = {
    file: finalPath, sha256: downloadedSha, bytes: bytes.length,
    container: parsed.format?.format_name ?? "unknown",
    durationSeconds: parsed.format?.duration ?? null,
    video: video ? { codec: video.codec_name, width: video.width, height: video.height, pixFmt: video.pix_fmt, avgFrameRate: video.avg_frame_rate, frames } : null,
    audio: audio ? { codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels } : null,
    profileExpected: { ...EXPECTED_VIDEO, frames: TOTAL_FRAMES },
    dimensionOk: video?.width === EXPECTED_VIDEO.width && video?.height === EXPECTED_VIDEO.height,
    fpsOk: video?.avg_frame_rate === `${FPS}/1`,
    framesOk: Math.abs(frames - TOTAL_FRAMES) <= 1,
  };
  writeFileSync(join(outDir, "reopen-probe.json"), `${JSON.stringify(reopen, null, 2)}\n`);
  log(`[9] reopen probe: ${reopen.container} ${video?.width}x${video?.height} ${video?.codec_name} ${video?.avg_frame_rate} fps, ${frames} frames, audio ${audio?.codec_name ?? "none"} ${audio?.sample_rate ?? "-"} Hz`);
  if (!reopen.dimensionOk || !reopen.fpsOk || !reopen.framesOk) {
    throw new PilotStop(`Reopen probe disagrees with the frozen 16:9 long profile (expected ${EXPECTED_VIDEO.width}x${EXPECTED_VIDEO.height} ${EXPECTED_VIDEO.videoCodec} ${FPS}fps ~${TOTAL_FRAMES} frames; see ${join(outDir, "reopen-probe.json")}).`, { kind: "probe" });
  }
  console.log(`
==============================================================================
 PILOT COMPLETE — the exact final downloadable bytes reopened and verified.
  file:        ${finalPath}
  sha256:      ${downloadedSha}
  container:   ${reopen.container}  duration: ${reopen.durationSeconds}s
  video:       ${video.width}x${video.height} ${video.codec_name} ${video.avg_frame_rate} fps (${frames} frames)
  audio:       ${audio ? `${audio.codec_name} ${audio.sample_rate} Hz ${audio.channels}ch` : "none"}
 Archive (see docs/production/pilots/long-landscape.md): this log (redacted), ${paidLogPath},
 ${join(outDir, "reopen-probe.json")}, ${statePath}, the QC report, creator evidence ${resolve(args.creatorApproved)}, and UI screenshots.
==============================================================================`);
}

/* ---------------------------------- main ------------------------------------ */

try {
  if (args.mode === "preflight") await runPreflight();
  else if (args.creatorApproved) await runFinalResume();
  else await runFinal();
} catch (error) {
  const stop = error instanceof PilotStop;
  console.error(`\n${stop ? "PILOT STOPPED" : "PILOT CRASHED"}: ${String(error.message ?? error)}`);
  if (stop && error.detail?.envelope) {
    const envelope = error.detail.envelope;
    console.error(`envelope: HTTP ${envelope.status} ${envelope.code} (requestId ${envelope.requestId})`);
  }
  if (stop && error.detail?.kind === "job_terminal") {
    console.error("Stop condition: terminal job failure. The job keeps its recorded provenance; reconcile manually — the script never retries a paid enqueue.");
  }
  if (!stop) console.error(error.stack ?? "");
  if (paidSteps > 0) console.error(`paid-step log for reconciliation: ${paidLogPath}`);
  console.error(`run artifacts: ${outDir}`);
  process.exit(1);
}

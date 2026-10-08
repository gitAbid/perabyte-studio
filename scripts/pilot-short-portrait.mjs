#!/usr/bin/env node
/**
 * C13 short-portrait pilot orchestration (scripts/pilot-short-portrait.mjs).
 *
 * Drives the EXISTING accepted production HTTP surface end to end for the 30-60s 9:16 pilot film
 * (docs/production/TASK_PACKETS.md C13, docs/production/reports/C13-PILOT-SCRIPT-root-freeze.json).
 * It invents no endpoints, imports no lib modules (node builtins + global fetch only) and never
 * retries a paid enqueue.
 *
 * Modes:
 *   node scripts/pilot-short-portrait.mjs --preflight [baseURL]
 *       Offline RED walk against a local dev server WITHOUT SOGNI_API_KEY. Executes every
 *       offline-capable step (health, seeding, approvals) and records each live-dependent step
 *       as a structured BLOCKER. Never sends a paid enqueue. Exits 0 with the blockers report
 *       (the contract's expected RED state).
 *   node scripts/pilot-short-portrait.mjs --final [baseURL] [flags]
 *       Live end-to-end run. FAILS CLOSED before anything else unless BOTH SOGNI_API_KEY and
 *       PERABYTE_STUDIO_REVIEWED_POLICY_PATH are set in this shell (the server must be started
 *       with the same env). Sequence: (1) preflight-lite (health + worker + budget identity),
 *       (2) seed project/canon/story/approvals/shot-plan (6 shots x 192 frames = 48s, H3 grid),
 *       (3) per shot: media quote (BOUND assert) -> anchor enqueue -> poll -> creator approval,
 *           then take quote -> enqueue -> poll -> creator approval,
 *       (4) take selection per shot, (5) narration import + audio mix save, (6) audio approval,
 *       (7) manifest + export + poll + run_qc + verify QC passed,
 *       (8) STOP: print the G01-G09 checklist + download URL (the human act); with
 *           --creator-approved <file> --state <file> the script records the final-review POST
 *           and (9) downloads the final bytes, verifies sha256 and runs an ffprobe reopen probe.
 *
 * Human approvals (anchor, take, audio) are interactive y/N gates on a TTY; in a non-TTY the run
 * stops with instructions unless --yes records the creator's explicit supervised-run acknowledgment.
 *
 * Creator-side hash note (frozen C08 read-model gap): the read model does not export asset
 * sha256, so the FIRST anchor/take approval hash is computed client-side from read-model fields
 * plus a read-only lookup of the local production store (node:sqlite). The server approval route
 * recomputes the hash and remains the only validation truth. See docs/production/pilots/short-portrait.md.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";

/* ------------------------------ frozen fixtures ------------------------------ */

const PROFILE_ID = "storybook-short-v1";
const FPS = 24;
const SAMPLES_PER_FRAME = 2_000; // lib/production/manifest.ts MANIFEST_SAMPLES_PER_FRAME
const SHOT_FRAMES = 192; // H3 grid: 124 + 17*4; ARCHITECTURE.md: "Short pilot: 6 shots x 192 frames = 48 seconds"
const SHOT_COUNT = 6;
const TOTAL_FRAMES = SHOT_COUNT * SHOT_FRAMES; // 1152 frames = 48s (within the 720-1440 contract window)
const TOTAL_SAMPLES = TOTAL_FRAMES * SAMPLES_PER_FRAME;
const PROVIDER_ID = "sogni";
const DEFAULT_ANCHOR_MODEL = "flux1-schnell-fp8";
const DEFAULT_TAKE_MODEL = "minimax-h3-fl2va-fp8_i2v";
const ANCHOR_RESOLUTION = "1080p";
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

const STORY = Object.freeze({
  scriptText: [
    "Milo and Pip and the morning apple.",
    "",
    "At the edge of the meadow, Milo the mouse wakes to the first light of dawn.",
    "He climbs the winding hill path to find the perfect morning apple.",
    "There he meets Pip the rabbit, waiting by the old stone well.",
    "Pip smiles and shares her apple, because friends make small things plenty.",
    "Together they watch the meadow wake, the wind combed gold across the grass.",
    "And paw in paw, the two small friends walk home into the bright new day.",
  ].join("\n"),
  beats: [
    { id: "beat_dawn", action: "Milo wakes in his hilltop burrow at dawn.", narration: "At the edge of the meadow, Milo the mouse wakes to the first light of dawn." },
    { id: "beat_path", action: "Milo climbs the winding hill path.", narration: "He climbs the winding hill path to find the perfect morning apple." },
    { id: "beat_meet", action: "Milo meets Pip by the old stone well.", narration: "There he meets Pip the rabbit, waiting by the old stone well." },
    { id: "beat_share", action: "Pip shares her apple with Milo.", narration: "Pip smiles and shares her apple, because friends make small things plenty." },
    { id: "beat_watch", action: "They watch the meadow wake together.", narration: "Together they watch the meadow wake, the wind combed gold across the grass." },
    { id: "beat_home", action: "The two friends walk home together.", narration: "And paw in paw, the two small friends walk home into the bright new day." },
  ],
  canon: {
    characterMilo: { entityId: "char_milo_pilot", entityKind: "character", description: "Milo, a small brown field mouse with round ears, a cream belly and a red knit scarf.", wardrobe: "Red knit scarf" },
    characterPip: { entityId: "char_pip_pilot", entityKind: "character", description: "Pip, a young grey rabbit with long ears, a white tail and a blue ribbon at her ear.", wardrobe: "Blue ribbon" },
    location: { entityId: "loc_meadow_pilot", entityKind: "location", description: "A golden hilltop meadow at dawn with a winding path, Milo's burrow mound and an old stone well." },
    style: { entityId: "style_watercolor_pilot", entityKind: "style", description: "Soft watercolor storybook style, warm morning palette, gentle ink outlines, painterly light." },
  },
  shots: [
    { shotId: "shot_1", beatId: "beat_dawn", framing: "medium", visualIntent: "Milo opens his eyes in his cozy burrow as dawn light spills in.", motionIntent: "Slow push-in as Milo blinks awake and stretches." },
    { shotId: "shot_2", beatId: "beat_path", framing: "wide", visualIntent: "Milo climbs the winding hill path above the golden meadow.", motionIntent: "Gentle lateral tracking as Milo walks uphill." },
    { shotId: "shot_3", beatId: "beat_meet", framing: "medium_wide", visualIntent: "Milo arrives at the old stone well where Pip the rabbit waits.", motionIntent: "Milo approaches; Pip turns and waves a greeting." },
    { shotId: "shot_4", beatId: "beat_share", framing: "close", visualIntent: "Pip breaks the apple in half and offers one half to Milo.", motionIntent: "Two-shot close on the shared apple; small warm smiles." },
    { shotId: "shot_5", beatId: "beat_watch", framing: "extreme_wide", visualIntent: "Milo and Pip sit side by side on the hilltop watching the meadow wake.", motionIntent: "Static wide as wind combs the grass gold around them." },
    { shotId: "shot_6", beatId: "beat_home", framing: "wide", visualIntent: "The two small friends walk home along the path into the bright new day.", motionIntent: "Slow pull-away as they walk off together." },
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
  console.log(`C13 short-portrait pilot orchestration

Usage:
  node scripts/pilot-short-portrait.mjs --preflight [baseURL]
      Offline RED walk (no SOGNI_API_KEY needed). Never sends a paid enqueue.
      Exits 0 with the structured blockers report.

  node scripts/pilot-short-portrait.mjs --final [baseURL] [flags]
      Live run. Fail-closed env gate: requires SOGNI_API_KEY and
      PERABYTE_STUDIO_REVIEWED_POLICY_PATH in this shell (start the server and
      worker with the same env). Flags:
        --narration <file>     one creator narration file per narrated beat, in beat
                               order (repeat the flag; count must match the beats)
        --music <file>         creator music bed (one file, spans the timeline)
        --sfx <file>           creator SFX accent; the i-th file accents shot i+1
                               (repeatable, max SHOT_COUNT-1)
        --anchor-model <id>    image model covered by the reviewed policy
                               (default ${DEFAULT_ANCHOR_MODEL})
        --take-model <id>      H3 video model covered by the reviewed policy
                               (default ${DEFAULT_TAKE_MODEL})
        --data-dir <dir>       server's PERABYTE_STUDIO_DATA_DIR (read-only creator-side
                               asset checksum lookup for first approval hashes)
        --out-dir <dir>        run artifact directory (default: fresh temp dir)
        --job-timeout-minutes <n>    per-job poll budget (default 15)
        --export-timeout-minutes <n> export render budget (default 30)
        --budget-wait-seconds <n>    budget-gate wait budget: when the seeded project's
                               budget read model is still unavailable, re-check both
                               scopes every 15s for up to <n> seconds so the operator
                               can authorize the project mid-run (default 600;
                               0 restores the immediate stop). No media quote or
                               enqueue is ever sent before a scope resolves available.
        --seed-base <n>        deterministic seed base (default 11)
        --yes                  non-TTY acknowledgment that the creator supervises approvals
        --state <file>         resume: load step state saved at the step-8 stop
        --creator-approved <file>  resume: creator's written final-review evidence
                               (must name narrative/visual/audio/captions and give an
                               "ack <advisory-code>: <reason>" line per QC advisory)
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { mode: null, base: null, narrations: [], sfx: [], music: null, creatorApproved: null, state: null, outDir: null, yes: false, dataDir: process.env.PERABYTE_STUDIO_DATA_DIR?.trim() || null, anchorModel: DEFAULT_ANCHOR_MODEL, takeModel: DEFAULT_TAKE_MODEL, jobTimeoutMinutes: 15, exportTimeoutMinutes: 30, budgetWaitSeconds: 600, seedBase: 11 };
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
  for (const [flag, key] of [["--base", "base"], ["--creator-approved", "creatorApproved"], ["--state", "state"], ["--out-dir", "outDir"], ["--data-dir", "dataDir"], ["--anchor-model", "anchorModel"], ["--take-model", "takeModel"], ["--music", "music"]]) {
    const value = needValue(flag);
    if (value !== null) args[key] = value;
  }
  while (argv.includes("--narration")) args.narrations.push(needValue("--narration"));
  while (argv.includes("--sfx")) args.sfx.push(needValue("--sfx"));
  for (const flag of ["--job-timeout-minutes", "--export-timeout-minutes", "--seed-base"]) {
    const raw = needValue(flag);
    if (raw !== null) {
      const key = flag === "--job-timeout-minutes" ? "jobTimeoutMinutes" : flag === "--export-timeout-minutes" ? "exportTimeoutMinutes" : "seedBase";
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) { console.error(`ERROR: ${flag} must be a positive integer.`); usage(2); }
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
  // C13 review finding: `--state <file>` without `--creator-approved <file>` must never fall
  // through into a brand-new live run (the saved step-8 state would be silently ignored).
  if (args.state && !args.creatorApproved) {
    console.error("REFUSING TO RUN --final: --state <file> was given without --creator-approved <file>.");
    console.error("A resume of the recorded run needs BOTH flags; starting without --creator-approved would seed a NEW project and ignore the saved state.");
    console.error(`  resume:  node scripts/pilot-short-portrait.mjs --final <baseURL> --state ${args.state} --creator-approved <your-review-file> --out-dir <run-artifacts>`);
    console.error("If you really intend a brand-new run, omit --state. No request was sent.");
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
const outDir = args.outDir ? resolve(args.outDir) : mkdtempSync(join(tmpdir(), `pilot-short-portrait-${runId}-`));
mkdirSync(outDir, { recursive: true });
const paidLogPath = join(outDir, "paid-steps.jsonl");
const statePath = join(outDir, "pilot-state.json");
let paidSteps = 0;

function log(message) { console.log(`[${nowIso()}] ${message}`); }
function paidLog(entry) {
  paidSteps += 1;
  const record = { at: nowIso(), runId, seq: paidSteps, reservationId: null, reservationNote: "budget reservations are worker-side and are not exposed by the accepted HTTP read surface; reconcile via the project budget read model", ...entry };
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
  form.append("source", `Short-portrait pilot run ${runId}: creator-supplied ${kindLabel} (${basename(filePath)})`);
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

/* --------------------------------- seeding ---------------------------------- */

async function seedWorkflow(projectName, modeLabel) {
  const seeded = { projectId: null };
  log(`[seed] creating project "${projectName}" (profile ${PROFILE_ID})`);
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
      notes: "Story approved for the C13 short-portrait pilot (fixture Milo/Pip six-shot 48s story).",
      advisoryAcknowledgements: [],
    },
  }, 201);
  log("[seed] story approved");

  const castFor = (shotIndex) => shotIndex <= 1
    ? [{ characterId: STORY.canon.characterMilo.entityId, canonRevisionId: canon.characterMilo.id, wardrobe: STORY.canon.characterMilo.wardrobe }]
    : [
        { characterId: STORY.canon.characterMilo.entityId, canonRevisionId: canon.characterMilo.id, wardrobe: STORY.canon.characterMilo.wardrobe },
        { characterId: STORY.canon.characterPip.entityId, canonRevisionId: canon.characterPip.id, wardrobe: STORY.canon.characterPip.wardrobe },
      ];
  const plan = (await postJson(`/api/production/projects/${seeded.projectId}/shot-plans`, {
    projectId: seeded.projectId, storyRevisionId: story.id, approvedStoryHash: story.contentHash,
    shots: STORY.shots.map((shot, index) => ({
      shotId: shot.shotId, beatIds: [shot.beatId],
      visualIntent: shot.visualIntent, motionIntent: shot.motionIntent,
      castBindings: castFor(index), locationRevisionId: canon.location.id,
      propRevisionIds: [], styleRevisionId: canon.style.id,
      framing: shot.framing, targetFrames: SHOT_FRAMES, continuation: null,
    })),
  }, 201)).body;
  seeded.plan = plan;
  log(`[seed] shot plan ${plan.shotPlanRevision.id} with ${plan.shotRevisions.length} shot revisions, animatic ${plan.animaticRevision.id} (totalFrames ${plan.animaticRevision.totalFrames})`);

  if (plan.animaticRevision.totalFrames !== TOTAL_FRAMES) {
    throw new PilotStop(`Animatic pins ${plan.animaticRevision.totalFrames} frames but the pilot plan requires exactly ${TOTAL_FRAMES}.`, { kind: "shape" });
  }
  for (const shotRevision of plan.shotRevisions) {
    if (!h3Legal(shotRevision.targetFrames)) {
      throw new PilotStop(`Shot ${shotRevision.shotId} targetFrames ${shotRevision.targetFrames} is not on the H3 grid (124 + 17n, max 362).`, { kind: "shape" });
    }
  }

  for (const [kind, target] of [["shotplan", plan.shotPlanRevision], ["animatic", plan.animaticRevision]]) {
    await postJson("/api/production/approvals", {
      projectId: seeded.projectId, idempotencyKey: `pilot-${runId}-${kind}-approval`,
      command: {
        targetKind: kind, targetId: target.id, expectedHash: target.contentHash, decision: "approved",
        checklist: checklistFor(kind, modeLabel),
        notes: `${kind} approved for the C13 short-portrait pilot.`,
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

  let seeded = null;
  try {
    seeded = await seedWorkflow(`Short portrait pilot (preflight RED) ${runId}`, "Preflight offline seed walk of the frozen fixture plan");
    recordOffline("seed:project/canon/story/approvals/shot-plan", "ok", `project ${seeded.projectId}, story ${seeded.story.id}, plan ${seeded.plan.shotPlanRevision.id}`);
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
        "Start the server with SOGNI_API_KEY so live account observation works, install the reviewed policy (B6-POLICY-LOAD) and authorize this project via the budget routes.");
    }
  }

  // Media quote: observe the exact closed paid path without ever enqueueing.
  const firstShot = seeded.plan.shotRevisions[0];
  const quoteBody = {
    kind: "anchor",
    command: {
      projectId: seeded.projectId, shotRevisionId: firstShot.id,
      renderSettings: { providerId: PROVIDER_ID, modelId: args.anchorModel, aspect: "9:16", resolution: ANCHOR_RESOLUTION, seed: args.seedBase, referenceAssetIds: [] },
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
      "This is the expected offline RED: quote composition needs the reviewed billing policy (B6-POLICY-LOAD) plus live provider evidence. No paid enqueue is ever sent in preflight.");
  }

  recordBlocker("PAID_ENQUEUE_WITHHELD", "anchors enqueue", "Preflight never sends a paid enqueue by construction.", "Use --final with the env gate satisfied and a bound quote.");
  recordBlocker("ANCHOR_APPROVAL_UNAVAILABLE", "approvals (anchor)", "No anchor candidate can exist without a completed live render.", "Run --final after policy install.");
  recordBlocker("TAKE_CHAIN_UNAVAILABLE", "media-quotes/enqueue/approve (take)", "Takes require an approved anchor and live provider capacity.", "Run --final after policy install.");
  recordBlocker("SELECTION_UNAVAILABLE", "shots/[shotId]/selection", "No approved take exists to select.", "Run --final after policy install.");
  recordBlocker("NARRATION_ASSETS_ABSENT", "assets/import + audio mix", "The final film requires creator-supplied narration (one file per narrated beat), music and at least one SFX file; none were provided to preflight.", "Prepare 48 kHz WAV/MP3 files and pass --narration/--music/--sfx to --final.");
  recordBlocker("AUDIO_APPROVAL_UNAVAILABLE", "approvals (audio)", "No audio mix revision can exist without imported creator audio.", "Run --final after policy install with the audio files.");
  recordBlocker("MANIFEST_EXPORT_QC_UNAVAILABLE", "manifests/exports/run_qc", "Manifest compilation requires selected approved takes; export/QC require the rendered artifact.", "Run --final after policy install.");
  recordBlocker("FINAL_REVIEW_UNAVAILABLE", "final review + download", "The human G09 review and checksum-bound download require an approved export.", "Run --final, then perform the step-8 creator review.");

  const report = {
    packet: "C13-PILOT-SCRIPT",
    mode: "preflight",
    base: BASE,
    recordedAt: nowIso(),
    expectedState: "RED",
    projectId: seeded.projectId,
    artifactsDir: outDir,
    offlineWalk,
    blockers,
    exitMeaning: "exit 0 with recorded blockers = the contract RED state (offline walk succeeded; live-dependent steps are blocked)",
  };
  writeFileSync(join(outDir, "preflight-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n=== PREFLIGHT RED REPORT (exit 0) ===`);
  console.log(`offline walk: ${offlineWalk.filter((entry) => entry.state === "ok").length} ok / ${offlineWalk.length} steps`);
  console.log(`blockers: ${blockers.length}`);
  for (const blocker of blockers) console.log(`  - [${blocker.code}] ${blocker.step}: ${blocker.message}`);
  console.log(`report: ${join(outDir, "preflight-report.json")}`);
  process.exit(0);
}

/* ------------------------------ live final mode ----------------------------- */

function assertBoundQuote(quote, label) {
  if (!quote || typeof quote.id !== "string") throw new PilotStop(`${label}: media quote response has no id.`, { kind: "shape" });
  if (quote.entitlement === "unknown" || quote.withinAuthorizedCap !== "yes") {
    throw new PilotStop(`${label}: quote ${quote.id} is not a BOUND quote (entitlement=${quote.entitlement}, withinAuthorizedCap=${quote.withinAuthorizedCap}). Refusing to enqueue paid work — install the reviewed policy and project authorization first.`, { kind: "quote", quote });
  }
  return quote;
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

async function produceAndApproveAnchor(seeded, shot, index) {
  const renderSettings = { providerId: PROVIDER_ID, modelId: args.anchorModel, aspect: "9:16", resolution: ANCHOR_RESOLUTION, seed: args.seedBase + index * 2, referenceAssetIds: [] };
  const quoteStarted = nowIso();
  const quote = assertBoundQuote((await postJson("/api/production/media-quotes", { kind: "anchor", command: { projectId: seeded.projectId, shotRevisionId: shot.id, renderSettings } })).body, `anchor quote for ${shot.shotId}`);
  log(`[anchor] ${shot.shotId} bound quote ${quote.id} (entitlement ${quote.entitlement}, estimate ${quote.estimateMinMinor}..${quote.estimateMaxMinor} ${quote.currency ?? quote.entitlement})`);
  paidLog({ step: "media-quote:anchor", quoteId: quote.id, providerId: quote.providerId, modelId: quote.modelId, billingMode: quote.entitlement, wallTimeNote: `quoted at ${quoteStarted}` });

  const enqueueStarted = Date.now();
  const { body: enqueue } = await postJson(`/api/production/shots/${shot.shotId}/anchors`, {
    projectId: seeded.projectId, shotRevisionId: shot.id, quoteId: quote.id,
    idempotencyKey: `pilot-${runId}-anchor-${shot.shotId}`, renderSettings,
  }, 201);
  const job = enqueue.job;
  log(`[anchor] ${shot.shotId} job ${job.id} queued (created=${enqueue.created})`);
  const completed = await pollJob(job.id, `anchor ${shot.shotId}`, args.jobTimeoutMinutes);
  paidLog({
    step: "enqueue+render:anchor", jobId: job.id, providerId: completed.providerId, modelId: completed.modelId,
    providerRef: completed.providerRef, billingMode: quote.entitlement, quoteId: quote.id,
    resultAssetIds: completed.resultAssetIds, wallTimeMs: Date.now() - enqueueStarted,
  });

  const model = await readProject(seeded.projectId);
  const readShot = resolveShotModels(model, shot.id);
  const anchor = latestByJobId(readShot.anchorHistory, job.id);
  if (!anchor) throw new PilotStop(`Completed anchor job ${job.id} has no anchor candidate in the read model.`, { kind: "shape" });
  const checksum = assetSha256(anchor.assetId);
  const expectedHash = anchorApprovalHash(anchor, checksum);
  const visionStatus = anchor.visionAssessment?.status ?? "unavailable";
  const acks = visionStatus === "pass" ? [] : [{
    code: `vision_${visionStatus}`,
    reason: `Vision advisory was "${visionStatus}" for anchor ${anchor.id}; the supervising creator performed the identity/wardrobe/location/props/framing checks visually in the anchors UI before approving.`,
  }];
  await creatorGate(`approve ANCHOR ${anchor.id} for ${shot.shotId} (asset ${anchor.assetId}, vision ${visionStatus}) — inspect ${BASE}/production/${seeded.projectId}/anchors`);
  const approval = (await postJson("/api/production/approvals", {
    projectId: seeded.projectId, idempotencyKey: `pilot-${runId}-anchor-approval-${shot.shotId}`,
    command: {
      targetKind: "anchor", targetId: anchor.id, expectedHash, decision: "approved",
      checklist: checklistFor("anchor", `Supervised pilot review of anchor ${anchor.id} (${shot.shotId})`),
      notes: `Anchor approved during the C13 supervised pilot run ${runId}; job ${job.id}, asset ${anchor.assetId}, vision ${visionStatus}.`,
      advisoryAcknowledgements: acks,
    },
  }, 201)).body.approval;
  log(`[anchor] ${shot.shotId} approved (${approval.id})`);
  return { anchor, anchorJob: job, anchorApproval: approval, visionStatus };
}

async function produceAndApproveTake(seeded, shot, index, anchorOutcome) {
  const motionSettings = {
    providerId: PROVIDER_ID, modelId: args.takeModel,
    prompt: `${shot.visualIntent} Motion: ${shot.motionIntent} Keep the approved anchor's composition, identity and storybook style.`,
    targetFrames: SHOT_FRAMES, aspect: "9:16", seed: args.seedBase + index * 2 + 1,
  };
  const quote = assertBoundQuote((await postJson("/api/production/media-quotes", {
    kind: "take",
    command: { projectId: seeded.projectId, shotRevisionId: shot.id, anchorId: anchorOutcome.anchor.id, approvalId: anchorOutcome.anchorApproval.id, motionSettings },
  })).body, `take quote for ${shot.shotId}`);
  log(`[take] ${shot.shotId} bound quote ${quote.id} (entitlement ${quote.entitlement})`);
  paidLog({ step: "media-quote:take", quoteId: quote.id, providerId: quote.providerId, modelId: quote.modelId, billingMode: quote.entitlement });

  const enqueueStarted = Date.now();
  const { body: enqueue } = await postJson(`/api/production/shots/${shot.shotId}/takes`, {
    projectId: seeded.projectId, shotRevisionId: shot.id, anchorId: anchorOutcome.anchor.id,
    approvalId: anchorOutcome.anchorApproval.id, quoteId: quote.id,
    idempotencyKey: `pilot-${runId}-take-${shot.shotId}`, motionSettings,
  }, 201);
  const job = enqueue.job;
  log(`[take] ${shot.shotId} job ${job.id} queued (created=${enqueue.created})`);
  const completed = await pollJob(job.id, `take ${shot.shotId}`, args.jobTimeoutMinutes);
  paidLog({
    step: "enqueue+render:take", jobId: job.id, providerId: completed.providerId, modelId: completed.modelId,
    providerRef: completed.providerRef, billingMode: quote.entitlement, quoteId: quote.id,
    resultAssetIds: completed.resultAssetIds, wallTimeMs: Date.now() - enqueueStarted,
  });

  const model = await readProject(seeded.projectId);
  const readShot = resolveShotModels(model, shot.id);
  const take = latestByJobId(readShot.takeHistory, job.id);
  if (!take) throw new PilotStop(`Completed take job ${job.id} has no take record in the read model.`, { kind: "shape" });
  if (take.actualFrames < SHOT_FRAMES) {
    throw new PilotStop(`Take ${take.id} has ${take.actualFrames} frames, shorter than the approved ${SHOT_FRAMES}; compilation would fail. Reject/retake manually.`, { kind: "shape" });
  }
  const expectedHash = takeApprovalHash(take, assetSha256(take.assetId));
  await creatorGate(`approve TAKE ${take.id} for ${shot.shotId} (asset ${take.assetId}, ${take.actualFrames} frames) — watch ${BASE}/production/${seeded.projectId}/takes`);
  const approval = (await postJson("/api/production/approvals", {
    projectId: seeded.projectId, idempotencyKey: `pilot-${runId}-take-approval-${shot.shotId}`,
    command: {
      targetKind: "take", targetId: take.id, expectedHash, decision: "approved",
      checklist: checklistFor("take", `Supervised pilot review of take ${take.id} (${shot.shotId})`),
      notes: `Take approved during the C13 supervised pilot run ${runId}; job ${job.id}, asset ${take.assetId}, ${take.actualFrames} frames.`,
      advisoryAcknowledgements: [],
    },
  }, 201)).body.approval;
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

async function runFinal() {
  log(`FINAL (live) against ${BASE}; artifacts: ${outDir}`);
  const env = { key: "set", policy: process.env.PERABYTE_STUDIO_REVIEWED_POLICY_PATH };

  // Step 1: preflight-lite — health, worker, budget identity BEFORE any enqueue.
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
  // Budget identity is checked on the seeded project below (the route requires a real project),
  // still strictly BEFORE any media quote or enqueue.

  // Pre-flight the creator audio files BEFORE any paid call (fail-closed before spend).
  if (args.narrations.length !== STORY.beats.length) {
    throw new PilotStop(`--narration must be given exactly ${STORY.beats.length} times (one 48 kHz file per narrated beat, in beat order); received ${args.narrations.length}.`, { kind: "input" });
  }
  if (!args.music) throw new PilotStop("--music <file> is required: the film pilot requires a narration bed, music and at least one SFX cue (QUALITY_GATES pilot protocol).", { kind: "input" });
  if (args.sfx.length < 1) throw new PilotStop("At least one --sfx <file> is required: the film pilot requires at least one deliberate SFX cue (QUALITY_GATES pilot protocol).", { kind: "input" });
  const audioInputs = [];
  for (const [label, file] of [...args.narrations.map((f) => [`narration`, f]), ["music", args.music], ...args.sfx.map((f) => ["sfx", f])]) {
    if (!existsSync(file)) throw new PilotStop(`${label} file does not exist: ${file}`, { kind: "input" });
    const bytes = readFileSync(file);
    const samples = audioSamples(bytes);
    if (samples === null) throw new PilotStop(`${label} file ${file} is not a parsable 48 kHz 16-bit PCM WAV or 48 kHz MPEG-1 Layer III MP3 (the import route rejects anything else).`, { kind: "input" });
    audioInputs.push({ label, file: resolve(file), bytes, samples });
    log(`[1] ${label} ${file}: ${samples} samples (${(samples / 48_000).toFixed(1)}s)`);
  }
  const narrationInputs = audioInputs.slice(0, STORY.beats.length);
  const musicInput = audioInputs[STORY.beats.length];
  const sfxInputs = audioInputs.slice(STORY.beats.length + 1);

  // Step 2: seed.
  log("[2] seeding project, canon, story, approvals and shot plan");
  const seeded = await seedWorkflow(`Short portrait pilot ${runId}`, "Supervised live pilot seed walk of the frozen fixture plan");
  log(`[2] seeded project ${seeded.projectId}`);

  // Budget identity (step 1 completion): must be available on the seeded project BEFORE any
  // media quote or enqueue (fail-closed ordering). A freshly seeded project has no budget
  // authorization yet, and a stop here leaves no reusable state (state is only saved at step 8),
  // so --final can WAIT for the operator to authorize this exact project: re-check both scopes
  // every 15 seconds up to --budget-wait-seconds (default 600; 0 restores the immediate stop).
  // Nothing paid is ever sent during the wait; on timeout the usual PilotStop fires.
  const budgetScopes = ["unit=spark_token", "unit=minor_currency&currency=USD"];
  const authorizeHint = `authorize this project now via the budget routes (POST ${BASE}/api/production/projects/${seeded.projectId}/budget) — see docs/production/pilots/short-portrait.md section 4`;
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
    throw new PilotStop(`Budget identity did not resolve on the seeded project ${seeded.projectId}${waitedNote} (stop before any enqueue). ${authorizeHint}; also install the reviewed policy (B6-POLICY-LOAD) and start the server/worker with SOGNI_API_KEY so live account observation works. See docs/production/pilots/short-portrait.md.`, { kind: "budget" });
  }

  // Step 3: per-shot anchor + take production and approvals.
  const shotStates = [];
  for (let index = 0; index < seeded.plan.shotRevisions.length; index += 1) {
    const shot = seeded.plan.shotRevisions[index];
    log(`[3] shot ${index + 1}/${seeded.plan.shotRevisions.length} (${shot.shotId}, ${shot.targetFrames} frames)`);
    const anchorOutcome = await produceAndApproveAnchor(seeded, shot, index);
    const takeOutcome = await produceAndApproveTake(seeded, shot, index, anchorOutcome);
    shotStates.push({ shotId: shot.shotId, shotRevisionId: shot.id, targetFrames: shot.targetFrames, anchorId: anchorOutcome.anchor.id, anchorApprovalId: anchorOutcome.anchorApproval.id, anchorJobId: anchorOutcome.anchorJob.id, takeId: takeOutcome.take.id, takeApprovalId: takeOutcome.takeApproval.id, takeJobId: takeOutcome.takeJob.id, selected: false });
  }

  // Step 4: take selection per shot (project-global CAS version).
  log("[4] selecting the approved take for every shot");
  let selectionVersion = (await readProject(seeded.projectId)).project.takeSelectionVersion;
  for (const shotState of shotStates) {
    const selection = (await postJson(`/api/production/shots/${shotState.shotId}/selection`, {
      projectId: seeded.projectId, shotRevisionId: shotState.shotRevisionId, takeId: shotState.takeId, expectedSelectionVersion: selectionVersion,
    }, 200)).body;
    shotState.selected = true;
    selectionVersion = selection.selection.version;
    log(`[4] ${shotState.shotId} -> take ${shotState.takeId} (selection version ${selectionVersion})`);
  }

  // Step 5: narration import + audio mix aligned to beats.
  log("[5] importing creator audio and saving the beat-aligned audio mix");
  const importedNarrations = [];
  for (let index = 0; index < narrationInputs.length; index += 1) {
    const input = narrationInputs[index];
    const asset = await importMedia(input.file, `narration beat ${index + 1}`);
    log(`[5] narration ${index + 1} imported as asset ${asset.id} (${asset.audioSamples} samples)`);
    importedNarrations.push({ asset, samples: asset.audioSamples, file: input.file });
  }
  const musicAsset = await importMedia(musicInput.file, "music bed");
  log(`[5] music imported as asset ${musicAsset.id} (${musicAsset.audioSamples} samples)`);
  const importedSfx = [];
  for (let index = 0; index < sfxInputs.length; index += 1) {
    const asset = await importMedia(sfxInputs[index].file, `sfx ${index + 1}`);
    log(`[5] sfx ${index + 1} imported as asset ${asset.id} (${asset.audioSamples} samples)`);
    importedSfx.push({ asset, samples: asset.audioSamples, file: sfxInputs[index].file });
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
    projectId: seeded.projectId, idempotencyKey: `pilot-${runId}-audio-approval`,
    command: {
      targetKind: "audio", targetId: mix.revision.id, expectedHash: mix.revision.contentHash, decision: "approved",
      checklist: checklistFor("audio", `Supervised pilot review of audio mix ${mix.revision.id}`),
      notes: `Audio approved during the C13 supervised pilot run ${runId}: creator narration per beat, music bed, ${importedSfx.length} SFX cue(s); provider audio muted.`,
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
    expectedSelectionVersion: selectionVersion,
  }, 201)).body.manifest;
  log(`[7] manifest ${manifest.id} (${manifest.shots.length} shots, ${manifest.audioCues.length} audio cues, inputsHash ${manifest.inputsHash.slice(0, 12)}...)`);
  const exportRecord = (await postJson(`/api/production/projects/${seeded.projectId}/exports`, {
    projectId: seeded.projectId, manifestId: manifest.id, expectedManifestHash: manifest.inputsHash,
    idempotencyKey: `pilot-${runId}-export`,
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
    runId, mode: "final", base: BASE, profileId: PROFILE_ID, projectId: seeded.projectId,
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
     reopen them in an independent player. Watch the full ${TOTAL_FRAMES / FPS} seconds end to end.
  2. Walk the G01-G09 checklist below on THIS checksum (not an earlier preview).
  3. Write your review evidence file (non-empty; must name narrative, visual,
     audio, captions${qc.report.advisories.length > 0 ? "; must include an \"ack <code>: <reason>\" line for EVERY advisory: " + qc.report.advisories.map((a) => a.code).join(", ") : ""}).
  4. Record the approval and download the verified final bytes:
     node scripts/pilot-short-portrait.mjs --final ${BASE} \\
       --state ${statePath} --creator-approved <your-review-file> --out-dir ${outDir}

 G01-G09 CHECKLIST (docs/production/QUALITY_GATES.md) — recorded against checksum ${qc.report.outputSha256.slice(0, 12)}...
  G01 Canon        character/location/style revisions approved; rights recorded   -> seeded canon ${seeded.canon.characterMilo.id}/${seeded.canon.location.id}/${seeded.canon.style.id} + creator supervision
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

  // Step 9: download the final bytes, sha256, ffprobe reopen probe.
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
    profileExpected: { width: 1080, height: 1920, fps: FPS, videoCodec: "h264", frames: TOTAL_FRAMES },
    dimensionOk: video?.width === 1080 && video?.height === 1920,
    fpsOk: video?.avg_frame_rate === `${FPS}/1`,
    framesOk: Math.abs(frames - TOTAL_FRAMES) <= 1,
  };
  writeFileSync(join(outDir, "reopen-probe.json"), `${JSON.stringify(reopen, null, 2)}\n`);
  log(`[9] reopen probe: ${reopen.container} ${video?.width}x${video?.height} ${video?.codec_name} ${video?.avg_frame_rate} fps, ${frames} frames, audio ${audio?.codec_name ?? "none"} ${audio?.sample_rate ?? "-"} Hz`);
  if (!reopen.dimensionOk || !reopen.fpsOk || !reopen.framesOk) {
    throw new PilotStop(`Reopen probe disagrees with the frozen 9:16 profile (see ${join(outDir, "reopen-probe.json")}).`, { kind: "probe" });
  }
  console.log(`
==============================================================================
 PILOT COMPLETE — the exact final downloadable bytes reopened and verified.
  file:        ${finalPath}
  sha256:      ${downloadedSha}
  container:   ${reopen.container}  duration: ${reopen.durationSeconds}s
  video:       ${video.width}x${video.height} ${video.codec_name} ${video.avg_frame_rate} fps (${frames} frames)
  audio:       ${audio ? `${audio.codec_name} ${audio.sample_rate} Hz ${audio.channels}ch` : "none"}
 Archive (see docs/production/pilots/short-portrait.md): this log (redacted), ${paidLogPath},
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

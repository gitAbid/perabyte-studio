# Long-landscape pilot run book (C14)

How to run the real creator-reviewed 3–6 minute 16:9 film end to end on this machine, using the
accepted production HTTP surface only. The orchestrator script is `scripts/pilot-long-landscape.mjs`
(it invents no endpoints and imports only node builtins + `fetch`; it mirrors the accepted C13
safety architecture of `scripts/pilot-short-portrait.mjs`). Normative sources:
`docs/production/TASK_PACKETS.md` (C14), `docs/production/QUALITY_GATES.md` (G01–G09 + human review
rubric + pilot protocol), `docs/production/reports/C14-PILOT-SCRIPT-freeze.json`.

The film produced here is a **release candidate, not a release**: G10 requires both pilots plus
recovery drills (QUALITY_GATES.md "Definition of release done").

## 0. The frozen long fixture

| Property | Value |
| --- | --- |
| Profile | `storybook-long-v1` (16:9, `targetFrames` 5760 = 4 min target, en, 5-8) |
| Shots | **24** (no short-pilot 6-shot ceiling; the shot-plan route caps at 10,000) |
| Shot length | **226 frames** each = H3 grid `124 + 17·6` (max 362), so every take frame count is renderable |
| Total | **24 × 226 = 5424 frames = 226 s = 3:46** at 24 fps (inside the 3–6 min window) |
| Export | 1920×1080 h264/yuv420p, 24 fps, 48 kHz AAC (`lib/production/manifest.ts` 16:9 branch) |

Surveyed contract facts the fixture relies on (surprise-free by construction):

- `CreateShotPlanCommandSchema` bounds shots at 10,000; per-shot `targetFrames` is any positive
  integer ≤ 100,000; the animatic pins the **gapless sum of shot frames**
  (`lib/services/production/shot-plan.ts` + `lib/production/animatic.ts`). The profile's
  `targetFrames` (5760) is a planning **target, not an equality constraint** — no schema or service
  compares them. The script asserts the actual invariant: animatic `totalFrames === 5424` and every
  shot on the H3 grid.
- QUALITY_GATES' pilot-protocol sketch ("30 distinct 8-second shots, 240 seconds") corresponds to
  30 × 192 = 5760 frames (also fully H3-legal, exactly the profile target); the frozen C14 fixture
  chose 24 × 226 instead (freeze decision). Either satisfies the packet's 3–6 min, >6-shot
  requirement; do not change the fixture without re-freezing.
- **Pagination:** the accepted project read model (v2) exports the active plan's shots as ONE
  bounded ordered array (max 10,000); there is no per-shot HTTP paging route yet. The lib's
  deterministic offset paging (`lib/production/shot-plan.ts paginateShots`, cursor `offset:N`) is
  the reading discipline the script applies client-side: it reads the plan page by page (pages of 6)
  from **two independent GETs** and asserts every page matches across reads AND
  `shotPlanRevision.orderedShotRevisionIds` AND the gapless animatic timeline
  (`timingAnnotations` aligned `startFrame[i] === endFrame[i-1]`, last `endFrame === totalFrames`).
  If a future read route grows real `nextCursor` paging, extend the assertion to the wire cursor.

## 1. Prerequisites (all required; the script fails closed on each)

| # | Prerequisite | Verified by |
| --- | --- | --- |
| 1 | **Sogni Unlimited subscription active** for the account that owns `SOGNI_API_KEY` (renders are subscription-billed; quotes bind the account). | Step 1 budget identity check (`GET /api/production/projects/<id>/budget`) + live `observeAccount` |
| 2 | `SOGNI_API_KEY` exported in the shell that starts **both** the server and the worker. Never pasted into files or logs. | `--final` env gate (exits 1 if unset) |
| 3 | `PERABYTE_STUDIO_REVIEWED_POLICY_PATH` exported in the same shells, pointing at the reviewed pricing/coverage policy installed per `B6-POLICY-LOAD-root-freeze.json`. | `--final` env gate + step 1 budget check |
| 4 | A **per-project budget authorization** for the pilot project (policy + `authorize_project` through `POST /api/production/projects/[id]/budget`), covering `flux1-schnell-fp8` + the take model and the `anchor`/`take` operations, within the standing experiment cap. The standing account policy (`80bb1e6f`) does NOT carry over — each seeded project must be authorized (section 4). | Step 1 budget check (`availability: "available"` **and** empty `reasons`) + BOUND-quote asserts |
| 5 | `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG_PATH`/`FFPROBE_PATH`). Check: `node scripts/production-doctor.mjs`. | Step 9 probe (hard-fails otherwise) |
| 6 | Node >= 22.12 (the creator-side checksum lookup opens `node:sqlite` with `readOnly`). | runtime |
| 7 | **Creator-supplied audio, 48 kHz** — 16-bit PCM WAV or MPEG-1 Layer III MP3 at 48 000 Hz: `--narration <file>` repeated **24 times** (one per beat, in beat order; each must fit its 226-frame ≈ 9.4 s slot), `--music <file>` (ideally ≥ 226 s; shorter beds are pinned to the timeline head with a printed warning), `--sfx <file>` 1..23 (the i-th accents shot i+1). Sine/noise placeholders are not allowed as the final film's narration. | Step 1 input pre-probe (before any spend) |
| 8 | `--data-dir <dir>` pointing at the server's `PERABYTE_STUDIO_DATA_DIR` (first-decision approval hashes, section 8). | step 3 |

Model IDs: the defaults are `--anchor-model flux1-schnell-fp8` (image) and
`--take-model minimax-h3-fl2va-fp8_i2v_turbo` (H3 FL2VA image-to-video turbo; 16:9). **Override both
flags if the installed reviewed policy covers different model IDs** — a model not covered fails
quote composition with `BUDGET_BLOCKED` by design.

## 2. Start the local stack (same env in every shell)

```bash
export SOGNI_API_KEY=...                              # creator's key; never echoed
export PERABYTE_STUDIO_REVIEWED_POLICY_PATH=/path/to/reviewed-policy.json
export PERABYTE_STUDIO_DATA_DIR="$HOME/.studio-pilot-long-$(date -u +%Y%m%dT%H%M%SZ)"   # fresh dir per run

node scripts/production-doctor.mjs                    # storage/media tools/worker/provider preflight

npx next dev -p 3100 &                                # server (or: npm run build && npx next start -p 3100)
PERABYTE_STUDIO_DATA_DIR="$PERABYTE_STUDIO_DATA_DIR" npm run studio:worker &   # renders + export assembly

curl -s http://127.0.0.1:3100/api/production/health   # {"storage":"ready","worker":{"available":true,...}}
```

The worker must be alive before `--final`: it renders 48 jobs (24 anchors + 24 takes) and drives the
export assembly; jobs otherwise sit queued and the script stops at step 1.

## 3. RED first: preflight (offline, no paid call)

```bash
set -C    # noclobber: evidence redirection must not clobber
mkdir -p evidence/C14-PILOT-SCRIPT
LOG="evidence/C14-PILOT-SCRIPT/preflight-$(date -u +%Y%m%dT%H%M%SZ).log"
[ -e "$LOG" ] && { echo "refusing to overwrite $LOG"; exit 1; }

AUDIO=/path/to/creator-audio   # e.g. the C13 pilot's 48 kHz files (beat-1..6.wav ×4, music-bed, sfx)
node scripts/pilot-long-landscape.mjs --preflight http://127.0.0.1:3100 \
  $(for i in 1 2 3 4; do for f in beat-1 beat-2 beat-3 beat-4 beat-5 beat-6; do printf -- "--narration %s/%s.wav " "$AUDIO" "$f"; done; done) \
  --music "$AUDIO/music-bed.wav" --sfx "$AUDIO/well-chime.wav" > "$LOG" 2>&1
echo "exit=$? log=$LOG"
```

Expected: **exit 0 with a structured blockers report** (the contract RED state). The offline walk
must SUCCEED: health, creator-audio pre-probe (when audio flags are given; otherwise the missing
audio is itself a blocker), project/canon/story/approvals seeding, the LONG shot plan (24 shots,
animatic totalFrames 5424 asserted, every shot H3-legal) and the pagination/order-stability
assertions. Every live-dependent step is recorded as a `BLOCKER` with a hint: budget identity
unavailable on the fresh project (`POLICY_MISSING`/`AUTHORIZATION_MISSING` — the standing
authorization is **per-project**), quote not BOUND (`withinAuthorizedCap: "unknown"`), paid
enqueues withheld by construction, selection/audio/manifest/export/QC/final-review unreachable.
Report JSON lands in the run artifact directory printed by the script
(`preflight-report.json`, includes the `fixture` and `pagination` sections). Any **offline** walk
failure exits 1 — that is a real defect, not RED.

`--preflight` never imports creator audio and never sends a paid request.

## 4. GREEN: the live final run

```bash
LOG="evidence/C14-PILOT-SCRIPT/final-$(date -u +%Y%m%dT%H%M%SZ).log"
[ -e "$LOG" ] && { echo "refusing to overwrite $LOG"; exit 1; }

node scripts/pilot-long-landscape.mjs --final http://127.0.0.1:3100 \
  --data-dir "$PERABYTE_STUDIO_DATA_DIR" \
  --budget-wait-seconds 600 \
  --narration narration/beat-1.wav … (24 in beat order) … \
  --music  narration/music-bed.wav \
  --sfx    narration/well-chime.wav \
  > "$LOG" 2>&1
```

What the script does (stop on any envelope; it never retries a paid enqueue):

1. **Fail-closed env gate** — refuses to run unless `SOGNI_API_KEY` and
   `PERABYTE_STUDIO_REVIEWED_POLICY_PATH` are exported (before ANY request; a `--state` without
   `--creator-approved` also exits 1 instead of silently starting a new run).
2. **Preflight-lite** — health + live worker heartbeat + creator-audio pre-probe (existence, 48 kHz
   headers, 24 narration slot math, SFX bounds) — all before a single paid request.
3. **Seed** — project (`storybook-long-v1`, 16:9), canon (Milo, Pip, meadow, watercolor style),
   24-beat story, story approval, LONG shot plan (24 × 226, H3-legal), shot-plan + animatic
   approvals; then the read-model pagination/order assertions (section 0).
4. **Budget identity wait** — see "Budget gate" below; nothing paid is sent until one scope
   resolves `available` with no `reasons`.
5. **Per shot (24×)** — `POST media-quotes` (the quote must be **BOUND**: entitlement != unknown and
   `withinAuthorizedCap: "yes"`, else the run stops before spending) → anchor enqueue → poll
   `GET /api/production/jobs/[id]` (default 15 min per job, live progress printed) → creator
   approval gate → the same for the take (frame count asserted ≥ the approved shot length) →
   **immediate take selection** with the project-global CAS `expectedSelectionVersion`. Because
   selection completes each shot, every shot boundary is a safe restart boundary (section 5).
6. **Narration** — creator files imported via `POST /api/production/assets/import`
   (creator-attested rights), audio mix saved with cues aligned to the 24 beat slots (2000 samples
   per frame at 48 kHz), music bed spanning the timeline, SFX accents at shot boundaries; provider
   audio muted in the mix settings.
7. **Audio approval** (G06 checklist), **manifest** (24 selected takes, deterministic inputs hash),
   **export** (`202`) → poll `GET /api/production/exports/[id]?projectId=...` until `qc_pending`
   (default 60 min for the 226 s film) → `POST {kind:"run_qc"}` → verify `verdict: "passed"` +
   `ready_for_review` (a QC failure stops the run and saves `qc-report-failed.json`).
8. **STOP — the human act.** The script prints the export id, the exact output sha256, the download
   URL, the review UI URL and the G01–G09 checklist, saves `pilot-state.json`, and exits 0. It does
   **not** approve anything.
9. **After the creator's review** — record the approval and fetch the verified bytes:

```bash
node scripts/pilot-long-landscape.mjs --final http://127.0.0.1:3100 \
  --state <run-artifacts>/pilot-state.json \
  --creator-approved creator-review.md \
  --out-dir <run-artifacts>
```

The resume validates the export is still `ready_for_review` with a passed report, requires the
creator evidence file to address `narrative`, `visual`, `audio`, `captions` and to carry an
`ack <advisory-code>: <reason>` line for **every** QC advisory, records the checksum-bound
`final_review` POST, downloads the final bytes, verifies the sha256 equals the approved checksum,
writes `pilot-final-<exportId>.mp4` (noclobber) and runs the `ffprobe` reopen probe against the
16:9 long profile (1920×1080 h264, 24 fps, ~5424 frames) before printing the completion block.

Every paid/render step appends a JSON line to `<run-artifacts>/paid-steps.jsonl`:
`{at, runId, batchRunId, seq, step, jobId, providerId, modelId, providerRef, billingMode, quoteId,
resultAssetIds, wallTimeMs, reservationId, replayed}`. `reservationId` is recorded as `null` with a
note: budget reservations are worker-side and are not exposed by the accepted HTTP read surface;
reconcile through the project budget read model (`GET .../budget`). On batch resume the SAME ledger
file is appended to (`paidLogPath` is recorded in the batch state) so the whole film's spend stays
in one place; `runId` identifies the process and `batchRunId` the logical run.

### Budget gate: authorize the seeded project while the script waits

The seeded project is brand new, so its budget read model starts without a per-project
authorization (typically `POLICY_MISSING`/`AUTHORIZATION_MISSING` — on a live stack the identity
itself may already read `available`; the script still refuses to proceed while `reasons` is
non-empty), and the fail-closed ordering means **no media quote or enqueue may be sent before a
scope resolves `available` with no `reasons`**. `--final` re-checks both scopes
(`unit=spark_token`, `unit=minor_currency&currency=USD`) every 15 seconds for up to
`--budget-wait-seconds` (default 600; `0` restores the immediate stop), logging the project id and
the instruction on every attempt. While it waits, authorize the exact seeded project in a second
shell (same flow as docs/production/pilots/short-portrait.md section 4):

```bash
# POST /api/production/projects/<projectId>/budget — the projectId is in the wait log lines.
# Repeat per scope the reviewed policy uses ("unit":"spark_token" has no "currency" field).
# <policyId> and <expectedPolicyRevision> come from the installed reviewed policy; allowedModelIds
# must cover the anchor/take model IDs and allowedOperations the "anchor"/"take" operations.
curl -s -X POST "http://127.0.0.1:3100/api/production/projects/<projectId>/budget" \
  -H "content-type: application/json" -H "origin: http://127.0.0.1:3100" \
  -d '{"kind":"authorize","providerId":"sogni","unit":"minor_currency","currency":"USD",
       "command":{"expectedAuthorizationRevision":null,"expectedPolicyRevision":<n>,
                  "policyId":"<policyId>","projectCap":null,
                  "allowedModelIds":["<anchor-model>","<take-model>"],
                  "allowedOperations":["anchor","take"],"entitlementModes":["subscription"],
                  "expiresAt":null,"revoked":false,"actorId":"<creator-actor-id>"}}'
```

The script resolves as soon as one scope reports `availability: "available"` with no `reasons` and
continues into the per-shot production loop. During the wait it sends only the read-only budget
GETs (each performs a read-only provider account observation, never a paid render). If the wait
budget expires first, the run stops (PilotStop, exit 1) before any paid request — and a re-run
seeds a fresh project, so authorize during the window.

## 5. Restart/resume across shot batches (the C14 drill)

The long film is designed to survive process restarts at shot boundaries:

```bash
# Batch 1: produce shots 1..6, then exit cleanly.
node scripts/pilot-long-landscape.mjs --final http://127.0.0.1:3100 \
  --data-dir "$PERABYTE_STUDIO_DATA_DIR" --yes \
  --restart-after-shot 6 \
  --narration … (24 files) … --music … --sfx … > evidence/C14-PILOT-SCRIPT/final-batch1.log 2>&1
# -> saves <out-dir>/pilot-batch-state-after-6-shots.json and exits 0 after shot 6's selection.

# NOW KILL THE WORKER (Ctrl-C in the worker shell) and restart it with the same env:
PERABYTE_STUDIO_DATA_DIR="$PERABYTE_STUDIO_DATA_DIR" SOGNI_API_KEY=... \
  PERABYTE_STUDIO_REVIEWED_POLICY_PATH=... npm run studio:worker &

# Batch 2 (and any later batches): resume from shot 7; audio flags are remembered in the state.
node scripts/pilot-long-landscape.mjs --final http://127.0.0.1:3100 \
  --resume <run-artifacts>/pilot-batch-state-after-6-shots.json \
  --out-dir <run-artifacts> --yes > evidence/C14-PILOT-SCRIPT/final-batch2.log 2>&1
```

What the resume re-proves before continuing (fail-closed, in order): the env gate, loopback base,
health + worker heartbeat, the creator-audio provenance (file list recorded in the batch state;
mismatching audio flags stop the run), the project's active story/plan/animatic ids, every
completed shot's take approval + selection in the read model, and the long-plan
pagination/order-stability assertions — then the budget identity check, and only then production
of shots 7..24, the audio mix, manifest, export, QC and the step-8 stop. `--restart-after-shot` may
be combined with `--resume` to stop again at a later boundary (it must be strictly ahead of the
resumed progress); a batch state that already covers all 24 shots resumes straight into the
audio/manifest/export tail.

Interruption safety: idempotency keys (`pilot-<batchRunId>-anchor|take-<shotId>`) derive from the
batch run id recorded in the state, so a shot interrupted by a hard kill is RECOVERED on resume —
the script finds the existing job under the stable key in the read model, polls it to completion
(or reuses its completed result), and re-runs only the missing human approval/selection. It never
re-POSTs an enqueue for a job the store already holds (the server would reject a different-quote
replay anyway, `STALE_REVISION`), so no double spend. A job that already reached a failed terminal
status stops the run (no retry of paid work; reconcile manually). Multiple in-flight approvals per
shot are recorded through the same human gates (`--yes` for supervised non-TTY runs).

## 6. Human gates during the run

Anchor, take and audio approvals are **human decisions** — 24 anchors + 24 takes + 1 mix here. On a
TTY the script pauses at each gate, prints the candidate ids and the review UI URL
(`/production/<projectId>/anchors|takes|audio`), and requires typing `approve`. In a non-interactive
session the run **stops** with instructions unless `--yes` is passed — `--yes` records the
creator's explicit acknowledgment that they are supervising the run and reviewing each candidate as
it prints (it is logged; it is not a default-checked checklist). Withholding the approval aborts
the run cleanly; nothing is approved automatically and failed candidates stay recorded with reasons
for retakes. Already-approved candidates recovered across a batch resume keep their recorded
approval (the resume logs them instead of re-gating).

## 7. The step-8 creator handoff (G09)

The creator must, outside the script:

1. Download the exact final bytes from the printed URL (or the Export page) and reopen them in an
   independent player; play the full 226 seconds once at normal speed; inspect cuts, beginning/end,
   titles and audio transitions (QUALITY_GATES human review rubric).
2. Walk **G01–G09** on that checksum — not on an earlier browser preview (table below).
3. Listen to the audio on headphones **and** laptop/phone speakers with the transcript beside
   playback; narration is creator-recorded, provider audio is muted.
4. Write the review evidence file: at minimum name all four final checks (`narrative`, `visual`,
   `audio`, `captions`) with a pass/fail verdict, and add one `ack <code>: <reason>` line per QC
   advisory (the script fails closed if any advisory lacks an explicit reasoned acknowledgment).
5. Run the step-9 resume command from section 4, then archive the evidence (section 8).

If the creator rejects: do **not** run the resume. Record the rejection reasons (a rejected
`final_review` can be posted manually through `POST /api/production/exports/[id]` with
`decision: "rejected"`), identify the offending shots/cues, and keep the rejected export and its
history. Retakes happen per shot; a re-encoded output requires a new QC and a new review.

## 8. Evidence to archive (per run)

Store under `evidence/C14-PILOT-SCRIPT/` with fresh noclobber names (`set -C`; the redirect target
must not already exist):

- [ ] The preflight RED log (`preflight-<ts>.log`) and its `preflight-report.json`.
- [ ] The final run log(s) (`final-<ts>.log`, one per batch) — **redacted**: confirm no
      `SOGNI_API_KEY` value appears.
- [ ] `paid-steps.jsonl` (single ledger across batches: every quote/enqueue/render with job id,
      provider ref, model id, billing mode, quote id, wall time, `replayed` flags).
- [ ] `pilot-batch-state-after-<n>-shots.json` per batch stop, the worker kill/restart note
      (timestamps), and `pilot-state.json` + the step-8 block (export id, approved sha256).
- [ ] The QC report (from the export detail route) and `reopen-probe.json` (1920×1080/24 fps).
- [ ] The creator review evidence file (sha256 it before archiving).
- [ ] `pilot-final-<exportId>.mp4` checksum record (the mp4 itself is evidence, not a repo fixture).
- [ ] Screenshots: anchors, takes, audio and export pages during review (human-gate evidence).
- [ ] Environment/runtime note: Node version, OS, ffmpeg/ffprobe versions, exact commands, server +
      worker start env names (never values), `production-doctor.mjs` output, measured wall time,
      peak memory and output size (TASK_PACKETS C14 asks for these).

## 9. G01–G09 checklist (record on the exact approved checksum)

| Gate | Stage | The pilot must show | Evidence artifact |
| --- | --- | --- | --- |
| G01 | Canon | Entity revisions approved by the creator; identity/wardrobe/style/location explicit; rights recorded | canon revision ids + story canon pins; creator supervision log |
| G02 | Story/shot plan | Every approved beat covered once (24 beats); no unknown cast/place ids; exact narration preserved; durations/format valid; human story+animatic approvals | story + plan + animatic approval records (checklists) |
| G03 | Anchor | Refs transported by a supported adapter; human identity/wardrobe/location/props/framing checks true per anchor (×24); vision advisory acknowledged when not `pass` | anchor approvals incl. `vision_<status>` acks |
| G04 | Submission | Anchor/animatic approvals current; BOUND quote within authorized cap before every spend (×96 quotes); idempotency stable across restarts | BOUND-quote asserts + `paid-steps.jsonl` |
| G05 | Take | Decodable durable video; expected frames (226)/dimensions; creator accepts identity, wardrobe, setting, action, motion/camera, artifacts (×24) | take approvals (7 binary checks) |
| G06 | Audio | All 24 spoken lines present and intelligible; pinned narrator voice; cue math valid; music/SFX rights attested; no truncation; human mix approval | audio approval + import provenance records |
| G07 | Manifest | Only accepted matching take revisions; legal trims/crops; stable order (pagination asserted); deterministic hash; timeline/audio exact (10,848,000 samples) | manifest id + inputs hash (deterministic recompile) |
| G08 | Technical export | Full decode exit 0; 1920x1080 h264/yuv420p 24 fps; duration within 1 frame of 5424; loudness −14 LUFS ±1; true peak ≤ −1 dBTP; checksum verified | passed `run_qc` report |
| G09 | Final film review | Creator watched the exact downloadable bytes end to end; all four checks true; every advisory acknowledged; approval binds the checksum | `final_review` approval + creator evidence file |

## 10. Known constraints and honest limitations

- **First-decision approval hashes (frozen C08 read-model gap).** Same as C13: the project read
  model does not export asset sha256, so the pilot resolves the asset checksum **creator-side,
  read-only** from `<dataDir>/production.sqlite` (`node:sqlite`) and computes the documented
  approval recipes. The server approval route recomputes both hashes and remains the only
  validation truth; a wrong hash yields `STALE_REVISION` and a stop. The read-model amendment
  remains the cleaner fix.
- **Pagination is a reading discipline, not a wire cursor (yet).** The accepted read model returns
  the plan's shots as one bounded ordered array; the script's page-by-page assertions (section 0)
  prove order stability across reads and against the plan/animatic, but there is no HTTP
  `nextCursor` for shots to assert. Extend the assertions when such a route exists.
- **Music bed length.** The audio pre-probe warns (does not stop) when the creator music bed is
  shorter than the 226 s timeline; the mix pins it to the timeline head. The release long film
  needs a full-length bed or a creator-approved plan for the uncovered tail.
- **Narration is creator-recorded** (no TTS path is wired); each narration file must fit its beat's
  226-frame slot (the script pre-checks the sample math before any spend).
- **The live run is user-gated:** paid calls stay within the standing authorized experiment scope
  and cap, re-authorized per seeded project. If a quote is ever rejected for cap/authorization, the
  script stops and reports — never retries.
- 48 BOUND media quotes (24 anchor + 24 take) and 48 rendered jobs make the long film
  proportionally slower and more expensive than the C13 short (8 quotes, 12 jobs); measure and
  record wall time, peak memory and output size (section 8) rather than assuming the C13 numbers
  scale.

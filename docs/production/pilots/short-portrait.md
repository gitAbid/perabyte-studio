# Short-portrait pilot run book (C13)

How to run the real creator-reviewed 30–60 second 9:16 film end to end on this machine, using the
accepted production HTTP surface only. The orchestrator script is `scripts/pilot-short-portrait.mjs`
(it invents no endpoints and imports only node builtins + `fetch`). Normative sources:
`docs/production/TASK_PACKETS.md` (C13), `docs/production/QUALITY_GATES.md` (G01–G09 + human review
rubric + pilot protocol), `docs/production/reports/C13-PILOT-SCRIPT-root-freeze.json`.

The film produced here is a **release candidate, not a release**: G10 requires both pilots plus
recovery drills (QUALITY_GATES.md "Definition of release done").

---

## 1. Prerequisites (all required; the script fails closed on each)

| # | Prerequisite | Verified by |
| --- | --- | --- |
| 1 | **Sogni Unlimited subscription active** for the account that owns `SOGNI_API_KEY` (renders are subscription-billed; quotes bind the account). | Step 1 budget identity check (`GET /api/production/projects/<id>/budget`) + live `observeAccount` |
| 2 | `SOGNI_API_KEY` exported in the shell that starts **both** the server and the worker. Never pasted into files or logs. | `--final` env gate (exits 1 if unset) |
| 3 | `PERABYTE_STUDIO_REVIEWED_POLICY_PATH` exported in the same shells, pointing at the reviewed pricing/coverage policy installed per `B6-POLICY-LOAD-root-freeze.json` (composition loads it per-request; any malformed/expired file blocks composition loudly). | `--final` env gate + step 1 budget check |
| 4 | A **project budget authorization** exists for the pilot project's scope (policy + `authorize_project` through `POST /api/production/projects/[id]/budget`), covering the anchor and take model IDs and the `anchor`/`take` operations, within the standing experiment cap. | Step 1 budget check (`availability: "available"`) and BOUND-quote asserts |
| 5 | `ffmpeg` and `ffprobe` on `PATH` (or `FFMPEG_PATH`/`FFPROBE_PATH`); the export assembly and the step-9 reopen probe need them. Check: `node scripts/production-doctor.mjs`. | Step 9 probe (hard-fails otherwise) |
| 6 | Node >= 22.12 (the creator-side checksum lookup opens the `node:sqlite` builtin with `readOnly`, which 22.12+ provides). The repo does not pin a Node version — run a current Node 22 LTS or newer. | runtime |
| 7 | **Creator-supplied audio, 48 kHz** — 16-bit PCM WAV or MPEG-1 Layer III MP3 at 48 000 Hz (the import route rejects anything else): `--narration <file>` repeated **once per narrated beat, in beat order** (the fixture story has 6 beats, so 6 files, each fitting its 8-second shot slot), `--music <file>` (one bed), `--sfx <file>` at least one (the i-th accent enters with shot i+1). Sine/noise placeholders are **not allowed** as the final film's narration (C13 non-goals). | Step 1 input pre-probe (before any spend) |
| 8 | `--data-dir <dir>` pointing at the server's `PERABYTE_STUDIO_DATA_DIR` (see "First-decision approval hashes" below). | step 3 |

Model IDs: the defaults are `--anchor-model flux1-schnell-fp8` (image) and
`--take-model minimax-h3-fl2va-fp8_i2v` (H3 FL2VA image-to-video; take frame counts sit on the H3
grid `124 + 17n`, max 362 — the fixture plan uses 6 shots x 192 frames = 1152 frames = 48 s).
**Override both flags if the installed reviewed policy covers different model IDs** — a model not
covered by the policy fails quote composition with `BUDGET_BLOCKED` by design.

## 2. Start the local stack (same env in every shell)

```bash
export SOGNI_API_KEY=...                              # creator's key; never echoed
export PERABYTE_STUDIO_REVIEWED_POLICY_PATH=/path/to/reviewed-policy.json
export PERABYTE_STUDIO_DATA_DIR="$HOME/.studio-pilot-$(date -u +%Y%m%dT%H%M%SZ)"   # fresh dir per run

node scripts/production-doctor.mjs                    # storage/media tools/worker/provider preflight

npx next dev -p 3100 &                                # server (or: npm run build && npx next start -p 3100)
PERABYTE_STUDIO_DATA_DIR="$PERABYTE_STUDIO_DATA_DIR" npm run studio:worker &   # renders + export assembly

curl -s http://127.0.0.1:3100/api/production/health   # {"storage":"ready","worker":{"available":true,...}}
```

The worker must be alive before `--final`: it renders anchors/takes and drives the export
assembly; jobs otherwise sit queued and the script stops at step 1.

## 3. RED first: preflight (offline, no paid call)

```bash
set -C    # noclobber: evidence redirection must not clobber
mkdir -p evidence/C13-PILOT-SCRIPT
LOG="evidence/C13-PILOT-SCRIPT/preflight-$(date -u +%Y%m%dT%H%M%SZ).log"
[ -e "$LOG" ] && { echo "refusing to overwrite $LOG"; exit 1; }

node scripts/pilot-short-portrait.mjs --preflight http://127.0.0.1:3100 > "$LOG" 2>&1
echo "exit=$? log=$LOG"
```

Expected: **exit 0 with a structured blockers report** (the contract's RED state — "first run
records each missing step as a failure"). The offline walk (health, project/canon/story/approvals/
shot-plan seeding) succeeds; every live-dependent step is recorded as a `BLOCKER` with a hint
(budget identity unavailable, `BUDGET_BLOCKED` quote, paid enqueues withheld by construction,
creator audio absent, manifest/export/QC/final-review unreachable). Report JSON lands in the run
artifact directory printed by the script (`preflight-report.json`). Any **offline** walk failure
exits 1 — that is a real defect, not RED.

## 4. GREEN: the live final run

```bash
LOG="evidence/C13-PILOT-SCRIPT/final-$(date -u +%Y%m%dT%H%M%SZ).log"
[ -e "$LOG" ] && { echo "refusing to overwrite $LOG"; exit 1; }

node scripts/pilot-short-portrait.mjs --final http://127.0.0.1:3100 \
  --data-dir "$PERABYTE_STUDIO_DATA_DIR" \
  --budget-wait-seconds 600 \
  --narration narration/beat-1-dawn.wav \
  --narration narration/beat-2-path.wav \
  --narration narration/beat-3-meet.wav \
  --narration narration/beat-4-share.wav \
  --narration narration/beat-5-watch.wav \
  --narration narration/beat-6-home.wav \
  --music  narration/music-bed.wav \
  --sfx    narration/well-chime.wav \
  > "$LOG" 2>&1
```

What the script does (stop on any envelope; it never retries a paid enqueue):

1. **Preflight-lite** — health + live worker heartbeat + budget identity resolution on the seeded
   project (proves live `observeAccount` works **before** any enqueue; if the read model is still
   unavailable the script waits, see "Budget gate" below) + creator-audio pre-probe (existence,
   header and slot math) — all before a single paid request.
2. **Seed** — project (`storybook-short-v1`, 9:16), canon (Milo, Pip, meadow, watercolor style),
   6-beat story, story approval, shot plan (6 shots x 192 frames, H3-legal), shot-plan + animatic
   approvals. Assertions: animatic total 1152 frames; H3 grid membership per shot.
3. **Per shot** — `POST media-quotes` (the quote must be **BOUND**: entitlement != unknown and
   `withinAuthorizedCap: "yes"`, else the run stops before spending) → anchor enqueue → poll
   `GET /api/production/jobs/[id]` (default 15 min budget, live progress printed) → creator
   approval gate (see below) → the same for the take (frame count asserted >= the approved shot
   length).
4. **Selection** — each approved take selected through `POST /api/production/shots/[shotId]/selection`
   with the project-global `expectedSelectionVersion` CAS value.
5. **Narration** — creator files imported via `POST /api/production/assets/import`
   (creator-attested rights), audio mix saved with cues aligned to beats: narration cue k starts at
   shot k (2000 samples per frame at 48 kHz), music bed spans the timeline, SFX accents shot
   boundaries; provider audio is muted in the mix settings.
6. **Audio approval** (G06 checklist).
7. **Manifest** (compile, deterministic inputs hash) → **export** (`202`) → poll
   `GET /api/production/exports/[id]?projectId=...` until `qc_pending` (default 30 min) →
   `POST {kind:"run_qc"}` → verify `verdict: "passed"` + `ready_for_review` (a QC failure stops the
   run and saves `qc-report-failed.json`).
8. **STOP — the human act.** The script prints the export id, the exact output sha256, the download
   URL, the review UI URL and the G01–G09 checklist, saves `pilot-state.json`, and exits 0. It does
   **not** approve anything.
9. **After the creator's review** — record the approval and fetch the verified bytes:

```bash
node scripts/pilot-short-portrait.mjs --final http://127.0.0.1:3100 \
  --state <run-artifacts>/pilot-state.json \
  --creator-approved creator-review.md \
  --out-dir <run-artifacts>
```

The resume validates the export is still `ready_for_review` with a passed report, requires the
creator evidence file to address `narrative`, `visual`, `audio`, `captions` and to carry an
`ack <advisory-code>: <reason>` line for **every** QC advisory, records the checksum-bound
`final_review` POST, downloads the final bytes, verifies the sha256 equals the approved checksum,
writes `pilot-final-<exportId>.mp4` (noclobber) and runs the `ffprobe` reopen probe
(1080x1920 h264, 24 fps, ~1152 frames) before printing the completion block.

Resume protection: `--final --state <file>` **without** `--creator-approved <file>` exits 1 with
the resume command instead of silently starting a brand-new run that ignores the saved state.
Every paid/render step appends a JSON line to `<run-artifacts>/paid-steps.jsonl`:
`{at, runId, seq, step, jobId, providerId, modelId, providerRef, billingMode, quoteId,
resultAssetIds, wallTimeMs, reservationId}`. `reservationId` is recorded as `null` with a note:
budget reservations are worker-side and are not exposed by the accepted HTTP read surface;
reconcile through the project budget read model (`GET .../budget`).

### Budget gate: authorize the seeded project while the script waits

The seeded project is brand new, so its budget read model starts unavailable (typically
`POLICY_MISSING`/`AUTHORIZATION_MISSING`), and the fail-closed ordering means **no media quote or
enqueue may be sent before a scope resolves `available`**. A stop at that gate leaves no reusable
state (the run state is only saved at step 8), so `--final` waits instead of stopping: it
re-checks both scopes (`unit=spark_token`, `unit=minor_currency&currency=USD`) every 15 seconds
for up to `--budget-wait-seconds` (default 600; `0` restores the immediate stop), logging the
project id and the instruction below on every attempt. While it waits, authorize the exact
seeded project in a second shell:

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

The script resolves as soon as one scope reports `availability: "available"` with no `reasons`
and continues into the per-shot production loop. During the wait it sends only the read-only
budget GETs (each performs a read-only provider account observation, never a paid render). If the
wait budget expires first, the run stops (PilotStop, exit 1) before any paid request — and a
re-run seeds a fresh project, so authorize during the window.

## 5. Human gates during the run

Anchor, take and audio approvals are **human decisions**. On a TTY the script pauses at each gate,
prints the candidate ids and the review UI URL (`/production/<projectId>/anchors|takes|audio`), and
requires typing `approve`. In a non-interactive session the run **stops** with instructions unless
`--yes` is passed — `--yes` records the creator's explicit acknowledgment that they are supervising
the run and reviewing each candidate as it prints (it is logged; it is not a default-checked
checklist). Withholding the approval aborts the run cleanly; nothing is approved automatically and
failed candidates stay recorded with reasons for retakes.

## 6. The step-8 creator handoff (G09)

The creator must, outside the script:

1. Download the exact final bytes from the printed URL (or the Export page) and reopen them in an
   independent player; play the full 48 seconds once at normal speed; inspect cuts, beginning/end,
   titles and audio transitions (QUALITY_GATES human review rubric).
2. Walk **G01–G09** on that checksum — not on an earlier browser preview (table below).
3. Listen to the audio on headphones **and** laptop/phone speakers with the transcript beside
   playback; narration is creator-recorded, provider audio is muted.
4. Write the review evidence file: at minimum name all four final checks (`narrative`, `visual`,
   `audio`, `captions`) with a pass/fail verdict, and add one `ack <code>: <reason>` line per QC
   advisory (the script fails closed if any advisory lacks an explicit reasoned acknowledgment).
5. Run the resume command from step 9 above, then archive the evidence (section 7).

If the creator rejects: do **not** run the resume. Record the rejection reasons (a rejected
`final_review` can be posted manually through `POST /api/production/exports/[id]` with
`decision: "rejected"`), identify the offending shots/cues, and keep the rejected export and its
history. Retakes happen per shot; a re-encoded output requires a new QC and a new review.

## 7. Evidence to archive (per run)

Store under `evidence/C13-PILOT-SCRIPT/` with fresh noclobber names (`set -C`; the redirect target
must not already exist):

- [ ] The preflight RED log (`preflight-<ts>.log`) and its `preflight-report.json`.
- [ ] The final run log (`final-<ts>.log`) — **redacted**: confirm no `SOGNI_API_KEY` value appears.
- [ ] `paid-steps.jsonl` (every quote/enqueue/render with job id, provider ref, model id, billing
      mode, quote id, wall time).
- [ ] `pilot-state.json` and the step-8 block (export id, approved sha256).
- [ ] The QC report (from the export detail route) and `reopen-probe.json`.
- [ ] The creator review evidence file (sha256 it before archiving).
- [ ] `pilot-final-<exportId>.mp4` checksum record (the mp4 itself is evidence, not a repo fixture).
- [ ] Screenshots: anchors, takes, audio and export pages during review (human-gate evidence).
- [ ] Environment/runtime note: Node version, OS, ffmpeg/ffprobe versions, exact commands, server +
      worker start env names (never values), `production-doctor.mjs` output.

## 8. G01–G09 checklist (record on the exact approved checksum)

| Gate | Stage | The pilot must show | Evidence artifact |
| --- | --- | --- | --- |
| G01 | Canon | Entity revisions approved by the creator; identity/wardrobe/style/location explicit; reference rights recorded | canon revision ids + story canon pins; creator supervision log |
| G02 | Story/shot plan | Every approved beat covered once; no unknown cast/place ids; exact narration preserved; durations/format valid; human story+animatic approvals | story + plan + animatic approval records (checklists) |
| G03 | Anchor | Refs transported by a supported adapter; human identity/wardrobe/location/props/framing checks true per anchor; vision advisory acknowledged when not `pass` | anchor approvals incl. `vision_<status>` acks |
| G04 | Submission | Anchor/animatic approvals current; BOUND quote within authorized cap before every spend; idempotency stable | BOUND-quote asserts + `paid-steps.jsonl` |
| G05 | Take | Decodable durable video; expected frames/dimensions; creator accepts identity, wardrobe, setting, action, motion/camera, artifacts | take approvals (7 binary checks) |
| G06 | Audio | All spoken lines present and intelligible; pinned narrator voice; cue math valid; music/SFX rights attested; no truncation; human mix approval | audio approval + import provenance records |
| G07 | Manifest | Only accepted matching take revisions; legal trims/crops; stable order; deterministic hash; timeline/audio exact | manifest id + inputs hash (deterministic recompile) |
| G08 | Technical export | Full decode exit 0; 1080x1920 h264/yuv420p 24 fps; duration within 1 frame; loudness −14 LUFS ±1; true peak ≤ −1 dBTP; checksum verified | passed `run_qc` report |
| G09 | Final film review | Creator watched the exact downloadable bytes end to end; all four checks true; every advisory acknowledged; approval binds the checksum | `final_review` approval + creator evidence file |

## 9. Known constraints and honest limitations

- **First-decision approval hashes (frozen C08 read-model gap).** The project read model does not
  export asset sha256, and the UI deliberately disables first approvals for that reason
  (`C08-root-freeze.json` finding 2: "candidates without prior decision cannot be approved from
  UI"; a read-model amendment was proposed as a pre-slice). The pilot therefore resolves the asset
  checksum **creator-side, read-only**, from `<dataDir>/production.sqlite` (`node:sqlite`), and
  computes the documented approval recipes (ARCHITECTURE.md: "Anchor approval fingerprint recipe
  v1 … hashes {recipeVersion, anchorId, shotRevisionId, inputsHash, assetSha256}"; the take recipe
  is `computeTakeApprovalHash`). This computes input for the approval POST only — the server route
  recomputes both hashes and remains the only validation truth; a wrong hash yields
  `STALE_REVISION` and a stop. The read-model amendment remains the cleaner fix.
- The anchor model produces a text-to-image anchor (no reference photos in the fixture canon), so
  identity adherence rests on the prompt + creator review at G03; supply reference assets through
  canon and a reference-capable model if the creator wants tighter identity control.
- Narration is creator-recorded (no TTS path is wired); each narration file must fit its beat's
  8-second slot (the script pre-checks the sample math before any spend).
- The live run is user-gated: paid calls stay within the standing authorized experiment scope and
  cap. If a quote is ever rejected for cap/authorization, the script stops and reports — never
  retries.

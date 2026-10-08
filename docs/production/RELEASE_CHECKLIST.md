# Release checklist — production-core

- Recorded: 2026-10-05, branch `zcode/c15-recovery` (base `768ec28`), recorder: C15-RECOVERY implementation engineer.
- Normative policy: `docs/production/QUALITY_GATES.md` (G00–G10, human rubric, fault matrix). This checklist tracks the **current release candidate**: the C13 short-pilot film, the C14 long pilot, and the C15 recovery tooling.

## Release rule (normative)

1. Every required gate row below must be **PASS with an evidence pointer** before any release-readiness claim.
2. **Never declare release-ready while any required item is UNKNOWN or pending.** An automated hard blocker cannot be waived; advisory warnings do not unblock.
3. Human gates (G01–G03, G05–G07, G09) bind to exact revisions/checksums, not to aggregate scores or earlier previews.
4. **Current verdict: NOT RELEASE-READY.** Required items remain UNKNOWN/pending (G01–G03, G05–G07, G09; G10 blocked on all of them plus C14).

## Gates G00–G10

| Gate | Required acceptance (summary) | Status | Evidence / notes |
| --- | --- | --- | --- |
| G00 | Task/plan readiness: packets frozen, deps accepted, branch/base recorded | **PASS** | `docs/production/reports/wave2-freeze-20261005.json`, `docs/production/reports/C15-RECOVERY-freeze.json` (base `768ec28`); earlier packets integrated through `d9b7ac1` |
| G01 | Canon: explicit identity/wardrobe/style/location revisions, readable checksum-matching references, creator approval of the exact revision, source rights recorded | **UNKNOWN** | Pipeline enforces current approved canon at submission (eligibility fingerprint, `lib/jobs/production/queue.ts`), and approval records exist in the store, but no per-revision gate record with evidence refs has been extracted for review. Extract gate records before release. |
| G02 | Story/shot plan: beat coverage, no unknown IDs, exact narration, human story + animatic approval | **UNKNOWN** | Same pattern as G01: story + animatic approvals are hard prerequisites of every paid submission (`productionSubmissionEligibilityFingerprint`); per-gate human checklist records not yet extracted |
| G03 | Anchor: refs transported, locally durable, exact shot/hash, human identity/wardrobe/place/props/framing checks | **UNKNOWN** | Takes require the exact approved anchor pin (`queue.complete`, `computeAnchorApprovalHash`); per-candidate human check outcomes live in store approvals but are not extracted as gate records |
| G04 | Submission: approvals current, quote/scope/cap authorized, refs within capacity, idempotency stable, worker lease valid | **PASS** (for C13 pilot submissions) | Live store: `budget_reservations == budget_executions` (40 == 40 at drill time; count corrected in C15-INTEGRATION-AMENDMENT — the drill evidence records 40, the packet text said 39), one honored-input receipt per submission, no duplicate submissions observed; packets `reports/C13-PILOT-SCRIPT-root-freeze.json` + `C13-LIVE-FIX*` accepted and integrated |
| G05 | Take: durable decodable video, expected frames/dimensions/audio, creator accepts identity/wardrobe/setting/action/motion/artifacts | **UNKNOWN** | Completed takes and asset rows are in the store (frames/fps/samples recorded); per-take human checklists not extracted as gate records |
| G06 | Audio: lines present/intelligible, consistent voice, valid cues, rights attested, human mix approval | **UNKNOWN** | C13 creator narration imported with creator-attested rights and mixed with approval (`docs/production/pilots/short-portrait.md` step 5); per-cue human review records not extracted |
| G07 | Manifest: only accepted takes, legal trims/crops/transitions, stable order, deterministic hash, exact timeline + audio | **UNKNOWN** | Partial evidence: the C13 export QC validated manifest inputs hash, declared spoken cues vs beats, duration and audio end (see G08 report); full manifest gate review not recorded |
| G08 | Technical export: full decode, format/codec/dimensions/fps, duration within 1 frame, loudness −14 LUFS ±1, true peak ≤ −1 dBTP, checksum verified | **PASS** (C13 short-pilot artifact) | QC report `qc-229bde7a0023c4ca48fcea42a75f7b84750e68473dfb46b37e929dff13afa8d4` (verdict `passed`, all 13 checks true): −14.0 LUFS integrated, −2.1 dBTP true peak, 1152/1152 frames, 1080x1920@24, h264/yuv420p, sha256 verified on-disk; file: `<dataDir>/exports/export-171f0cb9…/qc-report-…json` |
| G09 | Final film review: creator watches the exact downloadable bytes end-to-end; final approval binds the file checksum | **PENDING (user-gated)** | C13 export `export-171f0cb9e8f2a322b93b9ef9ca66b804eac9d361b29affd4836d0c5df0860314` is `ready_for_review` in the store. Awaiting the creator's G09. See "C13" below. |
| G10 | Release/recovery: real short AND long pilots pass G01–G09; reopen/restart/reconcile/backup/restore tests pass; clean install works; offline/retry UX verified; no secrets in logs | **UNKNOWN** | Blocked on G09 (C13) and on C14 entirely. The C15 recovery/backup/restore/restart drills PASS (see operational table); clean-install and offline/retry UX are unverified this packet |

## C13 — short pilot (produced, awaiting creator G09; user-gated)

- Export record: `export-171f0cb9e8f2a322b93b9ef9ca66b804eac9d361b29affd4836d0c5df0860314`, status `ready_for_review`, manifest `manifest-4326a86da3a597e62e614d970a1f642d18f1a3621b9790f55cd990c585742278`.
- Output bytes: sha256 `b94675a509ba4383fe4c4ef06f2c99a53ff05c911511c2dc83172b5ab9485e9e`, 62,684,900 bytes, `video/mp4`, in the media vault at `media/sha256/b9/b94675a5…`.
- Automated QC (G08): **passed** — integrated loudness −14.0 LUFS (target −14 ±1), true peak −2.1 dBTP (limit −1), duration 1152 frames = expected 1152, audio end 2,304,000 samples = expected, decode exit 0, h264 1080x1920@24 yuv420p, output checksum re-verified after QC. QC report id `qc-229bde7a0023c4ca48fcea42a75f7b84750e68473dfb46b37e929dff13afa8d4` (stored in `<dataDir>/exports/<exportId>/` and referenced by the export record).
- **G09 is a human gate and belongs to the creator**: watch the exact downloadable bytes end-to-end (not a preview), then record the final approval bound to sha256 `b94675a5…`. Until that approval exists this export must not be labeled ready to upload, and the project remains a release candidate only.
- A second export `export-4fce7de2…` is recorded `qc_failed` and stays excluded from release per policy.

## C14 — long pilot: pending

- Packet frozen at `docs/production/reports/C14-PILOT-SCRIPT-freeze.json` (profile `storybook-long-v1`, 16:9, 3–6 minutes, >6 shots). No pilot run, no export, no gates. All film gates remain UNKNOWN for the long pilot until C14 is executed and reviewed. G10 explicitly requires both pilots.

## Operational items (C15-RECOVERY)

| Item | Status | Evidence |
| --- | --- | --- |
| Consistent online backup of an active store (WAL, live writer) without writing into the source | **PASS** | `scripts/production-backup.mjs` — read-only snapshot via SQLite `VACUUM INTO`; live drill backed up the live root `.studio` while its worker was active; source file set unchanged (report `drills.backupRestore.sourceUntouched=true`) |
| Restore into a fresh dir with integrity + foreign-key checks | **PASS** | `scripts/production-restore.mjs` — refuses missing/extra/unlisted entries, checksum mismatch, traversal (`..`, absolute, backslash), symlinked entries, non-fresh targets; restored DB passes `PRAGMA integrity_check` = ok and `PRAGMA foreign_key_check` = 0 violations; writes `restore-report.json` with every count and hash |
| Backup → restore drill on real production data | **PASS** | `evidence/C15-RECOVERY/drill-live.log` + `evidence/C15-RECOVERY/recovery-report.json`: all logical table counts match snapshot↔restore, every restored file re-hashed against the manifest |
| Kill −9 a real spawned worker mid-job; restart; recover without duplicate submission | **PASS** | Same report, `drills.killRestart`: worker spawned against a private copy, SIGKILLed mid-stream, restarted after lease expiry; all drill jobs terminal; 0 `submitting`/`submission_unknown` events; 0 budget reservations/executions for drill keys; ≤1 outbox intent per job for the whole drill; attempts ≤ 2; pre-existing history untouched. Attempt semantics are self-checked: the drill probes the frozen store after SIGKILL (`kill.frozenInFlightCommitted` — claims committed but not terminal at freeze) and requires `reclaimConsistent`: exactly those jobs may return at attempt 2. A freeze that lands inside a `claimNext` transaction rolls the claim back, so `frozenInFlightCommitted=0` with an all-attempt-1 histogram is the expected, correct outcome (the pre-kill `atStop` snapshot is a while-running observation and may name a job that completed before the freeze) |
| Orphan media report | **PASS** | Same report, `drills.orphanMedia`: every vault file classified against asset rows (52 files, 51 referenced); zero referenced digests missing. Finding: 1 orphan vault file in the live data (`media/sha256/df/df510184…`, not referenced by any asset row) — harmless under content-addressed storage, but investigate before any pruning |
| Export output hash verification against the backup manifest | **PASS** | Same report, `drills.exportHashes`: both recorded exports' output assets re-hashed and matched (sha256 `b94675a5…` included) |
| Unit RED→GREEN for recovery behavior | **PASS** | `evidence/C15-RECOVERY/red-recovery-test.log` (RED: module/API absent → tests fail), then `npm test -- lib/production/recovery.test.ts` green (checksum/traversal/manifest-completeness refusals, interrupted-lease + no-resubmit recovery) |
| `npm run typecheck` + `git diff --check` | **PASS** | `evidence/C15-RECOVERY/typecheck.log`, `evidence/C15-RECOVERY/diff-check.log` |
| No secrets in logs | **PASS** (this packet) | Scripts print no environment or credential values; worker output tails are scrubbed (`api[_-]?key|token|secret` patterns) before entering the report; integrator should re-verify on full live logs |
| Clean install and run instructions work from scratch | **UNKNOWN** | Not re-verified from a clean checkout this packet |
| Offline/retry UX verified | **UNKNOWN** | Manual UI flows not exercised this packet |

## Commands

```bash
# Consistent backup of a data dir (read-only source; archive is a plain directory)
node scripts/production-backup.mjs --data-dir <data-dir> --out <archive-dir>
#   -> <archive-dir>/backup-<UTC-stamp>/{production.sqlite.snapshot, media/, manifest.json}

# Restore an archive into a FRESH directory (refuses anything unsafe; writes restore-report.json)
node scripts/production-restore.mjs --archive <archive-dir>/backup-<UTC-stamp> --into <fresh-dir>

# End-to-end recovery drills (backup->restore->compare, orphan report, export hashes,
# kill -9 worker restart recovery). The source store is opened read-only only; the
# kill -9 drill runs a worker it spawns itself against a private COPY's data dir
# (copied outbox intents are neutralized so no preexisting job can be submitted).
# Requires Node >= 22.12 (node:sqlite). ~90s (30s lease-expiry wait dominates).
node scripts/verify-production-recovery.mjs --source <live-data-dir> \
  [--work <dir>] [--jobs 500] [--report <path>] [--clean]

# Unit tests for the recovery behavior
npm test -- lib/production/recovery.test.ts
```

Runtime notes: the drill spawns the documented worker command (`node --import tsx scripts/production-worker.mjs`, per `package.json` `studio:worker`) with `PERABYTE_STUDIO_DATA_DIR` pointed at the copy. Backup/restore/verify scripts use Node builtins only (`node:sqlite` is the sanctioned SQLite access — it has no `.backup()` API, so the WAL-safe consistent snapshot uses SQLite's `VACUUM INTO` from a read-only connection; the source is never written).

## Evidence index

- `evidence/C15-RECOVERY/red-recovery-test.log` — RED run of `lib/production/recovery.test.ts` before the scripts existed (exit 1).
- `evidence/C15-RECOVERY/green-recovery-test.log` — GREEN run after implementation (exit 0).
- `evidence/C15-RECOVERY/typecheck.log`, `evidence/C15-RECOVERY/diff-check.log` — required checks.
- `evidence/C15-RECOVERY/drill-live.log`, `evidence/C15-RECOVERY/recovery-report.json` — the real end-to-end drill against the live root `.studio` (read-only source semantics; all drills PASS).

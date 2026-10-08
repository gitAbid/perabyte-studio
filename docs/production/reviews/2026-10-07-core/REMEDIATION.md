# Production core remediation and closure gates

Date: 2026-10-07. Review baseline: `7570fd7d44075dc50a0ebefb72886bc341bfd762` on `zcode/production-core`.

This is the authoritative remediation acceptance contract for the findings in [REVIEW.md](REVIEW.md). It defines outcomes and ownership; the orchestrator freezes the concrete implementation/DTO/migration design before each writer starts. [ISSUES.json](ISSUES.json) starts every finding OPEN. Existing acceptance records remain historical; this package grants no release acceptance.

## Read and dispatch

- [ ] Read AGENTS.md, ARCHITECTURE.md, QUALITY_GATES.md, AGENT_PROTOCOL.md, this package, current Git state and current owners. Record actual integration SHA; if it differs from baseline, reassess each finding before editing.
- [ ] Reproduce each finding or provide independently reviewed evidence it is already resolved. Archive a new RED log for every changed behavior, using temporary real stores and fixture media. Baseline test counts alone cannot close a finding.
- [ ] Freeze exact owned paths, DTO/port amendments, data compatibility, migrations and focused commands. One writer per file/worktree. Integrator owns shared contracts/ports/migrations, dependency files and registry status; workers propose these changes before implementation.
- [ ] Implement one bounded issue, run its focused behavioral checks and typecheck/diff check; hand off exact base/head and evidence to an independent reviewer.
- [ ] Reviewer reproduces closure cases against the submitted SHA and inspects the diff. Integrator merges accepted slices sequentially, reruns affected checks and updates ISSUES.json with evidence.

## Ownership and dependency map

| Lane | Issues, in order | Primary owned paths | Dependencies |
| --- | --- | --- | --- |
| Export worker | R01 lease fencing → R04 restart recovery → R07 mastering | lib/media/production/assembly.ts, assembly.test.ts; assigned worker/runtime entry points for R04 | R04 waits for accepted R01; R07 waits for R04 to avoid concurrent assembly edits |
| QC worker | R05 spoken coverage → R08 profile QC → R06 advisory identity | lib/production/qc.ts, qc.test.ts; lib/services/production/qc.ts, qc.test.ts; assigned audio-domain tests for R05; components/production/export.tsx and export-ui.test.ts for R06 | Serialize this lane; shared contract/migration edits require integrator freeze |
| Local runtime worker | R03 loopback startup | package.json; new focused launcher smoke script if needed | Independent after boundary freeze; keep worker scripts owned by export lane |
| Recovery worker | R02 QC artifact backup | scripts/production-backup.mjs, production-restore.mjs, assigned recovery helpers; lib/production/recovery.test.ts | Parallel only with disjoint frozen paths; rerun against final R06/R08 report schemas |
| Documentation integrator | R09 truthful progress | docs/production/PROGRESS.md, HANDOVER.md, SESSION_STATE.json, task-registry.json, this issue tracker | Final reconciliation follows accepted source slices; preserve pre-existing dirty PROGRESS.md |

An orchestrator/integrator supervises delivery and does not self-accept their own source changes. At least one independent reviewer has no authorship of the slice under review. With limited slots, alternate builder/reviewer turns; do not drop independent review. Initial lanes may run in parallel only after exact ownership verification. A cross-lane shared-file change is a sequential integrator amendment, never concurrent edits.

## Issue packets and mandatory closure cases

### R01 — P1: Export lease fencing (review S1)

Locations at baseline: assembly.ts:453–461, 498–502, 527–537. Focused command: `npm test -- lib/media/production/assembly.test.ts` plus assigned real-store/multiprocess fixture command.

- [ ] R01-01: Runner A stalls beyond expiry, B reclaims, A resumes heartbeat/success/failure/cancel. A cannot change B's export, overwrite/delete B's lease, or commit its result pointer.
- [ ] R01-02: Competing reclaimers admit one live owner. Test with real SQLite and independent processes, not only an in-memory status stub. Normal owner heartbeat/finish and crash reclaim still succeed.
- [ ] R01-03: Result and failure transitions are atomically fenced by durable owner token. Cleanup is owner-specific. Lease-loss orphan bytes remain inventoried safely without a successful export pointer.
- [ ] R01-04: Reopen/migration preserves existing exports/media/history; stale ownership produces actionable state without duplicate paid provider work.

### R02 — P1: Restore QC evidence (review S2)

Locations: production-backup.mjs:117–136; services/production/qc.ts:179, 340–341. Focused command: `npm test -- lib/production/recovery.test.ts lib/services/production/qc.test.ts`.

- [ ] R02-01: A real ready_for_review export with report, manifest, asset and approvals is backed up/restored into an empty temporary directory. Its report checksum/ID/bindings survive and actual final-review service can approve it without rerendering.
- [ ] R02-02: Approved, qc_failed and ready_for_review exports retain inspectable required evidence and correct download/review gates. Verify exact media checksums and historical approvals.
- [ ] R02-03: Missing, corrupted, foreign, traversal or symlinked required artifacts fail safely and leave destination/source intact. Active-write backup yields a coherent DB/report snapshot, not an ID pointing to absent bytes.
- [ ] R02-04: Older archive compatibility is explicit and tested; incomplete old archives surface an actionable recovery path without invented reports or approval. Preserve immutable rejected artifacts and rights/provenance. Record backup format version if changed.

### R03 — P1: Localhost defaults (review S3)

Locations: package.json:6,8. Check installed Next CLI behavior; bind both defaults to 127.0.0.1.

- [ ] R03-01: Spawn actual development and built production launch commands on isolated available ports; recorded listener address is loopback, never wildcard. Both serve expected local routes.
- [ ] R03-02: Existing same-origin mutations work locally; cross-origin/missing-origin rejection remains. No new remote override is introduced by this packet.
- [ ] R03-03: Capture real listener evidence and startup/shutdown behavior. Source-string assertion alone is insufficient. No secret env values in logs and no production data directory used by smoke fixtures.

### R04 — P2: Durable export restart (review S4)

Locations: assembly.ts:555–569; services/production/manifest.ts:272; scripts/production-worker.mjs. Focused commands: assembly tests plus a subprocess restart fixture.

- [ ] R04-01: Queue exports, kill the execution process before claim and during render, restart the documented runtime. Same export IDs resume/complete after lease expiry without a new HTTP POST or opening the browser.
- [ ] R04-02: Multiple projects and a backlog greater than the old redrive limit drain fairly within configured capacity. Live owners, terminal/canceled exports and ambiguous provider submissions are respected.
- [ ] R04-03: Duplicate startup/trigger and two process contenders never double-commit; zero image/video provider regeneration. Shutdown safely stops child work and preserves restartable intent.
- [ ] R04-04: Reopening UI attaches to existing exports with accurate progress/errors. Offline startup and tool failure do not spin unbounded retries.

### R05 — P1: Complete spoken-line coverage (review spec P1)

Locations: services/production/qc.ts:185–186; production/qc.ts:320–324; production/audio.ts:209–226. Focused commands: `npm test -- lib/production/audio.test.ts lib/services/production/audio.test.ts lib/production/qc.test.ts lib/services/production/qc.test.ts`.

- [ ] R05-01: Missing narration, missing dialogue and one missing line in a multi-line beat are hard blockers. Bind coverage to beat/line/speaker as needed; identical text in distinct beats cannot substitute for omitted occurrences.
- [ ] R05-02: Wrong/foreign/stale segment IDs and altered text cannot satisfy coverage. Unicode/text policy follows existing exact transcript contract, with a reviewed amendment if representation changes.
- [ ] R05-03: Complete valid narration/dialogue passes; music/SFX alone cannot pass a spoken-film gate. Silent experimental draft remains downloadable only as draft, never final.
- [ ] R05-04: Full API/service test proves incomplete speech cannot reach approved/final download even if all UI checklist boxes are submitted true. Human listening remains required for intelligibility; metadata cannot prove actual spoken audio.

### R06 — P2: Per-interval advisory acknowledgment (review spec P2)

Locations: services/production/qc.ts:353–356; components/production/export.tsx:612–613. Focused commands: `npm test -- lib/production/qc.test.ts lib/services/production/qc.test.ts lib/production/export-ui.test.ts` plus actual browser acceptance.

- [ ] R06-01: Two same-code warnings at different frame/sample intervals have distinct stable report-bound identities. Acknowledging one leaves the other blocked. Each reason is nonempty and bound to its interval/cue.
- [ ] R06-02: Missing/duplicate/unknown/foreign-report/stale acknowledgments cannot unlock approval; rerunning QC cannot reuse unrelated warning approval. Persist exact acknowledgments in final approval history.
- [ ] R06-03: Browser editing one warning reason leaves the other field untouched; submit remains blocked until each required warning is addressed. Verify desktop and mobile, screenshot and no console errors.
- [ ] R06-04: Existing reports/approvals remain readable. Reviewed compatibility/migration handles old code-only acknowledgments conservatively without backfilling human actions; preserve historical provenance.

### R07 — P2: Speech ducking and two-pass mastering (review spec P3)

Location: assembly.ts:220–228; requirement ARCHITECTURE.md:142. Focused command: `npm test -- lib/media/production/assembly.test.ts` plus real FFmpeg audio fixture.

- [ ] R07-01: Fixture with speech/music overlap measurably ducks the music component under speech and releases after it; intended SFX routing survives. Implement documented ratio6/attack20ms/release250ms or an explicitly reviewed spec amendment.
- [ ] R07-02: First pass measures the complete intended mix; second pass consumes measured parameters. Independently measured final output meets -14 LUFS ±1 and true peak ≤-1 dBTP; no clipped/truncated words, preserved cue timing and audio end within one frame.
- [ ] R07-03: Narration-only/music-only/silent-draft cases, tool failure/cancel and nonfinite measurements behave safely. Incompatible approved settings are rejected visibly instead of ignored.
- [ ] R07-04: Version changed mastering recipe and fingerprints so old exports/approvals stay historical. Provide before/after fixture audio for creator listening; claim numeric compliance separately from human intelligibility acceptance.

### R08 — P2: Independent full output profile QC (review spec P4)

Locations: production/qc.ts:263–327,429–433; service ffprobe projection. Focused commands: `npm test -- lib/production/qc.test.ts lib/services/production/qc.test.ts` plus real wrong-format media fixtures.

- [ ] R08-01: Individually wrong codec, sample rate or channel count fail. Baseline MP3/44100Hz/mono probe is RED, corrected AAC/48000Hz/stereo is GREEN. Missing/nonfinite values fail conservatively.
- [ ] R08-02: Probe/check required BT.709 color primaries/transfer/matrix, progressive scan and square pixels; absent/incorrect required metadata fails according to an explicitly frozen policy. Normal supported encoder output passes.
- [ ] R08-03: Real encoded wrong-format fixture is rejected by QC independently of assembly; blocker IDs appear in report/API/UI. No final approval/download bypass through checklist submission.
- [ ] R08-04: Silent draft correctly skips absent audio checks, retains video checks and cannot become upload-ready. Maintain report schema compatibility and validate report verdict/check consistency.

### R09 — P2: Current records agree with accepted source/evidence

- [ ] R09-01: Reconcile every affected task in registry, PROGRESS, HANDOVER and SESSION_STATE against actual integrated SHA and independent evidence. Preserve pre-existing dirty text and historical checkpoints.
- [ ] R09-02: Differentiate implemented, independently accepted, integrated, technically verified and human film-approved. Both current film review copies remain pending G09 unless exact-checksum creator approvals are actually observed.
- [ ] R09-03: Next packet/owners/dirty paths/unrun commands/remaining issues are current; document run commands that exist. No accepted status from a worker self-report or copied historical count.

## Required evidence and issue lifecycle

For each case retain exact argv, cwd, exit status, timestamp, raw log path and SHA-256; save each attempt with unique filename under `evidence/remediation/<issue-id>/<run-id>/`. Reports belong in `docs/production/reports/` and follow AGENT_PROTOCOL. Also include base/head/integrated SHA, changed files, case IDs, review verdict and reviewer identity, fixture directory/media hashes, migrations/compatibility results, unrun checks and `paid_calls: []`. Preserve RED and GREEN separately; historical tool excerpts are labeled excerpts, never reconstructed as raw logs.

Status transitions: OPEN → REPRODUCED → IMPLEMENTED → REVIEWED → INTEGRATED → VERIFIED → CLOSED. If current HEAD already fixes an issue, independent reproduction and exact integrated evidence can justify closure without another patch. A disproven finding becomes DISMISSED with reviewer-approved counterevidence; it cannot silently become CLOSED. Any failing mandatory case keeps the gate OPEN. A deferral/waiver does not satisfy closure. Only the integrator changes issue status after the independent verdict.

### Gate A — Individual issue closure

Every numbered case for that issue passes on integrated code, original trigger has a meaningful RED→GREEN witness (or independently verified prior fix), independent reviewer accepts exact source SHA, affected checks pass after integration, evidence hashes are valid, and status records contain no unexplained failure or unrun mandatory case. Builder self-review is insufficient.

### Gate B — Remediation batch closure

All R01–R09 are CLOSED or independently DISMISSED with evidence. On one recorded final integration SHA run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`; run startup binding, export kill/restart, real backup/restore, actual FFmpeg/audio/QC and advisory browser scenarios. Preserve observed warning dispositions. Results from different SHAs cannot be combined to claim one final pass. Capture restart/recovery across the full combined pipeline, not isolated helpers only.

### Gate C — Product release closure (separate from Gate B)

Both real short and long films satisfy G01–G09, with creator watching/listening to the exact final downloadable checksum and reviewing each advisory interval. Independent reviewer verifies evidence and actual films. Demonstrate restart plus backup/restore of the reviewed projects, retake one shot without breaking siblings, and a clean local install/run from current instructions (G10). Re-mastered/re-encoded outputs require fresh QC and human review; historical approvals never transfer to changed bytes. No new paid/provider calls, external publishing or deployment are authorized by this remediation prompt. If those become necessary, use an already explicit applicable authorization or report the missing scope/cap. Offline development may finish Gate B while Gate C remains awaiting creator review.

## Handoff

Use [AGENT_PROMPT.md](AGENT_PROMPT.md) as the orchestrator instruction. Report per issue ID: current status, accepted integrated SHA, passed case IDs, evidence/reviewer links, remaining blocker and next action. Finish with separate Gate A/B/C outcomes; never label pending human acceptance as a code failure or a completed release.

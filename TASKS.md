# Production Core Progress

Integration branch: `codex/production-core`; worktree: `/Users/abid/.codex/worktrees/production-core/perabyte-studio`.
Baseline: `79a8c89`; reviewed code: `5fa1370`.
No live-dashboard MCP was exposed; this file is the progress and evidence record.

| Task | Status | Evidence |
| --- | --- | --- |
| Existing architecture audit | done | Character/location rows, server runner, keyframe strategy, job executor inspected |
| Sogni primary-source research | done | Sources linked in docs/PRODUCTION_STUDIO_MASTER_PLAN.md; no paid generation |
| Design and first implementation plan | done | docs/superpowers/specs/2026-10-03-production-core-design.md; docs/superpowers/plans/2026-10-03-consistency-foundation.md |
| Baseline verification | done | 76 test files / 799 tests; typecheck and build exit 0 |
| Strict generation reference policy | done | Worker 7cd6058 integrated as 16e0ab9; red 8 expected failures; targeted 75 tests passed |
| Canonical story references | done | Worker 5c9ca6d/e080542 integrated as 63f8034/3fbb877; canon, cast, location, capacity regressions |
| QC input alignment | done | 5fa1370; 7 focused tests passed; scene-local cast and location precedence |
| Independent architecture/code review | done | GPT6.1 Sol reviewed 5fa1370; all initial P1/P2 findings fixed; no remaining P1/P2 in increment |
| Integrated verification | done | npm test: 78 files / 835 tests passed; npm run typecheck exit 0; npm run build exit 0; git diff --check exit 0 |
| Master production roadmap | done | docs/PRODUCTION_STUDIO_MASTER_PLAN.md; modular phases, ownership, dependencies, budget and benchmark gates |
| Human approval and immutable provenance (P1) | planned | Next milestone; current vision gate remains automatic |
| H3 timed-keyframes/Ref2VA, budget/worker/vault (P2) | planned | SDK compatibility and capability probes required |
| Narration, music, SFX and mastering (P3/P4) | planned | No production export/audio work claimed complete |
| Paid visual quality benchmark | not run | Needs account entitlement, pilot assets and budget; proposed benchmark thresholds are not measured |

## Verification details

Final commands ran on 2026-10-03 after code integration. Tests increased from 799 to 835 (+36). No UI was changed, so browser screenshot verification was not required for this increment. Existing Vite configLoader compatibility warning remains. Next production build retains the baseline dynamic filesystem tracing warning at lib/media/frame-server.ts:79; no deployment was performed.

Offline frozen pnpm setup failed because local registry metadata was incomplete. Reused existing dependencies, then copied node_modules into integration worktree because Turbopack rejects a symlink outside its filesystem root. Build succeeded with normal npm run build after this environment-only adjustment. Lockfile and Next configuration unchanged.

## Session outcome

Research/master plan and the first consistency foundation are complete. Required references now fail visibly instead of being silently removed; stories validate explicit canonical IDs and renderer cast capacity; keyframe model selection preserves mandatory anchors; renderer and QC use the same selected cast/location. Strict conditioning protects both inline and durable paths; unknown provider adherence remains a QC concern, not a mathematical guarantee. Legacy generation without policy remains best effort. Original uncommitted text-engine-chain.ts, IDE files and requirements draft are untouched.

Continue next with immutable story/shot/bible revisions, explicit human keyframe approval, dependency invalidation, take history and single-shot reuse. Audio/mastering and the production persistence release gate follow the phased roadmap. Preserve this integration branch/worktree for that work.


## Enriched execution and professional interface specification — 2026-10-03

Completed planning artifacts: docs/production/README.md, RESEARCH.md, ARCHITECTURE.md, UX_SPEC.md, QUALITY_GATES.md, TASK_PACKETS.md, AGENT_PROTOCOL.md, task-registry.json, pilot fixtures and standalone preview.html. The UI follows the existing DESIGN.md warm-paper/evergreen palette with professional, genre-neutral copy; the kids story is demo content. SaaS hosting/security/account/billing are a separate future milestone, not an implemented deployment.

Verification: `python3 scripts/verify-production-plan.py` passed with 18 task IDs, earlier-wave dependencies, exact disjoint same-wave ownership and 6/30-shot planning fixtures. Negative controls reject dependency/ownership mistakes. `node scripts/verify-production-plan-preview.mjs` passed at 375/768/1280/1440px across five stages with no horizontal overflow or page errors; save failure blocks approval and illustrative media cannot unlock export. Desktop and mobile screenshots were visually inspected; mobile cards changed to two columns with readable full reference rows. Evidence lives in /tmp/perabyte-production-design/report.json and screenshots; rerun script to reproduce it. `git diff --check` passed.

Independent GPT-6.1 Sol review caught and root corrected: final checksum-bound human film approval, shot-exclusion coverage/reapproval, immutable shot-plan/animatic/audio-mix aggregates, separate source/timeline audio positions, media import route ownership, pinned-library behavior, silent draft vs narrative-film release policy, safe export-cache reuse, noncircular animation prerequisites and imported-language support. Research worker checked all 18 primary bibliography links. No paid generations, application UI integration, SQLite migrations or audio/export features were executed in this documentation increment. The earlier 835-test/typecheck/build evidence remains the code baseline; it was not rerun for docs/prototype-only changes.

Next execution begins with C00 typed contracts and executable fixtures, then C01/C03/C05 in separate worktrees. All implementation packets remain planned. Release requires actual creator-reviewed short and long films plus recovery evidence, not the design preview or synthetic test clips.


## Build execution started — 2026-10-03

| Packet | Status | Ownership / evidence |
| --- | --- | --- |
| Usage/resume/takeover policy | committed | 4c2626c; AGENTS.md, HANDOVER.md, SESSION_STATE.json, agent protocol |
| C00 validation dependency | committed | 4d4b658; exact Zod4.6.5; pnpm install + npm lock synchronization passed |
| C00 strict contracts, hash and ports | active | Luna worker /root/execution_packets; isolated codex/production-contracts |
| U00 usage/handover checker | active | Luna worker /root/industry_research; isolated codex/production-handover-guard; independent of C00 |

Account observations: 31%, then29% five-hour remaining; 89% weekly remaining. Threshold: checkpoint preparation5%, implementation hard stop2% remaining in any bucket. Missing limits are unknown. No new dashboard MCP is available; this log and SESSION_STATE.json are the live progress record. Worker checkouts were explicitly switched to their own branches after managed worktree creation; integration remains codex/production-core.


C00 and U00 accepted/integrated after independent Sol review and corrections. Fresh integrated verification:874 tests across81 files passed; typecheck passed. Production build exit0; existing frame-server tracing warning remains. SQLite13.0.3 native connection and transaction verified; tsx4.23.15 runner available. No production DB migrations or UI changes yet. Latest account remaining9% shorter/86% weekly; reduce batch size, begin checkpoint preparation at5%, hard-stop implementation at2%.

Usage reached5%remaining; checkpoint preparation active. C05 is the sole active core packet. User deferred UI redesign; C01/C03 and later backend services remain next work. C00/U00/full874-test baseline/build are accepted; C05 remains unverified.

Hard stop at2%short-window remaining/85%weekly. C05 checkpoint preserved uncommitted in codex/production-shot-plan; domain check16passed/1failed, service absent, no acceptance/integration. HANDOVER.md + SESSION_STATE.json + reports/C05-checkpoint.json are continuation authority. Other workers idle; no automatic resume scheduled.

## Resumed build — current state

User authorized continuation after reset. C01 persistence, C03 capabilities and C05 planning are active in distinct worktrees, all based on 9a545447. Contracts and usage guard remain accepted. UI redesign remains deferred. Latest account observation:94% shorter/83% weekly remaining. Scheduled resume is PAUSED because work resumed immediately. No paid calls.

C05 accepted after root corrections and independent Sol review. Worker commits02707ad/d416302 integrated as5d03bc7/95f0570;34 focusedtests3files reproduced. SQLite service integration, historical downloads and real film gates remain unverified dependent work. C01/C03 continue; latest79% shorter/81% weekly.

C03 accepted at5260be9 after independent Sol review:20 focusedtests2files; endpoint/Ref2VA semantics corrections integrated. C01 remains under review corrections (backup symlinks/numeric loss/audio refs). Latest63% shorter/79% weekly. No paidcalls.

C01 accepted at65ff9c1 after four concrete review fixes;15 focusedtests. Combined wave1verification943tests88files, typecheck and build exit0. RootSQLite+planner smoke passed exacttext/history/dependency persistence. Read-only Sogni catalog191models observed, no paidcalls. Latest52%shorter/77%weekly.

I00 sharedruntime/profile/HTTP composition active in codex/production-runtime, worker/root/runtime_build, base511d481. C02/C04 depend on acceptedI00 to avoid duplicating serverconfiguration/error policy. Latest50%shorter/76%weekly.


## Latest accepted packet — I00

I00 accepted at e2b80d73a6a0435931bf3d8e2d6f5756e16ea861 after Sol review;10focusedtests+14contracttests/typecheckpassed. Rawlogs production-runtime/evidence/I00; recomputedhashes docs/production/reports/I00-evidence.json. Shared API INTERNAL_ERROR500 and derived read responsev2 frozen. Canon successor ADR governs C02/C06/C11: genuineapproval, byte-exact unchanged originating shot reuse, preservedtakes/history. NextC02/C04.40%shorter/75%weekly observed; automaticresumePAUSED duringactivecontinuation.

C02 active /root/revisions_build in production-revisions; C04 active /root/worker_vault_build in production-worker. Separate branches and exact ownership; no paid calls. I00 full integrated suite:954 tests/91files pass; last productionbuild predatesI00.


Usage hard stop:2% shorter/69% weekly. C02/C04 are paused incomplete and unaccepted. Details and exact worktree state are in docs/production/SESSION_STATE.json/HANDOVER.md; C04 checkpoint hashes are in reports/C04-checkpoint.json. One-shot resume active today20:41 Dhaka. No paid renders, UI redesign or upload-ready claim.


C02 accepted on scheduled resume: immutable revision services/read-model and exact reused-shot history, byte-preserving Unicode fixes, global canon project binding CAS, durable cancellation/outbox heartbeat prerequisites and strict provider target DTOs. Sol reviewed exact commits; root986tests/93files, typecheck/build and12actualbuiltHTTP requests passed. Fixed I00 same-origin rejection caused by Next internal URL rewriting. Evidence: docs/production/reports/C02-evidence.json. C04 still active/unaccepted; no paid generations/UI redesign.

Scheduled resume milestone: reviewed C04 ensureOutbox prerequisite integrated893e987 (15 SQLite tests/typecheck pass); full C04 remains active/unaccepted. Anchor approval checksum fingerprint frozen for C04/C06. No paid calls.

Scheduled resume reserve stop: C02 accepted; C04 b19c0c4 incomplete/unaccepted/unintegrated,41 focusedtests reproduced, exact review/report integrity stored docs/production/reports/C04-resume-review.json. All owners idle; next fix P1 approval/anchor transport and listed lifecycle/media gaps. 5% shorter/54% weekly remaining; no paid calls; one-shot deleted.
\nUser-requested continuation resumed C04 on fresh33% remaining. Commit477665e: root reproduced48 focused tests/typecheck; independent review found two continuation P1s now assigned to stopped worker_resume. GPT-6.1-Sol unsupported on this account; GPT-5.6-terra independent review used. C04 remains unaccepted/unintegrated; one-shot automation consumed/deleted; no paid calls.\n
## Production core C04 accepted — 2026-10-04

Integrated at b48c9ee after independent Sol review and root reproduction: 1060 tests in98 files, typecheck/build exit0,10 actual built HTTP requests and standalone SIGTERM exit0 with owner/heartbeat cleanup. Exact reports, SHA/hash evidence and remaining release work are in docs/production/reports/C04-evidence.json. Earlier full-suite route-fixture failures were corrected without weakening assertions. Immutable approved canon/story/anchor pins, transactional result persistence, unknown-submission recovery, lease ownership, staged imports and installed-SDK media recovery are verified.

Next: I01 contracts/domain freeze and atomic durable authorization/reservation ledger, then C06/I02. Paid calls and real-film release are not authorized or completed. UI redesign deferred. Preserve original checkout and worker evidence; use live account5% reserve/2% stop rules.

- 2026-10-04 I01-B1 accepted domain/contracts slice at ffea35b2a7cdc7400b083ea0be7d388cbb0723f0:36focused,1079full tests/99files, typecheck/build pass, independent Sol review accepted. I01 storage/services/atomic worker remain incomplete; no paid calls.

2026-10-04: I01-B2 ledger/storage accepted at c7c1e73716c28233b6628b49f85eccac3dfc9b06 after independent startup/compatibility review;1091 tests/type/build and built health200/schema2. FullI01 incomplete. B3/B4 assigned isolated branches with frozeninterfaces; UI/paidcalls deferred.

I01 shared quote compatibility accepted and integrated at8b8abf5 (sourcea7f0366+b38712c). Independent Sol41budget/contracts tests and evidence hash audit passed; root41tests reproduced. Strict report/raw logs preserved evidence/integration/i01-helper; source review docs/production/reports/I01-helper-review.json. Pure helper only; B3/B4 consumers and full I01 remain unfinished. B4 sole writer transferred to /root/i01_admission_compatibility after prior owner idle; isolated tree preserved. No paidcalls/UI changes.

I01-B3 accepted/integrated at4997ecc after Sol review closing R1/R2 and root actual1122tests/101files, typecheck/build and6builtHTTP checks. Evidence reports/I01-B3-evidence.json; smoke scaffold CJS error preserved separately, corrected actual smoke passes. Reporting qualification: direct nonbilling semantics covered B1/B2, not extra B3 success assertion. Full I01/B4 combined gate and live composition remain open. No paidcalls/UI changes.

Usage5% reserve checkpoint: all source writers idle; no combinedgate dispatch. B4candidatef0856bb source54tests/independentreview accepted for gate only, unintegrated; metadata logoverwrite corrected from genuine53raw and independentlyhashverified. Exact fourcase realservice gate frozen; nextresume directions inHANDOVER/state. Root accepted B3code4997ecc1122tests/type/build/6HTTP remains latestverified milestone. No paidcalls/UI work or fullI01 acceptance.

Hard stop2026-10-04T05:17:17Z: live1%shorter/22%weekly remaining. All workers idle; implementation/newtests/reviews stopped. Source unchanged; finalusage saved inSESSION_STATE/HANDOVER.

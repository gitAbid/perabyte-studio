# Perabyte Studio core progress

Integration/root branch: `zcode/production-core` (created 2026-10-05 from `codex/production-core` checkpoint `a52a8fa`; the Codex root worktree and branch are preserved untouched)

Checkout: `/Users/abid/Projects/perabyte-studio/.worktrees/zcode-production-core`

Orchestration: ZCode `/orchestrate` team (GLM-5.3 primary orchestrator + Flash implementer/reviewer specialists) since 2026-10-05; prior Codex checkpoints/evidence remain authoritative history.

| Feature | Current state |
| --- | --- |
| Modular contracts, local store and shared runtime | Integrated |
| Immutable canon/story revisions and affected-shot invalidation | Integrated |
| Shot planning and animatic domain | Integrated |
| H3 capability checks, durable worker and media vault | Integrated; live paid workflow remains blocked |
| Budget policy/authorization/accounting service and API | Integrated at `4997ecc`; 1,122 tests/typecheck/build and six built HTTP checks passed at that milestone |
| Atomic reservation + provider submission | Integrated at `e2624d7`; 80 focused tests and typecheck pass |
| Human approvals, canonical generation recipe and retakes | Approval history, human API, canonical recipes and reversible manual take selection integrated through `546636e`; 12 focused tests/typecheck pass; independent selection review accepted |
| Provider proof storage/composition | Storage integrated at5de5ead; provider account/session observation + synchronous submit guard (I01-B6-P) ACCEPTED 2026-10-05: source 74b5b8a integrated as 21e1e7a on zcode/production-core, independent review passed, 23/23 file tests + focused 2/2 + consumer 11/11 + typecheck/diff clean; two resume defects fixed (type narrowing, post-close lock orphan). Composer (C) and runtime wiring (W) pending; W must fix the close/init worker-lock race |
| Script proposals, audio import/mix, assembly and export | Pending |
| Actual reviewed short/long films and release recovery | Pending |

Current delivery policy: finish usable core features first with minimal functional verification. Expanded coverage follows. UI redesign and YouTube/SaaS integrations remain deferred. No paid generations or finished film pilots are claimed.

Completed slices are integrated through reviewed commits; 20 idle completed worker worktrees archived after source/evidence preservation with source/evidence recovery records. The original `feat/ui-overhall` checkout and its dirty files remain untouched.

See [HANDOVER.md](HANDOVER.md) and [SESSION_STATE.json](SESSION_STATE.json) for exact source ownership, evidence, limits and next commands.

Continuous delivery: each reviewed, verified slice lands immediately on the root branch; its idle worktree is archived after evidence preservation. Latest code78426b7 includes storage and executable usage policy; combined8focusedchecks/typecheck pass. Stopweekly<=1% or five-hour<=2%; no5%reserve.

Local branch cleanup:24 completed/redundant branches deleted after patch-equivalence/source/evidence checks and verified local recovery bundle. Retained root/activeprovider/original/master. Exact audit: reports/local-branch-cleanup-20261004.json.

Usage pause (historical, Codex account):weekly1% /five-hour69%remaining paused the prior Codex writer on 2026-10-04. Resumed and completed 2026-10-05 by the ZCode team; ZCode orchestration is not gated by the Codex account window, and no live/paid/authenticated provider calls were or are authorized — all I01-B6 verification is offline. Next: freeze I01-B6-C composer boundary, then I01-B6-W runtime (mandatory close/init lock-race fix). Proof composer+worker estimated1–2active days; first uploadable core pilot roughly5–10active development days.

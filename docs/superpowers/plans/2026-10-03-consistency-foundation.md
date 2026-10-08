# Consistency Foundation Implementation Plan

> **For agentic workers:** Use subagent-driven-development with isolated worktrees; controller reviews requirements and code before integration.

**Goal:** Stop silent loss of requested production references and canonical story entities.

**Architecture:** Extend shared generation preflight with an explicit strict policy and add a pure story canon validator consumed by the runner. Existing provider Strategy ports and service Facades remain intact.

**Tech Stack:** Next.js, TypeScript, Vitest; no new dependencies.

## Task 1: Strict generation reference policy (render-policy worker)
Files: `lib/domain/reference-policy.ts`, its test; `lib/services/generation.service.ts`, `lib/services/generation.service.frames.test.ts`.
- [x] Add failing tests invoking runGeneration with `referencePolicy: "strict"`: unsupported start, unsupported end, unsupported context, over-capacity, missing cached image, malformed reference array. Assert no provider invocation.
- [x] Run `npm test -- lib/services/generation.service.frames.test.ts` and retain failure evidence.
- [x] Add `export type ReferencePolicy = "best-effort" | "strict"` and a pure capability validator receiving the effective ModelDescriptor and requested start/end/count. Return field-specific violations; service maps these to GenerationServiceError.
- [x] Validate policy as optional (absent means legacy best effort); reject unknown values. Strict parsing rejects rather than filters/truncates arrays. Add optional policy on ValidatedRequest so legacy persisted jobs and fixtures remain valid.
- [x] After model swap, reject incompatible inputs before reading/rendering. Strict load failure propagates, context refs never truncate. Maintain existing permissive behavior for legacy requests.
- [x] Run focused tests + typecheck and commit only owned files.

## Task 2: Canonical story inputs (story worker, parallel with Task 1)
Files: `lib/story/canon.ts`, its test; `lib/story/server-runner.ts`, its test.
- [x] Add failing tests for deleted story cast, unknown per-scene cast, unknown world/scene location and resolved location description injection.
- [x] Run `npm test -- lib/story/server-runner.test.ts lib/story/canon.test.ts` and retain failure evidence.
- [x] Add a pure `validateStoryCanon(story, characters, locations)` function yielding field/scene/id violations. Validate explicit IDs; free text remains allowed. Reject scene characters not in declared story cast when a cast was explicitly declared. Do not add async database dependencies.
- [x] Runner maps violations to GenerationServiceError before state mutation at start. Validate again on run advancement and post-keyframe advancement before enqueue; halt with scene error if canon changed during a run.
- [x] Pass resolved location rows to composeShot at start, keyframe composition and scene update. Use existing scene/world fallback policy consistently.
- [x] Run focused tests + typecheck and commit only owned files.

## Task 3: Integration and evidence (orchestrator)
- [x] Review worker diffs against task acceptance and legacy compatibility.
- [x] Cherry-pick worker commits sequentially onto codex/production-core.
- [x] Run `npm test`, `npm run typecheck`, `npm run build`; record real output and limitations in TASKS.md.
- [x] Save provider research and phased master plan, distinguishing built work from planned capabilities.
- [x] Preserve branch/worktree for follow-up; no deployment or paid renders required for these changes.

## Reviewed scope additions and final evidence

Review required preserving all canonical refs before preflight in `lib/story/keyframe.ts`, using the same scene-local cast for prompt/keyframe/QC, preserving canonical location descriptions even when named in prose, and rejecting explicit provider frame drops before either inline or durable completion. Tests cover these paths. `lib/jobs/executor.ts` and its tests, keyframe and shot composer tests are included in the final increment.

Baseline: 799 tests passed. Final: `npm test` passed 835 tests / 78 files; `npm run typecheck` exit 0; `npm run build` exit 0; `git diff --check` exit 0. Code reviewed through `5fa1370`. Original worktree remains on `feat/ui-overhall` with its prior dirty files unchanged.

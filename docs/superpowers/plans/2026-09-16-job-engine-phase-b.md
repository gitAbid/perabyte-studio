# Durable Job Engine (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renders become server-side durable jobs — a provider ref is persisted the moment a render is submitted, an in-process executor owns time via staleness (not a wall-clock connection budget), and the browser becomes a disposable observer — so restarts, navigation, and provider backlogs stop losing or cutting healthy renders.

**Architecture:** Providers expose `submitJob`/`pollJob` (Sogni project ids and relay request ids become persisted `providerRef`s; Pollinations stays synchronous and is inline-wrapped). A `jobs.repository` (`.studio/jobs.json`) holds `JobRecord`s; a `jobs/executor` singleton runs FIFO, one in-flight job per (provider, kind) lane, polls every 2.5 s, fails on provider failure, staleness (no successful poll for `renderTimeouts.staleness`), or an absolute cap. The client `requestGeneration` keeps its exact signature but submits to `/api/jobs` and polls; a `RendersTray` badge in the sidebar shows live activity; the detached-render machinery is deleted (structurally obsolete — the job record IS the durable thing).

**Tech Stack:** Existing stack; no new dependencies. Fake timers for executor tests.

**Spec:** `docs/superpowers/specs/2026-09-16-durable-jobs-and-story-management-design.md` (Phase B)

**Worktree:** `.worktrees/feat/job-engine`, branch `feat/job-engine`.

---

### Task 0: Worktree + baseline

- [ ] Create worktree, install deps, copy `.env.local`, confirm 429 tests green (same recipe as Phase A Task 0).

---

### Task 1: `renderTimeouts.staleness` setting

**Files:** Modify `lib/repositories/provider-config.repository.ts`, `app/settings/**` (RenderTimeouts section), tests.
- Add `staleness: number` to `RenderTimeoutsConfig` (default 300 s, clamp 60–1800), to defaults, sanitize, and merge.
- Settings page Render timeouts section gains a "Staleness limit" field with the copy: "Fail a render when the provider stops reporting progress for this long."
- [ ] Tests: defaults include staleness 300; patch + clamp + round-trip through the file. Run provider-settings tests; commit `feat(settings): render staleness knob`.

### Task 2: JobProvider contract (`lib/providers/types.ts`)

```ts
/** Result of one provider poll for a durable job. */
export type JobPollResult =
  | { status: "running"; progress?: ProviderProgress }
  | { status: "completed"; artifacts: GeneratedArtifact[] }
  | { status: "failed"; retryable: boolean; message: string };

/** Providers whose renders are server-side jobs with a persistent ref. */
export interface JobProvider {
  submitJob(request: NormalizedGenerationRequest, model: ModelDescriptor, ctx: ProviderContext): Promise<{ ref: string }>;
  pollJob(ref: string, model: ModelDescriptor, ctx: ProviderContext): Promise<JobPollResult>;
  cancelJob?(ref: string): Promise<void>;
}
export function asJobProvider(p: unknown): JobProvider | null { … } // structural cast
```

- [ ] Add the types (pure addition); typecheck; commit.

### Task 3: Sogni submit/poll split

**Files:** Modify `lib/providers/sogni/sogni.provider.ts`, `lib/providers/sogni/client.ts`; adapt `sogni.provider.test.ts`.

Design: a module-level `continuations: Map<string, { project; completion; stopReadout }>` keyed by project id.
- `submitJob` = `createProject` minus the race: create → wire jobCompleted last-frame capture → completion promise → store continuation → return `{ ref: project.id }`. The readout interval is replaced: `pollJob` derives progress from the same project getters via an extracted `describeProjectProgress(project)` (pure, testable).
- `pollJob(ref)`:
  - continuation present → `Promise.race([completion, NOW])`; settled → completed (`toArtifacts`) or failed; else → `describeProjectProgress` → running.
  - no continuation (server restarted) → `client.projects.get(ref)` → map RawProject status (`completed` → collect `workerJobs[].resultUrl` → completed; `errored/cancelled` → failed; else → running with status-derived message). 404/lost → failed retryable ("render reference lost — please re-run").
- `cancelJob(ref)` = continuation?.project.cancel() best-effort.
- `generateImage/generateVideo` = thin legacy wrappers: submit + poll-in-a-loop with the env deadline → on deadline throw `ProviderError(…504 retryable, "still rendering on Sogni…raise the limit")` — **no detach, no RenderCutOff/raceCompletion/detachSogniCompletion** (deleted).
- client.ts slice gains optional `get(id): Promise<RawProject>` (feature-detected: `(client.projects as any).get?.` guard, documented).
- [ ] Tests: submit/poll happy path with the fake client; restart re-attach branch (no continuation → fake `get` returns completed project with resultUrl); deadline wrapper. Delete detach-specific tests. Commit.

### Task 4: apikey-fan submit/poll split

**Files:** Modify `lib/providers/apikey-fan/apikey-fan.provider.ts`; adapt tests.
- Video: `submitJob` = POST create (reuse payload build + 400 image-field degrade) → `{ ref: request_id }`. `pollJob` = GET status → done → `downloadVideo` → completed artifacts; failed/expired → failed; else running + progress message (extract the existing ticker into pure form). `generateVideo` = legacy wrapper (submit + poll loop + env deadline, throw 504 retryable, **no detach**).
- Image: stays synchronous (`generateImage` unchanged) — the executor inline-wraps it.
- Delete `detachApiKeyFanVideo`, `DETACHED_*`, `pollDeadlineMs` export (inline the deadline read).
- [ ] Tests: submit/poll happy path, failure branch, create-400 degrade; delete detach tests. Commit.

### Task 5: jobs repository (`lib/repositories/jobs.repository.ts`)

```ts
export interface JobRecord {
  id: string;                       // job_<base36>
  provider: string; kind: "image" | "video"; modelId: string;
  /** Final normalized request with frame REFS (bytes re-loaded at submit). */
  request: SerializedGenerationRequest;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  providerRef?: string;
  progress?: ProviderProgress;      // throttled persistence
  result?: GeneratedMedia[];
  error?: string; retryable?: boolean;
  effectiveModelId?: string; effectiveModelLabel?: string; frameUsed?: boolean;
  clientTag?: string;               // s_<story>:<sceneId> | undefined (solo)
  createdAt: number; startedAt?: number; finishedAt?: number;
}
```
Same thin-fs pattern (`.studio/jobs.json`, cache, sanitize-on-load dropping rows missing id/provider/kind/status; `setJobsPathForTests`). API: `list/put/patch/remove`, `listActive()` (queued+running), `listRecoverable()` (queued|running).
- [ ] Tests: round-trip incl. request refs + result media; malformed-row drop; listActive/listRecoverable. Commit.

### Task 6: executor (`lib/jobs/executor.ts`)

Singleton; injectable deps for tests (`{ jobs, now, pollIntervalMs, providerFor(kind) → ImageProvider&VideoProvider }`).
- `enqueue(record)` persists queued + `kick()`.
- Lanes `${provider}:${kind}`, FIFO, one in-flight. `start(record)`: status running/startedAt, resolve model (registry), JobProvider?
  - yes → load frame bytes from refs (`loadFrame` reuse via exported generation.service helper or move `loadFrame` to `lib/services/frames.ts`) → `submitJob` → persist providerRef → poll loop.
  - no → inline task: `generateImage/Video` with `AbortSignal.timeout(cap)`; artifacts → same completion path (Pollinations).
- Poll loop (2.5 s): success → heartbeat=now (+ progress persist ≤5 s); result mapping per contract.
- Failure rules: pollJob failed → failed(retryable); staleness (`now − heartbeat > stalenessMs` → next miss is a probe; `> 2×stalenessMs` → failed retryable "provider went quiet"); absolute cap `JOB_CAP = { image: 30m, video: 60m }` → failed retryable mentioning Settings; AbortError from cancel → canceled (best-effort provider.cancelJob).
- Completion: `persistArtifacts` (exported from generation.service) → result media → completed/finishedAt.
- `recover()`: on first service init — `listRecoverable()`: queued → enqueue; running with providerRef & JobProvider → re-attach poll loop (Sogni restart branch handles state); running w/o ref or non-job provider → failed retryable "interrupted by restart".
- [ ] Tests with fake timers + stub providers: serialization order, inline-wrap path, staleness fail, cap fail, cancel, recover-all three branches, completion persists media. Commit.

### Task 7: jobs service + API routes

`lib/jobs/jobs.service.ts`: `createJob(body)` = `validateGenerationRequest` + extracted `prepareGeneration(body)` (refactor out of runGeneration: model resolve/frames/i2v swap/LoRA/uncensored normalize — runGeneration reuses it too) → JobRecord queued → executor. `getJob`, `listActive`, `cancel`, `awaitJob(id, { signal, onProgress })` for the legacy shim. Boot: module init calls `executor.recover()` once (guarded).
Routes: `POST /api/jobs` → 202 `{ job }`; `GET /api/jobs?active=1|story=<id-prefix>`; `GET /api/jobs/[id]`; `POST /api/jobs/[id]/cancel`. Thin controllers, nodejs runtime, no-store.
- [ ] Tests: createJob validation failures (no record written), body → serialized request round-trip; routes via direct handler invocation pattern used elsewhere. Commit.

### Task 8: client — job-backed `requestGeneration` + job store + RendersTray

- `lib/generation.ts`: same `GenerateInput`; POST `/api/jobs` with the IDENTICAL body (assert serialized body in tests — the LoRA lesson); poll `GET /api/jobs/[id]` every 2 s (progress → onProgress; 202→running); completed → `GenerationResponse` from job (requestId=job.id, media=result, effective*/frameUsed); failed → GenerationError; abort → POST cancel + throw AbortError. Poll uses a plain loop; page-close kills only the polling.
- `lib/job-store.ts`: module singleton external store; polls `/api/jobs?active=1` every 4 s while subscribers > 0; exposes `useActiveJobs(): { count, items: {id, kind, progress?, href} }` (href: clientTag startsWith `s_` → `/story?id=…` else `/generate/{kind}`).
- `components/RendersTray.tsx`: pill in the sidebar footer area (SiteChrome) — spinner + count + top job's percent; hidden when zero. Zero new routes.
- [ ] Tests: fetch-body assertions, progress mapping, abort→cancel call, store polling lifecycle (fake fetch). Commit.

### Task 9: remove detached-render machinery

- Delete: `lib/providers/detached-renders.ts`, `lib/repositories/pending-renders.repository.ts` (+test), `app/api/renders/pending/`.
- GeneratorScreen.tsx + story/page.tsx: remove absorb pollers + toasts referencing attachment.
- generation.service: drop `pending` flag usage + detached wording in the timeout branch; `ApiError.pending` stays in types (harmless) or is removed with its client reads.
- [ ] Grep clean: `detached|renders/pending|pending-renders|recordDetachedRender` → only historical docs. Full suite + typecheck. Commit.

### Task 10: build + live verification + merge

- `npm run build`.
- Live (dev on :3000, Sogni): solo image via UI → job visible in `/api/jobs?active=1` while rendering → completed; RendersTray shows count during render. Story 2 scenes chained → completes.
- **Restart survival** (the Phase B headline): start a story video/image render, `kill` the dev server mid-render, restart, reopen the story → the scene completes from the persisted providerRef (Sogni re-attach) — verify job transitions running→completed post-restart.
- Staleness: temporarily set staleness 60s + model with stuck queue? (optional, log-based verification acceptable).
- Merge `feat/job-engine` --no-ff; delete branch/worktree; memory update.

## Self-review

- Spec coverage: jobs.repository ✓(T5), provider contract ✓(T2–4), executor ✓(T6), job API ✓(T7), client + tray ✓(T8), cleanup ✓(T9), staleness knob ✓(T1). Story chaining stays client-side (Phase C).
- Sequenced so the suite stays green after every task: additions first (T2–8), removals last (T9).
- Risks: Sogni SDK `projects.get` raw shape (mitigated: feature-detect + failed-retryable fallback); NDJSON progress parity (provider progress objects map 1:1 — same ProviderProgress type).

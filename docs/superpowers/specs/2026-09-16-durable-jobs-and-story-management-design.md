# Durable Jobs + Story Management: server-side records, serialized job engine, server-side story runner

Date: 2026-09-16 · Status: awaiting review

## Problem

Renders live inside an HTTP request and stories live inside one browser.

- **Stories are browser-bound.** Story definitions are `Asset` records in
  `localStorage` (`perabyte.assets.v2`); the editor only reopens whatever id
  sits in `sessionStorage.perabyte.active_story`. History lists stories but
  there is no path back into the editor. Clearing storage, switching browser,
  or a full quota loses every scene, prompt, and chain ref.
- **Generation time is provider weather.** Sogni queue backlog and relay load
  swing renders between ~30 s and 15+ min. The server holds the request open
  with a fixed budget (`AbortSignal.timeout`, default 5 m image / 10 m video).
  When the budget loses the race we cut a healthy render into the
  detached-recover dance, and that dance is fragile:
  - `PendingRender` records never store the provider job id — the continuation
    holds it in memory, so **a server restart orphans every detached render**
    until 24 h pruning.
  - Absorption needs exactly the right page open (`GeneratorScreen` for solo,
    `/story` for that story); History never absorbs.
  - Boot-time resume exists (`StoreBootstrap` calls `appRunner.rehydrate` on
    every load) but can only see stories still in that browser's store —
    a story generated elsewhere, or after a storage clear, has nothing to
    resume from.
- **Navigation kills renders.** The story runner and in-flight generation
  requests live in page components; navigating to Settings (or anywhere) and
  back loses the run and strands scenes.

## Decisions (user-confirmed)

1. Self-hosted long-lived Node is the only supported runtime; the Vercel
   question is deferred (legacy sync path keeps working there, unsupported).
2. Serialized rendering per lane for now; concurrency is a later phase.
3. Phase 3 (server-side story runner, tab-closed rendering) is in scope.
4. All records move server-side; binaries go through a storage-bucket service
   so a cloud bucket backend can slot in later.
5. Generations (solo image/video, story scenes, character looks) must survive
   page changes, Settings visits, and coming back — with no gratuitous UX.

## Do we need a database?

**No — not at this scale.** The pattern stays what the repo already runs:
one single-writer Node process owning small human-scale datasets, each behind
a thin JSON-file repository with an in-process cache (the
`settings`/`characters`/`pending-renders` pattern).

Interaction pattern after this change:

| Data | Where | Write pattern | Read pattern |
| --- | --- | --- | --- |
| Media binaries | media bucket (`.media-cache/`, `/api/media?f=`) | once per render | on view |
| Assets (History), stories, characters, settings | JSON repositories | human-rate CRUD + job transitions | cached snapshot, revalidated on mutation |
| Job records | `jobs.repository` (evolves pending-renders) | state transitions (a few per render); heartbeats kept in memory, flushed ~30 s | UI polls every 2–3 s per open tab (serializes the in-memory cache, not disk) |

Peak load ≈ 1 disk write/s and a few cached reads/s — negligible. Nothing
MB-scale ever enters records (binaries stay in the bucket).

**Upgrade triggers**, in order: multiple Node processes or query needs beyond
"list all" → SQLite (same file-style seam); multi-user/cloud → Postgres. The
repositories are the only seam; nothing above them changes.

## Design

Three phases, each an independently shippable branch that leaves the app
working.

### Phase A — Server-side records (assets + stories)

No render-behavior change; delivers durable, cross-browser stories and History.

1. **`lib/storage/bucket.ts`** — formalize the existing `MediaRepository`
   interface into a `StorageBucket` (`put/get/delete/stat/list`); the disk
   impl keeps current refs and the `/api/media?f=` contract byte-identical.
   Future S3/R2 impls swap in behind it.
2. **`lib/repositories/assets.repository.ts`** + **`stories.repository.ts`**
   — thin JSON-file repos (`.studio/assets.json`, `.studio/stories.json`),
   same shape as today's client `Asset`. `stories.json` rows are
   story-kind Assets (scenes, settings, cast ids, run state in Phase C).
3. **`/api/assets` CRUD** (GET/POST/PATCH/DELETE) and **`/api/stories` CRUD**
   (+ `GET /api/stories/:id`). The story editor becomes addressable:
   `/story?id=<id>` opens any story; `sessionStorage` stays only as
   "resume where I was".
4. **History goes server-side.** `app/history` reads `/api/assets`; the old
   localStorage store becomes a one-time import bridge (client POSTs its
   `assets.v2` rows once, sets a migrated flag, keeps them read-only as
   fallback). Demo seed rows are created server-side on first boot.
5. **Wire `appRunner.rehydrate()`** on story mount (it exists, tested) so
   mid-run stories resume cleanly when reopened — interim win until Phase C
   makes this server-side.

### Phase B — Durable job engine

Renders become server jobs; the HTTP request stops being the unit of work.

1. **`lib/repositories/jobs.repository.ts`** — evolves `pending-renders`:

   ```ts
   interface JobRecord {
     id: string;
     provider: string;
     kind: "image" | "video";
     modelId: string;
     request: NormalizedGenerationRequest;  // snapshot at submit
     status: "queued" | "running" | "completed" | "failed" | "canceled";
     providerRef?: string;                  // Sogni projectId / relay requestId
     heartbeatAt?: number;                  // last provider poll tick
     progress?: ProviderProgress;
     result?: GeneratedMedia[];
     error?: string;
     storyRef?: `${string}:${string}`;      // storyId:sceneId
     createdAt: number; startedAt?: number; finishedAt?: number;
   }
   ```

2. **Provider job contract** (`lib/providers/types.ts`): add
   `submit(request, model, ctx) → { ref }` and
   `poll(ref) → { status, media?, progress?, error? }` alongside the existing
   `generate*`. Sogni already polls live project getters every 2 s; apikey.fan
   already polls its `request_id`; Pollinations completes instantly. The
   providerRef is now **persisted**, so a boot-time rescan re-attaches pollers
   — the restart hole closes.
3. **`lib/jobs/executor.ts`** — in-process singleton. FIFO per
   (provider, kind) lane, **one in-flight job per lane** (serialized, per
   decision #2). Failure semantics replace the fixed wall-clock budget:
   - provider reports failure → failed (retryable where the provider says so);
   - **staleness**: no provider tick for `maxStalenessMs` (Settings → Render
     timeouts gains this; default 5 m) → probe the provider once; silent for
     2× staleness → failed-retryable;
   - absolute safety cap per job (default 30 m image / 60 m video).
   A 20-minute backlog render now finishes calmly; a hung one dies in minutes
   — predictable because the knobs measure *our* wait, not provider load.
4. **Job API**: `POST /api/jobs` (202 `{id}`), `GET /api/jobs?active|story=`,
   `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`. No SSE — the UI polls.
5. **`requestGeneration` (client) becomes job-backed** with the same signature
   and `GenerationResponse` (submit → poll → resolve; NDJSON progress ticks
   mapped through). Solo generator, story runner, and character looks all call
   it, so **every render survives navigation with zero call-site changes**.
   `/api/generate` stays as a thin shim (create job, await, stream lines) for
   the legacy path. Story chaining is intentionally unchanged in this phase —
   the client runner still advances scenes while the tab is open; Phase C
   moves the trigger server-side.
6. **`RendersTray`** — one minimal global surface (badge in the existing
   sidebar): active-job count + live progress; click jumps to the origin page
   (`/story?id=` or `/generate`). A single client job store (module singleton,
   like `lib/store.ts`) backs it; every page mount reads server truth, so
   navigating away and back always shows current state.
7. **Cleanup**: detached-render plumbing (`detached-renders.ts`, absorb
   pollers, `/api/renders/pending`) is superseded and removed.

### Phase C — Server-side story runner (tab-closed rendering)

1. The story record gains run state; `POST /api/stories/:id/generate`
   validates prompts and enqueues scene jobs in order (one at a time).
2. On each scene completion the **executor** advances the chain server-side:
   it patches the scene into the story record (url, mime, effective model,
   frameUsed, safety state — the fields the client runner writes today),
   derives the end frame (provider end-frame export → the image itself for
   image scenes → last-frame extraction), and enqueues the next scene.
   Extraction
   uses ffmpeg when present; otherwise prompt-only chaining — the exact
   semantics of today's `backfillFailed` path, so behavior degrades the same
   way.
3. Cast anchors compose server-side (`composeSceneWithCharacters` is already a
   pure module); the Uncensored gate resolves at submit time.
4. `/story?id=` becomes a console over the story record: edit, reorder,
   submit, cancel, per-scene re-run — reading live per-scene progress from job
   records. The tab can close mid-run and the story keeps rendering; reopening
   shows it further along.

## Non-goals (explicitly deferred)

Vercel/serverless job mode · concurrency beyond one lane per (provider, kind)
· SSE/websockets · queue-position flourish beyond "N queued" · multi-user,
auth, or a database · cloud bucket backend (interface only).

## Testing

- Executor: fake timers + stub providers — lane serialization, staleness
  fail, boot re-attach from persisted providerRef, cancel, transition writes.
- Repositories: temp-path suites per the settings-repo pattern; localStorage
  import idempotence.
- Story runner: chain advance, ffmpeg-missing degrade, per-scene re-run
  server-side.
- Client: `requestGeneration` job-backed — assert on the **serialized fetch
  body** (the LoRA-drop lesson), progress mapping, navigation-away survival.
- All existing suites stay green.

## Rollout

Three branches in order — `feat/server-records`, `feat/job-engine`,
`feat/story-server-runner` — each merged to master only after tests + live
smoke (real Sogni render, mid-render navigation, server restart mid-render,
recovered scene attach). Each merge leaves the app fully working.

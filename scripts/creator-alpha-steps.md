# Creator Alpha golden path — step/selector map

What `scripts/verify-creator-alpha.mjs` encodes, step by step. Source of truth
for every selector is the component file listed per step; if a selector drifts,
fix it here AND in the script.

- Spec: docs/perabyte_studio_feature_specs/19_SUBAGENT_PLAYBOOK.md §13
- Script: `node scripts/verify-creator-alpha.mjs [baseUrl]` (default `http://localhost:3300`)
- Modes: `GOLDEN_PATH_MODE=ui` (default, never spends) | `full` (controlled live run)
- Screenshots: `gui-test-screenshots/creator-alpha/NN-<slug>-pass|FAILED.png`
- Idempotency: every created entity is prefixed `QA Golden` / `qa_golden_` plus a
  per-run stamp (`RUN_ID` = base36 timestamp), so re-runs create fresh entities
  and never collide with previous runs.
- Exit code: 0 only when no step FAILED. `GATED` steps are spend-gated
  disclosures, not failures.

## Modes at a glance

| Step | ui mode (default) | full mode |
| --- | --- | --- |
| 1–6 | executed (`/api/jobs` mocked: instant sheet + plates) | executed (real renders = spend) |
| 7 Generate Story | ready-to-spend assert + SPEND GATE + budget probe | clicks the real proposal |
| 8 Approve Story | executed | executed |
| 9 Generate Anchor | plan prereqs executed; submit ready-to-spend assert + SPEND GATE | plan prereqs executed; quote+enqueue clicked; job polled |
| 10 Approve Anchor | GATED (honest-empty assert) | executed via approval workspace |
| 11 Generate Take | gate-reason assert (ANCHOR_APPROVAL_REQUIRED) + SPEND GATE | quote+enqueue clicked; job polled |
| 12 Select Take | GATED (no-selection-controls assert) | executed |
| 13 Build First Cut | export-page prerequisite-chain assert + SPEND GATE | API-driven assembly + UI run-qc |
| 14 Export MP4 | GATED (no download controls assert) | final review + MP4 download |

## Steps

### 1. Create Workspace — `/workspaces/new` → `/workspaces/{id}`
Component: `components/workspaces/WorkspaceCreateForm.tsx`
- `[data-testid=workspaces.workspace.create.page]` (page ready)
- `[data-testid=workspaces.workspace.create.name]` ← `QA Golden Workspace <RUN_ID>`
- `[data-testid=workspaces.create.next]` ×2 (Basics → Format → Review & create; `[data-testid=workspaces.create.step-2|3]` seen)
- `[data-testid=workspaces.create.submit]` ("Create workspace")
- PASS: URL matches `/workspaces/<id>`, h1 contains the workspace name.

### 2. Create Character — `/character/new` (stays on page)
Component: `components/character/StepSimple.tsx` + `CharacterSheetPanel.tsx`
- `getByLabel("Character Prompt")` ← sheet prompt
- `getByRole("button", { name: "Render sheet" })` → wait text `6 of 6 views rendered`
- `getByLabel("Character name")` ← `QA Golden Character <RUN_ID>`
- `getByRole("button", { name: "Save", exact: true })`
- PASS: toast `Saved — attach it from the Character pill in Solo or Story.`
- ui mode: the 6 renders complete instantly via the `/api/jobs` mock; full mode
  performs 6 real image jobs (spend, logged).

### 3. Approve Character Canon — `/character` → `/character/{id}`
Component: `components/character/CharacterLibrary.tsx`, `CharacterDetail.tsx`
- `a[aria-label="Open <character name> details"]` (library row link)
- `[data-testid=character.approve]` ("Approve") — the explicit human act
- PASS: text `This version is the character's canon.` and `[data-testid=character.approval]` reads `approved`.

### 4. Create Environment — `/environments/new` → `/environments/{id}`
Component: `components/environments/EnvironmentCreate.tsx`
- `[data-testid=environments.create.field.name]` ← `QA Golden Environment <RUN_ID>`
- `getByLabel("Description")` ← establishing prose
- `[data-testid=environments.create.generate]` ("Generate plates") → wait `4 of 4 plates ready`
- `[data-testid=environments.create.variants.card.select-0]` (select plate 1)
- `[data-testid=environments.create.save]` ("Save environment")
- PASS: URL `/environments/<id>`, h1 contains the environment name.
- ui mode: plates mocked; full mode: 4 real image jobs (spend, logged).

### 5. Approve Environment Canon — `/environments/{id}`
Component: `components/environments/EnvironmentDetail.tsx`
- `[data-testid=environments.detail.approve]` ("Approve")
- PASS: toast `Main canon approved — the plate stays stable while views render.` and `[data-testid=environments.detail.approval]` reads `approved`.

### 6. Create Production — `/production/new` → `/production/{projectId}`
Component: `components/production/project-canon.tsx` (`ProjectCreationFlow`)
- `getByLabel("Project name")` ← `QA Golden Production <RUN_ID>`; `getByLabel("Profile")` → `storybook-short-v1`
- "Next: Cast" → `getByLabel("Entity ID")` #0 ← `char_qa_golden_<RUN_ID>`; `getByLabel("Description")` #0
- "Next: World" → `getByLabel("Entity ID")` #0 ← `loc_qa_golden_<RUN_ID>` (kind `location` is the default)
- "Add another world draft" → "World 2": `getByLabel("Entity kind")` #1 → `style`; `getByLabel("Entity ID")` #1 ← `style_qa_golden_<RUN_ID>`
  - The story must pin a location AND a style revision or the plan builder (step 9) raises `LOCATION_REQUIRED`/`STYLE_REQUIRED`; adding the style draft here pins all three canon revisions at creation.
- "Next: Script" → `getByLabel("Script text")` ← one paragraph (one beat → one shot; bounds full-mode spend to one anchor/take/export)
- "Create project"
- PASS: URL `/production/<projectId>`, heading with the project name. `projectId` captured from the URL.

### 7. Generate Story — `/production/{id}/story` (+ fallback `/production/{id}/script`)
Components: `components/production/story/IdeaComposer.tsx`, `shared.tsx`, `project-canon.tsx` (script editor)
- `[data-testid=story.page]`, `[data-testid=story.empty]`, `[data-testid=story.idea]`
- `[data-testid=story.idea.input]` ← the QA idea; `[data-testid=story.engine.provider]` / `[data-testid=story.engine.model]` (writing-engine picker)
- `[data-testid=story.idea.submit]` ("Generate story draft") — the paid confirmation
- ui mode: NEVER clicked. Asserts the ready-to-spend state, logs `SPEND GATE`, then probes the budget identity with a free GET
  `/api/production/projects/{id}/budget?providerId=sogni&unit=spark_token`.
- full mode: engine selected (first available), submit clicked; outcome classified from `[data-testid=story.idea.status]`:
  `Draft request accepted — proposal …` = PASS; `Story generation isn't funded yet.` (fail-closed 403 BUDGET_BLOCKED) = explicit FAIL.
- EXPECTED TODAY (both modes): budget identity is unavailable → the step FAILS with
  `server proposals are fail-closed BUDGET_BLOCKED — server entitlement not configured — see handoff`
  and the run exits 1. This is the documented environment gap, not a script bug.
- FALLBACK (both modes, logged): the human Script editor saves the same immutable story-revision contract —
  `/production/{id}/script`: `getByLabel("Script text")`, `getByRole("button", { name: "Save script revision" })`,
  banner `/Saved — created immutable story revision/`. Keeps steps 8–14 exercisable with zero spend.

### 8. Approve Story — `/production/{id}/story`
Component: `components/production/story/ApproveBar.tsx`
- `[data-testid=story.approve.bar]` → `[data-testid=story.approve.toggle]` ("Approve story")
- `[data-testid=story.approve.form]`; tick all five: `[data-testid=story.approve.check.protagonist_goal]`,
  `…check.cause_consequence_order`, `…check.earned_resolution`, `…check.plot_fidelity`, `…check.spoken_lines`
- `[data-testid=story.approve.submit]` ("Approve this story")
- PASS: `[data-testid=story.approve.status]` contains `Story approved`.

### 9. Generate Storyboard Anchor — prereqs `/production/{id}/plan`, then `/production/{id}/anchors`
Components: `components/production/plan-builder.tsx`, `components/production/storyboard.tsx`
- Prereqs (free, executed in both modes): `[data-testid=plan-page]`, `[data-testid=plan-builder]`,
  `[data-testid=create-plan-button]` (must be enabled; its issues text is the failure output) →
  `[data-testid=plan-created-banner]`; then for `shotplan` and `animatic`:
  `[data-testid=<kind>-approve-workspace]` (tick every checkbox) + `[data-testid=<kind>-approve-button]` → `[data-testid=<kind>-approved]`.
  The anchors page gates on the approved plan + animatic.
- `[data-testid=anchors-page]`; `[data-testid=anchor-empty]` (honest per-shot empty state)
- `[data-testid=anchor-provider-input]` → `sogni`; `[data-testid=anchor-model-input]` (first option, if the catalog has entries)
- `[data-testid=anchor-submit-button]` ("Request quote and enqueue anchor generation") — the paid confirmation;
  `[data-testid=anchor-submit-gate-reasons]` names what is missing when gated.
- ui mode: ready-to-spend assert + `SPEND GATE` (no click). full mode: click → job accepted → poll
  `[data-testid=reload-button]` until `[data-testid=approval-workspace]` appears (JOB_TIMEOUT, default 15 min).

### 10. Approve Anchor — `/production/{id}/anchors`
Component: `components/production/storyboard.tsx` (`ApprovalWorkspace`)
- ui mode: GATED — asserts NO `[data-testid=approval-workspace]` exists without a completed anchor job (nothing fabricated).
- full mode: on the workspace — tick every checklist checkbox (identity, wardrobe, location, props, framing),
  fill `input[id$='-vision-ack']` when present (vision status ≠ pass requires the acknowledgement),
  fill `input[id$='-idempotency']`, click "Submit approved" → text `Decision recorded`.

### 11. Generate Take — `/production/{id}/takes`
Component: `components/production/storyboard.tsx` (`TakeSubmitForm`)
- `[data-testid=takes-page]`; `[data-testid=take-empty]` (honest empty state)
- ui mode: `[data-testid=take-submit-gate-reasons]` must name `ANCHOR_APPROVAL_REQUIRED` → `SPEND GATE`.
- full mode: `[data-testid=take-provider-input]` → `sogni`, `[data-testid=take-model-input]`,
  `[data-testid=take-submit-button]` — clicked; outcome classified as in step 9; poll `[data-testid=reload-button]`
  until `[data-testid=take-row]` appears.

### 12. Select Take — `/production/{id}/takes`
Component: `components/production/storyboard.tsx`
- ui mode: GATED — asserts zero `[data-testid=select-take-button]` without real candidates.
- full mode: prerequisite take approval via `[data-testid=approval-workspace]` (tick all seven take checklist items,
  idempotency key, "Submit approved"), then `[data-testid=select-take-button]` → PASS when
  `[data-testid=reverse-selection-button]` appears.

### 13. Build First Cut — `/production/{id}/export` (ui) / API chain (full)
Components: `components/production/export.tsx`; first-cut UI is a Wave-3 placeholder (`/first-cut` route does not exist yet).
- ui mode: `[data-testid=export-page]` + `[data-testid=export-empty]` must name the prerequisite chain
  (takes, audio mix, manifest, QC) → `SPEND GATE` (assembly withheld).
- full mode (API-driven; mirrors scripts/pilot-short-portrait.mjs — the audio mixing screen is outside the golden-path UI):
  1. `POST /api/production/assets/import` — one silent 48 kHz WAV narration + a music bed (multipart, rights attested)
  2. `POST /api/production/projects/{id}/audio` — beat-aligned cues, `mixSettings` as in the pilot
  3. `POST /api/production/approvals` — `targetKind: "audio"` with the 7-item audio checklist
  4. `POST /api/production/projects/{id}/manifests` — shotplan + animatic + mix revisions, selected takes, selection version
  5. `POST /api/production/projects/{id}/exports` — manifest id + expected hash → poll GET until `qc_pending`
  6. UI: `[data-testid=export-item]` → `[data-testid=run-qc]` → wait `ready_for_review` / Final review

### 14. Export MP4 — `/production/{id}/export`
Component: `components/production/export.tsx`
- ui mode: GATED — asserts the honest empty pipeline (no `[data-testid=download-final]`, `[data-testid=download-draft]`, `[data-testid=run-qc]`).
- full mode: `[data-testid=final-review-form]` → tick `narrative`/`visual`/`audio`/`captions`
  (`getByLabel("Checklist <id> passed")` + note), `[data-testid=approve-final]` → `[data-testid=final-badge]`,
  then `[data-testid=download-final]` → Playwright download saved as
  `gui-test-screenshots/creator-alpha/14-export-download-*.mp4` (filename must end `.mp4`).

## Known gaps (honest disclosures)

1. **Server entitlement not configured (expected failure today).** Story proposals are fail-closed
   403 `BUDGET_BLOCKED` until a text entitlement + reviewed policy + project budget authorization are
   installed. Step 7 fails with the instructive message in both modes; steps 8–14 continue on the
   human-written fallback revision. Fix path: docs/production/pilots/ (policy load + budget authorization),
   then re-run with `GOLDEN_PATH_MODE=full`.
2. **Step 7 proposal→apply flow.** A `full`-mode proposal success only proves the proposal was accepted
   ("proposals never auto-apply"); the apply-to-revision flow is not part of this script. Downstream steps
   always run on the script-editor revision.
3. **No first-cut UI (at authoring time).** `/first-cut` was a Wave-3 placeholder and the export page had
   no "create export" control (creation happens via the manifest + exports API, or the worker). Full-mode
   assembly is therefore API-driven (step 13) with the export page used for QC/final review/download.
   NOTE: an uncommitted `/first-cut` page (`app/first-cut/page.tsx`, testids `first-cut.picker`,
   `first-cut.empty`, `first-cut.stage`, `first-cut.rebuild`, `first-cut.export-link`) appeared in this
   worktree from parallel work while this script was authored. Once it is integrated, step 13 (both modes)
   should be upgraded to drive `/first-cut?projectId=…` and its rebuild action instead of the API chain.
4. **Full mode ≥ step 9 is UNVERIFIED until a controlled live run.** The full-mode branches (anchor/take
   submission, approvals workspace, API assembly, final review, download) were written against the current
   components and the pilot protocol but cannot execute against a fail-closed dev server. Expect selector
   drift on first live run; failure output names the step and expectation.
5. **ui-mode library canon is client-side.** Character/environment libraries (steps 2–5) persist in
   localStorage of the script's browser context — the approvals there are library-level. The server-side
   canon (what shots consume) is pinned by the production wizard (step 6). Both are exercised.
6. **Single-shot film.** The QA script is one paragraph → one beat → one shot, bounding a full-mode run to
   exactly one anchor + one take + one export render.
7. **Steps 2/4 renders are mocked in ui mode** at the `/api/jobs` boundary (pattern: verify-character-sheet.mjs).
   Production spend endpoints (`/api/production/*`) are never mocked.

## Environment / config

- `GOLDEN_PATH_BASE_URL` (default `http://localhost:3300`; positional argv[2] overrides)
- `GOLDEN_PATH_MODE` = `ui` | `full` (default `ui`)
- `GOLDEN_PATH_RENDER_TIMEOUT_MS` (default 600000), `GOLDEN_PATH_JOB_TIMEOUT_MS` (900000, full mode),
  `GOLDEN_PATH_EXPORT_TIMEOUT_MS` (1800000, full mode), `GOLDEN_PATH_STEP_TIMEOUT_MS` (120000)
- `.env.local` is loaded (no-override) via the readFileSync pattern of verify-custom-providers-gui.mjs;
  no secrets are read or printed by this script.
- Server must already be healthy (`GET /api/production/health` fail-fast); the script never starts it.

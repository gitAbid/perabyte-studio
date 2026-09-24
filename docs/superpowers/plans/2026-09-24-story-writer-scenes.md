# Story Writer scene improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Story Writer produce reviewable cast-aware scenes at a Smart or selected count, and let users collapse every main panel and expand each scene card.

**Architecture:** Keep the existing `/api/writer` split service as the source of structured scene prompts. Extend its scene-count contract for Smart mode, then have `WriterView` generate a preview and save only after review. Keep persistence shape and render pipeline unchanged.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Vitest, Playwright.

---

## File structure

- `lib/domain/writer.ts` — Smart/preset count parsing and write/split instructions.
- `lib/domain/writer.test.ts` — pure count, instruction, and count-validation coverage.
- `lib/services/writer.service.ts` — enforce requested split counts and retry unusable replies.
- `lib/services/writer.service.test.ts` — engine request and count-mismatch retry coverage.
- `lib/writer.ts` — typed browser payload for Smart or numeric scene counts.
- `components/writer/WriterView.tsx` — compact count control, cast chips, split preview/save flow, disclosures.
- `scripts/verify-writer-scenes.mjs` — mocked-browser workflow for cast, scene generation, disclosures, and story save.
- `package.json` — `verify:writer` script.

Design reference: `docs/superpowers/specs/2026-09-24-story-writer-scenes-design.md`.

## Task 1: Add Smart and preset scene-count behavior

**Files:**
- Modify: `lib/domain/writer.ts`
- Modify: `lib/domain/writer.test.ts`

- [x] **Step 1: Write failing domain tests**

Add tests that establish these behaviors:

```ts
it("accepts Smart while preserving numeric scene counts", () => {
  expect(parseWriteBody({ brief: { idea: "a", sceneCount: "smart" } }).sceneCount).toBe("smart");
  expect(parseWriteBody({ brief: { idea: "a", sceneCount: 5 } }).sceneCount).toBe(5);
  expect(parseSplitBody({ draft: "prose", sceneCount: "smart" }).sceneCount).toBe("smart");
});

it("tells Smart mode to use 3–8 natural beats and labels cast as available", () => {
  const text = writeStoryInstruction({
    idea: "a night train mystery",
    sceneCount: "smart",
    tone: null,
    characterNames: ["Ada"],
    uncensored: false,
  });
  expect(text).toMatch(/3.{0,8}8|three.{0,8}eight/i);
  expect(text).toMatch(/available characters/i);
  expect(text).toContain("Ada");
  expect(text).toMatch(/no scene numbers|without scene numbers/i);
});

it("builds Smart and exact-count split instructions", () => {
  expect(splitScenesInstruction("prose", "smart", ["Ada"])).toMatch(/3.{0,8}8|three.{0,8}eight/i);
  expect(splitScenesInstruction("prose", 5, ["Ada"])).toContain("exactly 5 scenes");
});
```

Use existing test imports; add `parseWriteBody`/`parseSplitBody` only if missing.

- [x] **Step 2: Run the focused test and confirm the expected failure**

Run: `pnpm exec vitest run lib/domain/writer.test.ts`

Expected: FAIL because request parsing only accepts numeric counts and the prompts do not define Smart or available-cast behavior.

- [x] **Step 3: Implement the domain contract and instructions**

Export `WriterSceneCount = number | "smart"`. Parse `"smart"` as Smart; keep the current 1–12 clamping and default of 5 for legacy or omitted API values. In `writeStoryInstruction`, Smart asks for 3–8 natural story beats and says not to add numbered scene headings. Numeric values retain their numeric target. When names exist, describe them as available characters and require use of their exact display names where relevant. In `splitScenesInstruction`, Smart requests 3–8 scenes; numeric values request exactly that many. Preserve the current JSON response shape and image/video-specific rules.

- [x] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm exec vitest run lib/domain/writer.test.ts`

Expected: PASS, including all existing writer-domain cases.

- [x] **Step 5: Commit the domain change**

```bash
git add lib/domain/writer.ts lib/domain/writer.test.ts
git commit -m "feat(writer): add smart scene count instructions"
```

## Task 2: Enforce count mode in structured scene splitting

**Files:**
- Modify: `lib/domain/writer.ts`
- Modify: `lib/domain/writer.test.ts`
- Modify: `lib/services/writer.service.ts`
- Modify: `lib/services/writer.service.test.ts`
- Modify: `lib/writer.ts`

- [x] **Step 1: Write failing count-validation and retry tests**

Add a domain test for `sceneCountSatisfied`: numeric counts pass only when the array length equals the count; Smart passes only for 3–8 scenes. Add a service test that returns a wrong-count JSON reply followed by a correct-count reply and asserts two engine calls and the correct scene list. Add a Smart service test with a three-scene response. Include selected names in the split payload and assert the captured user instruction calls them available characters.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm exec vitest run lib/domain/writer.test.ts lib/services/writer.service.test.ts`

Expected: FAIL because the split parser/request type rejects Smart and the service accepts any parseable scene count without checking the requested mode.

- [x] **Step 3: Implement count-aware retry**

Change `SplitRequest.sceneCount` and `WriterPayload` to `WriterSceneCount`. Add a pure `sceneCountSatisfied(scenes, sceneCount)` helper. In `runWriterAction`, accept a parsed split only when the helper passes; otherwise use the existing one-retry path with a stricter instruction that repeats the exact count or Smart range. After both replies fail count/JSON validation, keep the existing retryable error. Keep numeric 1–12 request compatibility for older clients.

- [x] **Step 4: Run focused tests and confirm they pass**

Run: `pnpm exec vitest run lib/domain/writer.test.ts lib/services/writer.service.test.ts`

Expected: PASS, including parse-failure retry, exact-count retry, Smart count range, and existing service cases.

- [x] **Step 5: Commit the service change**

```bash
git add lib/domain/writer.ts lib/domain/writer.test.ts lib/services/writer.service.ts lib/services/writer.service.test.ts lib/writer.ts
git commit -m "fix(writer): validate structured scene counts"
```

## Task 3: Connect Writer to review-before-save scene generation

**Files:**
- Modify: `components/writer/WriterView.tsx`
- Create: `scripts/verify-writer-scenes.mjs`
- Modify: `package.json`

- [x] **Step 1: Write the failing Playwright workflow**

Create a Playwright script that mocks `GET /api/assets`, `GET /api/characters`, `GET /api/settings`, `POST /api/writer`, and `POST /api/assets`. Seed one character named Ada. Verify that:

1. The scene-count menu offers Smart, 3, 5, 8, and 12, with Smart selected on a new draft.
2. Selecting Ada shows an “Available cast” chip.
3. Writing sends `sceneCount: "smart"` and `characterNames: ["Ada"]`.
4. Generating an outline sends the selected scene count, names, media kind, and draft to `/api/writer`; returned prompts appear as numbered scene cards.
5. The outline remains in Writer for review, and Create story saves exactly those prompts plus `meta.characterIds: ["ch_ada"]` before navigating to Story Mode.

Use the project convention `node scripts/verify-writer-scenes.mjs http://127.0.0.1:3100`; fail with a nonzero exit when any check fails.

- [x] **Step 2: Run the workflow against the existing UI and confirm it fails**

Start the app with `pnpm exec next dev -p 3100`, then run `node scripts/verify-writer-scenes.mjs http://127.0.0.1:3100`.

Expected: FAIL at the missing Smart/count menu or structured outline request. Stop the dev server after capturing the expected failure.

- [x] **Step 3: Implement count control, cast visibility, and split/review/save**

In `WriterView`, default new drafts to Smart while mapping legacy numeric local drafts to a supported preset. Replace the 1–12 menu with Smart, Short (3), Standard (5), Detailed (8), and Extended (12). Write requests carry the current count choice and selected character names. Render selected names as cast chips next to the Cast control.

Change the current local `segmentDraftIntoScenes` export path into two actions: Generate outline calls `requestWriterAction` with `action: "split"`, draft, scene count, cast names, media kind, uncensored setting, and model. Store the returned title/scenes as a review preview. Create story saves that preview through `createWriterStoryAsset`; save errors keep the draft and preview in Writer. Invalidate a preview when draft, cast, count, or media kind changes so stale output cannot be saved. Keep Use in Solo on the first reviewed scene prompt.

- [x] **Step 4: Run the workflow and confirm it passes**

Run: `node scripts/verify-writer-scenes.mjs http://127.0.0.1:3100`

Expected: all mocked writer, cast, preview, and save checks pass; no provider render is started.

- [x] **Step 5: Commit the UI flow and browser verification**

```bash
git add components/writer/WriterView.tsx scripts/verify-writer-scenes.mjs package.json
git commit -m "feat(writer): review cast-aware scene outlines"
```

## Task 4: Add collapsible Writer panels and scene cards

**Files:**
- Modify: `components/writer/WriterView.tsx`
- Modify: `scripts/verify-writer-scenes.mjs`

- [x] **Step 1: Extend the failing browser workflow**

Assert that Brief, Draft, and Scene outline each expose an accessible collapse button whose `aria-expanded` becomes `false` and whose content is hidden, and an expand button whose `aria-expanded` returns to `true`. Assert each returned scene card has the same accessible expand/collapse behavior. Run the workflow and confirm the new disclosure assertions fail before implementation.

- [x] **Step 2: Implement accessible disclosures**

Add independent disclosure state for the three panels. Retain each panel header and a compact summary while collapsed; keep the mobile Brief/Draft/Scenes tabs unchanged. Add per-card disclosure state so collapsed cards show their scene label and short excerpt, while expanded cards show the complete generated prompt. Use native buttons with `aria-expanded` and `aria-controls`, stable content IDs, and descriptive labels such as “Collapse story brief” / “Expand story brief” and “Expand scene 1”. All panels and cards start expanded.

- [x] **Step 3: Run the browser workflow and confirm disclosure behavior**

Run: `node scripts/verify-writer-scenes.mjs http://127.0.0.1:3100`

Expected: all count, cast, review/save, and disclosure assertions pass at desktop width. The existing mobile workspace tabs remain visible and selectable at a narrow viewport.

- [x] **Step 4: Commit the disclosure change**

```bash
git add components/writer/WriterView.tsx scripts/verify-writer-scenes.mjs
git commit -m "feat(writer): make writer sections collapsible"
```

## Task 5: Final verification

**Files:** None beyond the preceding tasks.

- [x] Run `pnpm exec vitest run lib/domain/writer.test.ts lib/services/writer.service.test.ts lib/writer-story.test.ts`.
- [x] Run `pnpm run typecheck`.
- [x] Start `pnpm exec next dev -p 3100` and run `node scripts/verify-writer-scenes.mjs http://127.0.0.1:3100`.
- [x] Inspect `git status --short` and the final diff. Confirm no generated browser screenshots or unrelated files are included.

Expected: focused tests, typecheck, and the mocked browser workflow all pass; all changes remain on `codex/writer-scenes`.

## Plan self-review

- **Spec coverage:** Smart/preset counts and structured output are covered by Tasks 1–3; cast visibility and model instructions by Tasks 1 and 3; preview-before-save and preserved asset metadata by Task 3; panel/card disclosures by Task 4; compatibility and verification by Tasks 2 and 5.
- **Placeholders:** No TBD or deferred implementation steps remain. Commands, paths, behavior, and expected outcomes are named for every task.
- **Type consistency:** `WriterSceneCount` is the shared UI/API/domain type; all write/split request flows use it. Story assets continue to receive `string[]` scene prompts and the existing ordered `characterIds`.

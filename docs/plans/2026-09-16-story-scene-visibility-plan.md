# Story Scene Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make story chaining visible — every queued/rendering scene card shows the exact frame it starts from — plus a 2-up scene grid, inline prompt editing, per-scene re-run, and reorder arrows.

**Architecture:** A pure `effectiveChainRef()` helper in `lib/story/chain.ts` (sharing the runner's exact predecessor rule) resolves what each scene starts from; a new `SceneChainBadge` component renders it as a corner overlay. A new `requeueScene()` runner method powers per-scene re-run. All scene edits go through the existing `updateStoryScenes` store path.

**Tech Stack:** Next.js 16 + React 19 + TypeScript, Tailwind (custom tokens), Vitest, zustand-style `lib/store` asset store.

**Spec:** `docs/plans/2026-09-16-story-scene-visibility-design.md`
**Worktree:** `.worktrees/story-scene-visibility` on branch `feature/story-scene-visibility` (copy real `.env.local` in, run `npm install` — worktrees do NOT inherit node_modules; never symlink).

---

### Task 1: `effectiveChainRef` + shared `chainPredecessor` in chain.ts (TDD)

**Files:**
- Modify: `lib/story/chain.ts`
- Test: `lib/story/chain.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/story/chain.test.ts` (keep the existing `resolveChainModelPlan` suite untouched). Note the file already imports from `vitest` and `@/lib/story/chain` — extend those imports:

```ts
import { describe, expect, it } from "vitest";
import {
  chainPredecessor,
  chainPredecessorIndex,
  effectiveChainRef,
  resolveChainModelPlan,
} from "@/lib/story/chain";
import type { StoryScene } from "@/lib/types";

function refScene(partial: Partial<StoryScene> & { id: string }): StoryScene {
  return { prompt: "p", url: null, status: "queued", kind: "image", ...partial };
}

describe("chainPredecessor", () => {
  it("returns the nearest non-canceled scene before the index", () => {
    const scenes = [
      refScene({ id: "s1" }),
      refScene({ id: "s2", status: "canceled" }),
      refScene({ id: "s3" }),
    ];
    expect(chainPredecessor(scenes, 2)?.id).toBe("s1");
    expect(chainPredecessorIndex(scenes, 2)).toBe(0);
    expect(chainPredecessor(scenes, 1)?.id).toBe("s1");
    expect(chainPredecessor(scenes, 0)).toBeUndefined();
    expect(chainPredecessorIndex(scenes, 0)).toBe(-1);
  });
});

describe("effectiveChainRef", () => {
  it("prefers the scene's own manual start frame", () => {
    const scenes = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "pred.png" }),
      refScene({ id: "s2", startImageRef: "mine.png" }),
    ];
    expect(effectiveChainRef(scenes, 1, true)).toEqual({
      state: "manual",
      ref: "mine.png",
    });
  });

  it("chains from the predecessor's derived end frame", () => {
    const scenes = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "f1.png" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(scenes, 1, true)).toEqual({
      state: "chained",
      ref: "f1.png",
      predecessorIndex: 0,
    });
  });

  it("is pending while the predecessor has no derived frame yet", () => {
    const queued = [refScene({ id: "s1" }), refScene({ id: "s2" })];
    expect(effectiveChainRef(queued, 1, true)).toEqual({
      state: "pending",
      predecessorIndex: 0,
    });
    const generating = [
      refScene({ id: "s1", status: "generating" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(generating, 1, true)).toEqual({
      state: "pending",
      predecessorIndex: 0,
    });
    // Completed but the end frame hasn't been backfilled yet.
    const awaitingBackfill = [
      refScene({ id: "s1", status: "completed", url: "a" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(awaitingBackfill, 1, true)).toEqual({
      state: "pending",
      predecessorIndex: 0,
    });
  });

  it("chains across a canceled predecessor", () => {
    const scenes = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "f1.png" }),
      refScene({ id: "s2", status: "canceled" }),
      refScene({ id: "s3" }),
    ];
    expect(effectiveChainRef(scenes, 2, true)).toEqual({
      state: "chained",
      ref: "f1.png",
      predecessorIndex: 0,
    });
  });

  it("is none for the first scene, with continuity off, or with no live predecessor", () => {
    const first = [refScene({ id: "s1", endFrameRef: "f.png" })];
    expect(effectiveChainRef(first, 0, true)).toEqual({ state: "none" });
    const two = [
      refScene({ id: "s1", status: "completed", url: "a", endFrameRef: "f.png" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(two, 1, false)).toEqual({ state: "none" });
    const allCanceled = [
      refScene({ id: "s1", status: "canceled" }),
      refScene({ id: "s2" }),
    ];
    expect(effectiveChainRef(allCanceled, 1, true)).toEqual({ state: "none" });
    expect(effectiveChainRef([], 0, true)).toEqual({ state: "none" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/story/chain.test.ts`
Expected: FAIL — `effectiveChainRef`, `chainPredecessor`, `chainPredecessorIndex` not exported.

- [ ] **Step 3: Implement in chain.ts**

Add to the imports at the top of `lib/story/chain.ts`:

```ts
import type { StoryScene } from "@/lib/types";
```

Append below `resolveChainModelPlan`:

```ts
/**
 * Index of the nearest non-canceled scene before `index`, or -1. A canceled
 * scene is transparent to the chain — this is the single rule the runner and
 * the UI must agree on.
 */
export function chainPredecessorIndex(
  scenes: { status: string }[],
  index: number,
): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (scenes[i].status !== "canceled") return i;
  }
  return -1;
}

/** The nearest non-canceled scene before `index` — undefined means "run
 * without a chain ref" (like scene 1). */
export function chainPredecessor<T extends { status: string }>(
  scenes: T[],
  index: number,
): T | undefined {
  const i = chainPredecessorIndex(scenes, index);
  return i === -1 ? undefined : scenes[i];
}

/** What the scene at `index` starts from, as the UI should show it. Pure —
 * same predecessor rule as the runner, so the preview can't disagree with
 * what actually renders. */
export type EffectiveChainRef =
  | { state: "manual"; ref: string }
  | { state: "chained"; ref: string; predecessorIndex: number }
  | { state: "pending"; predecessorIndex: number }
  | { state: "none" };

export function effectiveChainRef(
  scenes: StoryScene[],
  index: number,
  continuityOn: boolean,
): EffectiveChainRef {
  const scene = scenes[index];
  if (!scene) return { state: "none" };
  if (scene.startImageRef) return { state: "manual", ref: scene.startImageRef };
  if (!continuityOn || index === 0) return { state: "none" };
  const predecessorIndex = chainPredecessorIndex(scenes, index);
  if (predecessorIndex === -1) return { state: "none" };
  const predecessor = scenes[predecessorIndex];
  if (predecessor.endFrameRef) {
    return { state: "chained", ref: predecessor.endFrameRef, predecessorIndex };
  }
  // Predecessor not completed yet, or completed without a derived frame
  // (backfill is attempted at the next schedule) — the chain intent is real,
  // the frame just doesn't exist yet.
  return { state: "pending", predecessorIndex };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/story/chain.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add lib/story/chain.ts lib/story/chain.test.ts
git commit -m "feat(story): effectiveChainRef — pure chain-source resolution shared by UI and runner"
```

---

### Task 2: runner uses the shared helper + gains `requeueScene` (TDD)

**Files:**
- Modify: `lib/story/runner.ts`
- Test: `lib/story/runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/story/runner.test.ts` (the file already has the `scene()` and `story()` factories and `makeDeps()`):

```ts
describe("requeueScene", () => {
  it("requeues a completed scene but never renders on its own", () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", status: "completed", url: "a", endFrameRef: "f1.png" }),
      scene({ id: "s2", status: "completed", url: "b", endFrameRef: "f2.png" }),
    ], { continuity: true }));

    runner.requeueScene("story1", "s2");

    expect(deps.assets.get("story1")!.scenes![1].status).toBe("queued");
    // Idle story: Generate stays the only trigger.
    expect(deps.requestGeneration).not.toHaveBeenCalled();
  });

  it("requeues a failed scene and clears its error", () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", status: "failed", error: "boom" }),
      scene({ id: "s2", status: "queued" }),
    ]));

    runner.requeueScene("story1", "s1");

    const s1 = deps.assets.get("story1")!.scenes![0];
    expect(s1.status).toBe("queued");
    expect(s1.error).toBeUndefined();
  });

  it("never touches a generating scene or unrelated canceled/failed scenes", () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    deps.assets.set("story1", story([
      scene({ id: "s1", status: "queued" }),
      scene({ id: "s2", status: "generating" }),
      scene({ id: "s3", status: "canceled" }),
      scene({ id: "s4", status: "failed", error: "x" }),
    ], { continuity: false }));

    runner.requeueScene("story1", "s2"); // generating → no-op
    runner.requeueScene("story1", "s4"); // failed → queued (only this one)

    const statuses = deps.assets.get("story1")!.scenes!.map((s) => s.status);
    expect(statuses).toEqual(["queued", "generating", "canceled", "queued"]);
  });

  it("picks the requeued scene up when a chained run is in flight", async () => {
    const deps = makeDeps();
    const runner = createStoryRunner(deps);
    let release: (() => void) | null = null;
    deps.requestGeneration = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              requestId: "r",
              status: "completed",
              kind: "image",
              elapsedMs: 1,
              media: [{ id: "m", url: "/api/media?f=new.png", width: 8, height: 8, seed: 1 }],
            });
        }),
    );
    deps.assets.set("story1", story([
      scene({ id: "s1", status: "completed", url: "a", endFrameRef: "f1.png" }),
      scene({ id: "s2" }),
      scene({ id: "s3" }),
    ], { continuity: true }));

    runner.start("story1"); // s2 chains off s1 immediately; s3 waits (capacity 1)
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(1));

    // Re-run scene 1 mid-run: chain capacity keeps it waiting.
    runner.requeueScene("story1", "s1");
    expect(deps.requestGeneration).toHaveBeenCalledTimes(1);

    release?.(); // s2 settles → schedule → s1 (re-queued) renders next
    await vi.waitFor(() => expect(deps.requestGeneration).toHaveBeenCalledTimes(2));
    // s1 renders as scene 1 — no chained start frame.
    const call = deps.requestGeneration.mock.calls[1] as unknown as [
      { startImageRef?: string },
    ];
    expect(call[0].startImageRef).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/story/runner.test.ts`
Expected: FAIL — `runner.requeueScene is not a function` (or equivalent).

- [ ] **Step 3: Implement in runner.ts**

3a. Add the import at the top of `lib/story/runner.ts`:

```ts
import { chainPredecessor } from "@/lib/story/chain";
```

3b. Delete the local `chainPredecessor` (the comment block + function between `continuityOn` and `isRunnable`, currently):

```ts
  /** The nearest non-canceled scene before `index` — a canceled scene is
   * transparent to the chain, so its successor continues from the scene
   * before it. Undefined means "run without a chain ref" (like scene 1). */
  function chainPredecessor(scenes: StoryScene[], index: number): StoryScene | undefined {
    for (let i = index - 1; i >= 0; i -= 1) {
      if (scenes[i].status !== "canceled") return scenes[i];
    }
    return undefined;
  }
```

(Both existing call sites — `isRunnable` and `runScene` — keep working via the import.)

3c. Add the `requeueScene` method to the returned object, right after `removeScene`:

```ts
    /** Requeue ONE settled scene for a re-render (per-scene re-run). Unlike
     * start(), nothing else is reset — unrelated failed/canceled scenes stay
     * put. Re-schedules only while a run is in progress, so this never starts
     * generating on its own (Generate is the only trigger for an idle story). */
    requeueScene(storyId: string, sceneId: string) {
      const scene = deps.getStory(storyId)?.scenes?.find((s) => s.id === sceneId);
      if (!scene || scene.status === "generating") return;
      patch(storyId, sceneId, { status: "queued", error: undefined });
      if (hasInFlight(storyId)) schedule(storyId);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/story/runner.test.ts`
Expected: PASS (all suites, including the pre-existing scheduling tests — the shared predecessor is behavior-identical).

- [ ] **Step 5: Commit**

```bash
git add lib/story/runner.ts lib/story/runner.test.ts
git commit -m "feat(story): runner requeueScene for per-scene re-run; share chainPredecessor with the UI"
```

---

### Task 3: `SceneChainBadge` component

**Files:**
- Create: `components/story/SceneChainBadge.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { useSettings } from "@/lib/repositories/settings.repository";
import type { EffectiveChainRef } from "@/lib/story/chain";

/**
 * Chain-reference badge for one story scene card: shows the exact frame the
 * scene starts from — the previous scene's derived final frame, or the
 * scene's own manual start frame — overlaid bottom-left on the card. Pending
 * chains (frame not derived yet) show a pulsing link instead of a thumb.
 * Click a thumb to enlarge; an 18+ veiled thumb stays blurred and doesn't
 * enlarge (same mask policy as MediaFrame).
 */
export function SceneChainBadge({
  resolution,
  sensitive,
}: {
  resolution: EffectiveChainRef;
  /** The frame's source scene rendered with the safety checker off. */
  sensitive?: boolean;
}) {
  const { settings } = useSettings();
  const [zoomed, setZoomed] = useState(false);
  const masked = Boolean(sensitive) && settings.maskUncensored;

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (resolution.state === "none") return null;
  const ref =
    resolution.state === "manual" || resolution.state === "chained"
      ? resolution.ref
      : undefined;
  const label =
    resolution.state === "manual"
      ? "Your start frame"
      : resolution.state === "chained"
        ? `From Scene ${resolution.predecessorIndex + 1}`
        : `Scene ${resolution.predecessorIndex + 1}'s last frame`;

  return (
    <>
      <div className="absolute bottom-2 left-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-1.5">
        {ref ? (
          <button
            type="button"
            aria-label="Enlarge the reference frame"
            title={masked ? "Reference frame (veiled)" : "Enlarge the reference frame"}
            onClick={() => {
              if (!masked) setZoomed(true);
            }}
            className="shrink-0 overflow-hidden rounded-[10px] border border-border shadow-card"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/media?f=${ref}`}
              alt=""
              className={`size-[52px] object-cover ${masked ? "scale-105 blur-md" : ""}`}
            />
          </button>
        ) : (
          <span
            title={`Continues from Scene ${resolution.state === "pending" ? resolution.predecessorIndex + 1 : ""}'s final frame`}
            className="inline-flex size-[52px] shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border-strong bg-white/90"
          >
            <Icon name="link" size={16} className="animate-pulse text-primary" />
          </span>
        )}
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-white/95 px-2 py-1 text-[10.5px] font-semibold text-ink-soft shadow-card">
          <Icon name="link" size={11} className="shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      </div>
      {zoomed && ref && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Reference frame"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-6"
          onClick={() => setZoomed(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media?f=${ref}`}
            alt="Reference frame"
            className="max-h-full max-w-full rounded-[16px] border border-border bg-white object-contain shadow-lift"
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            aria-label="Close"
            onClick={() => setZoomed(false)}
            className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-full bg-white/95 text-ink-soft shadow-card transition-colors hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/story/SceneChainBadge.tsx
git commit -m "feat(story): SceneChainBadge — per-scene chain reference thumb with enlarge"
```

---

### Task 4: Page wiring — 2-up grid + badges on queued/rendering cards

**Files:**
- Modify: `app/story/page.tsx`

All edits anchor on exact existing code; apply top-to-bottom (line numbers shift as you go).

- [ ] **Step 1: Imports**

Extend the story imports (line ~7 and ~40):

```tsx
import { SceneChainBadge } from "@/components/story/SceneChainBadge";
```

```tsx
import {
  chainPredecessorIndex,
  effectiveChainRef,
  resolveChainModelPlan,
  type EffectiveChainRef,
} from "@/lib/story/chain";
```

- [ ] **Step 2: Add the sensitivity resolver (module scope, above the component)**

```tsx
/** Whether a badge's reference frame comes from an 18+ render — the thumb
 * inherits the veil the source scene's own card would show. */
function chainBadgeSensitive(
  resolution: EffectiveChainRef,
  scenes: StoryScene[],
  scene: StoryScene,
): boolean {
  if (resolution.state === "chained") {
    return scenes[resolution.predecessorIndex]?.safe === false;
  }
  return scene.safe === false;
}
```

- [ ] **Step 3: Grid columns + slot floor**

Replace:

```tsx
          <div className="grid flex-1 content-start gap-4 sm:grid-cols-3">
            {Array.from({ length: Math.max(3, scenes.length) }, (_, index) => {
```

with:

```tsx
          <div className="grid flex-1 content-start gap-4 sm:grid-cols-2">
            {Array.from({ length: Math.max(2, scenes.length) }, (_, index) => {
```

- [ ] **Step 4: Replace the inline predecessor loop with the shared helper**

Replace:

```tsx
              // The nearest non-canceled scene before this one — canceled
              // scenes are transparent to the chain (mirrors the runner).
              let chainPredIndex = -1;
              for (let i = index - 1; i >= 0; i -= 1) {
                if (scenes[i]?.status !== "canceled") {
                  chainPredIndex = i;
                  break;
                }
              }
```

with:

```tsx
              // The nearest non-canceled scene before this one — canceled
              // scenes are transparent to the chain (mirrors the runner).
              const chainPredIndex = chainPredecessorIndex(scenes, index);
```

`waitingFor` below it keeps working unchanged (`chainPredIndex >= 0`).

- [ ] **Step 5: Resolve the badge per card**

Directly after the `waitingFor` const, add:

```tsx
              const chainResolution: EffectiveChainRef = typed
                ? effectiveChainRef(scenes, index, continuityOn)
                : { state: "none" };
```

- [ ] **Step 6: Badge on the rendering card**

Inside the `typed.status === "generating"` branch, insert between the skeleton `</div>` and the cancel `<button`:

```tsx
                      {/* A rendering scene shows only a resolvable frame —
                          "pending" here would mean a prompt-only run. */}
                      {chainResolution.state === "manual" ||
                      chainResolution.state === "chained" ? (
                        <SceneChainBadge
                          resolution={chainResolution}
                          sensitive={chainBadgeSensitive(chainResolution, scenes, typed)}
                        />
                      ) : null}
```

- [ ] **Step 7: Badge on the queued card**

Inside the `typed.status === "queued"` branch, insert before the remove `<button`:

```tsx
                      <SceneChainBadge
                        resolution={chainResolution}
                        sensitive={chainBadgeSensitive(chainResolution, scenes, typed)}
                      />
```

- [ ] **Step 8: Typecheck + existing tests**

Run: `npx tsc --noEmit && npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add app/story/page.tsx
git commit -m "feat(story): chain-frame badges on queued/rendering scene cards + 2-up grid"
```

---

### Task 5: Inline prompt editing (queued/canceled scenes)

**Files:**
- Modify: `app/story/page.tsx`

- [ ] **Step 1: State + commit handler**

Add next to the other page state (after `draftRefs`):

```tsx
  // Inline scene-prompt editing: one scene at a time, queued/canceled only.
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // Guards against Escape unmounting the textarea and its blur committing
  // the edit anyway.
  const editCancelingRef = useRef(false);
```

Add near the other queue handlers (after `handleRemoveScene`):

```tsx
  /** Commit an inline prompt edit. Empty prompts can never render, so they're
   * refused (composer parity); the runner reads prompts at run time, so edits
   * land for any scene that hasn't started. */
  function commitScenePromptEdit(sceneId: string) {
    setEditingSceneId(null);
    if (!storyId) return;
    const next = editDraft.trim();
    if (!next) {
      toast.push("A scene needs a prompt before it can render.", "error");
      return;
    }
    updateStoryScenes(storyId, (list) =>
      list.map((scene) =>
        scene.id === sceneId ? { ...scene, prompt: next.slice(0, PROMPT_MAX) } : scene,
      ),
    );
    toast.push("Scene prompt updated.");
  }
```

- [ ] **Step 2: Replace the prompt line**

Inside the scene map, add an `editable` const next to `chainResolution`:

```tsx
              const editable = typed?.status === "queued" || typed?.status === "canceled";
```

Replace:

```tsx
                  {typed?.prompt && (
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-soft">
                      {typed.prompt}
                    </p>
                  )}
```

with:

```tsx
                  {typed?.prompt &&
                    (editingSceneId === typed.id && editable ? (
                      <textarea
                        autoFocus
                        rows={2}
                        maxLength={PROMPT_MAX}
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                        onBlur={() => {
                          if (editCancelingRef.current) {
                            editCancelingRef.current = false;
                            return;
                          }
                          commitScenePromptEdit(typed.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            editCancelingRef.current = true;
                            setEditingSceneId(null);
                          }
                        }}
                        className="mt-0.5 w-full resize-none rounded-[8px] border border-primary/40 bg-white px-2 py-1.5 text-[12px] leading-snug text-ink outline-none"
                      />
                    ) : (
                      <p
                        onClick={
                          editable
                            ? () => {
                                setEditDraft(typed.prompt);
                                setEditingSceneId(typed.id);
                              }
                            : undefined
                        }
                        title={editable ? "Click to edit the prompt" : undefined}
                        className={`mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-soft ${
                          editable ? "cursor-text hover:text-ink" : ""
                        }`}
                      >
                        {typed.prompt}
                      </p>
                    ))}
```

(Commit = blur; Esc cancels. Enter inserts a newline — prompts are freeform, matching the composer.)

- [ ] **Step 3: Reset editing state in `reset()`**

In `reset()`, add:

```tsx
    setEditingSceneId(null);
    setEditDraft("");
```

- [ ] **Step 4: Typecheck + tests + commit**

Run: `npx tsc --noEmit && npm test`
Expected: green.

```bash
git add app/story/page.tsx
git commit -m "feat(story): click-to-edit prompts on queued/canceled scene cards"
```

---

### Task 6: Per-scene re-run + failed scene card

**Files:**
- Modify: `app/story/page.tsx`

- [ ] **Step 1: Handler**

Add after `handleRemoveScene`:

```tsx
  /** Re-run ONE settled scene: park it back in the queue. A run in flight
   * picks it up after the current scene; an idle story waits for Generate
   * (the only trigger). Later scenes keep their results — same chain
   * semantics as cancel. */
  function handleRerunScene(sceneId: string) {
    if (!storyId) return;
    appRunner.requeueScene(storyId, sceneId);
    toast.push(
      scenes.some((scene) => scene.status === "generating")
        ? "Scene re-queued — it renders after the current scene."
        : "Scene re-queued — press Generate to render it.",
    );
  }
```

- [ ] **Step 2: Wrap completed media + hover re-run button**

Replace the completed-media branch:

```tsx
                  {typed?.url ? (
                    typed.kind === "video" ? (
                      <VideoStage
```

— the whole conditional becomes a wrapped group. Replace:

```tsx
                  {typed?.url ? (
                    typed.kind === "video" ? (
                      <VideoStage
                        posterUrl={typed.url}
                        videoUrl={
                          typed.mime?.startsWith("video/") || isVideoSource(typed.url)
                            ? typed.url
                            : undefined
                        }
                        title={typed.prompt}
                        durationSeconds={Number(String(settings.duration).replace("s", "")) || 5}
                        sensitive={typed.safe === false}
                      />
                    ) : (
                      <MediaFrame
                        src={typed.url}
                        alt={typed.prompt}
                        ratio={`${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`}
                        sensitive={typed.safe === false}
                      />
                    )
                  ) : typed && typed.status === "generating" ? (
```

with:

```tsx
                  {typed?.url ? (
                    <div className="group relative">
                      {typed.kind === "video" ? (
                        <VideoStage
                          posterUrl={typed.url}
                          videoUrl={
                            typed.mime?.startsWith("video/") || isVideoSource(typed.url)
                              ? typed.url
                              : undefined
                          }
                          title={typed.prompt}
                          durationSeconds={Number(String(settings.duration).replace("s", "")) || 5}
                          sensitive={typed.safe === false}
                        />
                      ) : (
                        <MediaFrame
                          src={typed.url}
                          alt={typed.prompt}
                          ratio={`${ASPECTS[settings.aspect].width}/${ASPECTS[settings.aspect].height}`}
                          sensitive={typed.safe === false}
                        />
                      )}
                      <button
                        type="button"
                        aria-label={`Re-render scene ${index + 1}`}
                        title="Render this scene again (later scenes keep their current results)"
                        onClick={() => handleRerunScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-white/95 text-ink-soft opacity-0 shadow-card transition-opacity hover:text-ink focus:opacity-100 group-hover:opacity-100"
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </div>
                  ) : typed && typed.status === "generating" ? (
```

- [ ] **Step 3: Failed scenes get a card (with an always-visible re-run)**

Failed scenes currently render no media box at all (they fall through every branch). Insert a failed branch between the canceled branch and `index === 0 && !typed`:

```tsx
                  ) : typed && typed.status === "failed" ? (
                    <div className="relative">
                      <div
                        className="flex w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-red-200 bg-white px-3 text-center"
                        style={ratioStyle}
                      >
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-red-600 shadow-card">
                          <Icon name="alert" size={10} /> Failed
                        </span>
                        <p className="mt-2 line-clamp-2 text-[11px] text-muted">
                          {typed.error ?? "The render didn't make it."}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Re-render scene ${index + 1}`}
                        title="Render this scene again"
                        onClick={() => handleRerunScene(typed.id)}
                        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-white/95 text-ink-soft shadow-card transition-colors hover:text-ink"
                      >
                        <Icon name="refresh" size={13} />
                      </button>
                    </div>
                  ) : index === 0 && !typed ? (
```

- [ ] **Step 4: Drop the now-redundant "failed" label chip**

Remove from the label row:

```tsx
                    {typed?.status === "failed" && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-600">
                        <Icon name="alert" size={11} /> failed
                      </span>
                    )}
```

- [ ] **Step 5: Typecheck + tests + commit**

Run: `npx tsc --noEmit && npm test`
Expected: green.

```bash
git add app/story/page.tsx
git commit -m "feat(story): per-scene re-run (hover on completed, visible on failed card)"
```

---

### Task 7: Reorder arrows

**Files:**
- Modify: `app/story/page.tsx`

- [ ] **Step 1: Handler**

Add after `handleRerunScene`:

```tsx
  /** Swap a scene with its neighbor. Purely an ordering edit — the chain
   * follows scene order, nothing re-renders from this. */
  function moveScene(index: number, delta: -1 | 1) {
    if (!storyId) return;
    const target = index + delta;
    if (target < 0 || target >= scenes.length) return;
    updateStoryScenes(storyId, (list) => {
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
```

- [ ] **Step 2: Arrows in the label row**

The label row starts `<div className="mt-2 flex items-center gap-1.5">`. Immediately before its closing `</div>` (after the chained-next link `<Icon name="link" ... />` conditional), add — guarded on `typed` so empty placeholder slots get no arrows:

```tsx
                    {typed && (
                      <div className="ml-auto flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={`Move scene ${index + 1} earlier`}
                          title="Move earlier"
                          disabled={running || index === 0}
                          onClick={() => moveScene(index, -1)}
                          className="inline-flex size-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Icon name="chevron-down" size={12} className="rotate-180" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move scene ${index + 1} later`}
                          title="Move later"
                          disabled={running || index === scenes.length - 1}
                          onClick={() => moveScene(index, 1)}
                          className="inline-flex size-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Icon name="chevron-down" size={12} />
                        </button>
                      </div>
                    )}
```

(No `arrow-up`/`arrow-down` icons exist in `Icon.tsx` — `chevron-down` + `rotate-180` is the established trick.)

- [ ] **Step 3: Typecheck + tests + commit**

Run: `npx tsc --noEmit && npm test`
Expected: green.

```bash
git add app/story/page.tsx
git commit -m "feat(story): reorder scenes with up/down arrows (disabled while rendering)"
```

---

### Task 8: Full verification

- [ ] **Step 1: Full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests pass (baseline ~358 + new), no type errors, build succeeds.

- [ ] **Step 2: Browser pass (dev server on port 3100, fake renders)**

Start the dev server in the worktree (`.env.local` + `npm install` required first):

```bash
npm run dev -- -p 3100
```

Drive it with a Playwright-by-node script that spies `/api/generate` (fulfilled fake NDJSON — never real renders, per the never-use-real-providers-for-verify rule):

- Route spy: fulfill with `data: {"type":"progress","percent":50}` … then a final media event pointing at an existing `.media-cache` ref.
- Scenario A (image story): add 2 scenes via composer + Add scene, press Generate.
  - Before Generate: scene 2 badge shows pulsing link + "Scene 1's last frame"; center pill "Waiting for Scene 1".
  - After scene 1 completes: scene 2 badge flips to a real thumb + "From Scene 1".
  - Click thumb → enlarge overlay opens; Esc closes.
- Scenario B: click a completed scene's prompt → textarea; edit; blur; label updates; toast appears. Esc path cancels.
- Scenario C: hover a completed card → refresh button; click → toast "press Generate…"; press Generate → only that scene re-renders (spy call count).
- Scenario D: move scene 2 up → order swaps in store; arrows disabled at bounds and while running.
- Scenario E (uncensored): toggle the uncensored setting + mask on → badge thumb blurred, enlarge suppressed.
- Layout: 1280px viewport → 2 cards per row; 390px viewport → 1 per row.
- Screenshot each state to `/tmp/story-visibility/` and inspect.

- [ ] **Step 3: Fix anything found, re-run the suite, then merge**

Fix → `npm test && npm run build` green → merge to master per the repo's parallel-safe merge recipe (rebase worktree branch on master, resolve, `npm test` on master after merge), remove the worktree, delete the branch.

---

## Out of scope (unchanged from spec)

- Results page scene grid, regenerate-downstream, drag-and-drop reordering.

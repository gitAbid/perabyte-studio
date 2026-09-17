# Story Scene Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a queued/canceled/failed story scene loads its prompt, kind, frames and settings into the left composer ("Editing scene N"); Update saves sparse per-scene overrides that the server runner merges over story settings.

**Architecture:** Scenes gain an optional sparse `settings` override merged over story settings by `sceneRequestBody` at render time. Scene edits flow through the existing `mutateStoryScenes` read-modify-write path (new `update` op). The story page owns a scene-edit buffer that stashes/restores the composer draft around edits; `PromptComposer` gets three small props (`actionLabel`, `actionDisabled`, `hideRenderCount`).

**Tech Stack:** Next.js client page + vitest (unit), playwright (GUI smoke in `scripts/`).

**Worktree:** `/Users/abid/Projects/perabyte-studio/.worktrees/story-scene-edit` (branch `feat/story-scene-edit`). All paths below are relative to it. Spec: `docs/superpowers/specs/2026-09-17-story-scene-edit-design.md`.

---

### Task 1: Types + pure scene-settings helpers (TDD)

**Files:**
- Modify: `lib/types.ts` (StoryScene interface, after `endImageRef?: string;`)
- Create: `lib/story/scene-settings.ts`
- Test: `lib/story/scene-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/story/scene-settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_SETTINGS } from "@/lib/constants";
import {
  applySceneOverrides,
  diffSettingsBaseline,
  mergedSceneSettings,
} from "./scene-settings";

describe("mergedSceneSettings", () => {
  it("returns the story settings untouched without overrides", () => {
    const story = { ...DEFAULT_IMAGE_SETTINGS, aspect: "16:9" as const };
    expect(mergedSceneSettings(story, {})).toEqual(story);
  });

  it("layers the scene's sparse overrides over the story settings", () => {
    const story = { ...DEFAULT_IMAGE_SETTINGS, aspect: "16:9" as const, style: "Cinematic" };
    const merged = mergedSceneSettings(story, {
      settings: { aspect: "9:16", duration: "10s" },
    });
    expect(merged.aspect).toBe("9:16");
    expect(merged.duration).toBe("10s");
    expect(merged.style).toBe("Cinematic");
  });
});

describe("diffSettingsBaseline", () => {
  it("records only the touched keys", () => {
    const baseline = { ...DEFAULT_IMAGE_SETTINGS };
    const buffer = { ...baseline, aspect: "1:1" as const };
    expect(diffSettingsBaseline(baseline, buffer)).toEqual({ aspect: "1:1" });
  });

  it("ignores keys outside the per-scene override set", () => {
    const baseline = { ...DEFAULT_IMAGE_SETTINGS };
    const buffer = { ...baseline, count: 3, seed: "42", enhance: true };
    expect(diffSettingsBaseline(baseline, buffer)).toEqual({});
  });

  it("compares lora selections by content", () => {
    const baseline = { ...DEFAULT_IMAGE_SETTINGS };
    const buffer = {
      ...baseline,
      loras: [{ loraId: "l1", strength: 0.8 }],
    };
    expect(diffSettingsBaseline(baseline, buffer)).toEqual({
      loras: [{ loraId: "l1", strength: 0.8 }],
    });
  });
});

describe("applySceneOverrides", () => {
  it("merges touched keys over existing overrides", () => {
    expect(applySceneOverrides({ aspect: "9:16" }, { style: "Anime" })).toEqual({
      aspect: "9:16",
      style: "Anime",
    });
  });

  it("accepts no existing overrides", () => {
    expect(applySceneOverrides(undefined, { modelId: "prov:model-b" })).toEqual({
      modelId: "prov:model-b",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/story/scene-settings.test.ts`
Expected: FAIL — module `./scene-settings` not found.

- [ ] **Step 3: Add the type field**

In `lib/types.ts`, inside `StoryScene`, directly after `endImageRef?: string;`, add:

```ts
  /** Sparse per-scene settings overrides, merged over the story's settings at
   * render time (lib/story/scene-settings.ts). Absent = the scene follows
   * story settings exactly. */
  settings?: Partial<GenerationSettings>;
```

- [ ] **Step 4: Implement the module**

Create `lib/story/scene-settings.ts`:

```ts
/**
 * Per-scene settings overrides (pure). A scene may pin a sparse subset of the
 * composer's render settings; everything it doesn't override keeps following
 * the story-level settings at render time. The same merge runs on the server
 * runner (sceneRequestBody) and in the console UI (tiles + scene edit mode),
 * so the preview can never disagree with what renders.
 */
import type { GenerationSettings, StoryScene } from "@/lib/types";

/** The fields a scene may override. Kind and frames are first-class scene
 * fields; count/seed never applied to story scenes (the runner forces
 * count 1 and sends no seed); safe/enhance follow the content gate. */
const OVERRIDE_KEYS = [
  "aspect",
  "resolution",
  "style",
  "duration",
  "negativePrompt",
  "modelId",
  "loras",
] as const satisfies readonly (keyof GenerationSettings)[];

export type SceneSettingsOverride = Pick<GenerationSettings, (typeof OVERRIDE_KEYS)[number]>;

/** The settings a scene renders with: story settings, then its overrides. */
export function mergedSceneSettings(
  story: GenerationSettings,
  scene: Pick<StoryScene, "settings">,
): GenerationSettings {
  return { ...story, ...(scene.settings ?? {}) };
}

/** Fields changed between the edit-mode entry baseline and the exit buffer —
 * the sparse override Update stores. Touched keys are pinned even when they
 * equal the story value; untouched keys never enter the patch. */
export function diffSettingsBaseline(
  baseline: GenerationSettings,
  buffer: GenerationSettings,
): SceneSettingsOverride {
  const patch: Record<string, unknown> = {};
  for (const key of OVERRIDE_KEYS) {
    if (!settingsEqual(baseline[key], buffer[key])) patch[key] = buffer[key];
  }
  return patch as SceneSettingsOverride;
}

function settingsEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return a === b;
}

/** Final override set for a scene: keys touched this session replace (or add
 * to) whatever the scene already overrode. */
export function applySceneOverrides(
  existing: Partial<GenerationSettings> | undefined,
  patch: SceneSettingsOverride,
): SceneSettingsOverride {
  return { ...(existing ?? {}), ...patch };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/story/scene-settings.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/story/scene-settings.ts lib/story/scene-settings.test.ts
git commit -m "feat(story): per-scene settings overrides — types, merge and diff helpers"
```

---

### Task 2: Runner merges scene settings into the render request (TDD)

**Files:**
- Modify: `lib/story/server-runner.ts` (`sceneRequestBody`, imports)
- Test: `lib/story/server-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `lib/story/server-runner.test.ts` (top-level `describe`, reusing the existing `scene`/`story`/`putStory`/`current` helpers):

```ts
describe("sceneRequestBody per-scene settings", () => {
  it("merges a scene's overrides over the story settings", () => {
    const s = story("merge-1", [
      scene("a", { settings: { aspect: "9:16", modelId: "prov:model-b", style: "Anime" } }),
    ]);
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![0]);
    expect(body.aspect).toBe("9:16");
    expect(body.modelId).toBe("prov:model-b");
    expect(body.style).toBe("Anime");
    // untouched fields still come from the story settings
    expect(body.duration).toBe(s.settings.duration);
  });

  it("renders scenes without overrides exactly from story settings", () => {
    const s = story("merge-2", [scene("a")]);
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![0]);
    expect(body.aspect).toBe(s.settings.aspect);
    expect(body.modelId).toBe(s.settings.modelId ?? null);
  });

  it("story chainModelId wins over a scene model when a start ref exists", () => {
    const s = story("merge-3", [
      scene("a", { status: "completed" }),
      scene("b", { startImageRef: "f1", settings: { modelId: "prov:t2v" } }),
    ], {
      settings: { ...DEFAULT_IMAGE_SETTINGS, chainModelId: "prov:i2v", modelId: "prov:t2v" },
    });
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![1]);
    expect(body.modelId).toBe("prov:i2v");
  });

  it("a scene model override applies under Auto chain (no chainModelId)", () => {
    const s = story("merge-4", [
      scene("a", { status: "completed" }),
      scene("b", { startImageRef: "f1", settings: { modelId: "prov:i2v-custom" } }),
    ], {
      settings: { ...DEFAULT_IMAGE_SETTINGS, modelId: "prov:t2v" },
    });
    putStory(s);
    const body = sceneRequestBody(current(), current().scenes![1]);
    expect(body.modelId).toBe("prov:i2v-custom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/story/server-runner.test.ts`
Expected: the new tests FAIL (`merge-1`: aspect still story value; `merge-4`: modelId still story value).

- [ ] **Step 3: Implement the merge**

In `lib/story/server-runner.ts`:

1. Add the import next to the chain import:

```ts
import { mergedSceneSettings } from "@/lib/story/scene-settings";
```

2. In `sceneRequestBody`, replace the first line of the body:

```ts
export function sceneRequestBody(story: Asset, scene: StoryScene): Record<string, unknown> {
  const settings = mergedSceneSettings(story.settings as GenerationSettings, scene);
```

(everything below stays — `chainModelId`/`modelId` resolution now reads the merged settings).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/story/server-runner.test.ts`
Expected: PASS (all, including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add lib/story/server-runner.ts lib/story/server-runner.test.ts
git commit -m "feat(story): runner renders each scene with its settings overrides merged over story settings"
```

---

### Task 3: Runner "update" mutation op (TDD)

**Files:**
- Modify: `lib/story/server-runner.ts` (`SceneMutation`, new `SceneUpdatePatch`, `mutateStoryScenes`)
- Test: `lib/story/server-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Append (same test file; import `mutateStoryScenes` and `updateProviderConfig` from `@/lib/repositories/provider-config.repository` in the existing import block):

```ts
describe("mutateStoryScenes update", () => {
  function putQueued(id: string, over: Partial<StoryScene> = {}) {
    putStory(story(id, [scene("a", over)]));
    return id;
  }

  it("updates prompt, kind, settings and refs on a queued scene", () => {
    putQueued("upd-1");
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "a",
      patch: {
        prompt: "new prompt",
        kind: "video",
        settings: { aspect: "9:16" },
        startImageRef: "ref-start",
        endImageRef: null,
        runPrompt: "composed prompt",
      },
    });
    const a = updated?.scenes?.[0];
    expect(a?.prompt).toBe("new prompt");
    expect(a?.kind).toBe("video");
    expect(a?.settings).toEqual({ aspect: "9:16" });
    expect(a?.startImageRef).toBe("ref-start");
    expect(a?.endImageRef).toBeUndefined();
    expect(a?.runPrompt).toBe("composed prompt");
  });

  it("refuses a generating scene", () => {
    putQueued("upd-2", { status: "generating" });
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "a",
      patch: { prompt: "nope" },
    });
    expect(updated?.scenes?.[0]?.prompt).not.toBe("nope");
  });

  it("refuses a completed scene", () => {
    putQueued("upd-3", { status: "completed", url: "/api/media?f=x" });
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "a",
      patch: { prompt: "nope" },
    });
    expect(updated?.scenes?.[0]?.prompt).not.toBe("nope");
  });

  it("accepts canceled and failed scenes", () => {
    for (const status of ["canceled", "failed"] as const) {
      const id = `upd-4-${status}`;
      putQueued(id, { status });
      const updated = mutateStoryScenes(storyId, {
        op: "update",
        sceneId: "a",
        patch: { prompt: "retry prompt" },
      });
      expect(updated?.scenes?.[0]?.prompt).toBe("retry prompt");
    }
  });

  it("an explicit empty settings object clears overrides; an absent key preserves them", () => {
    putQueued("upd-5", { settings: { aspect: "9:16" } });
    let updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "a",
      patch: { settings: {} },
    });
    expect(updated?.scenes?.[0]?.settings).toBeUndefined();

    putQueued("upd-6", { settings: { aspect: "9:16" } });
    updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "a",
      patch: { prompt: "same overrides" },
    });
    expect(updated?.scenes?.[0]?.settings).toEqual({ aspect: "9:16" });
  });

  it("clamps the prompt to the configured budget", () => {
    putQueued("upd-7");
    updateProviderConfig({ promptMaxChars: 10 });
    const updated = mutateStoryScenes(storyId, {
      op: "update",
      sceneId: "a",
      patch: { prompt: "0123456789ABCDEF" },
    });
    expect(updated?.scenes?.[0]?.prompt).toBe("0123456789");
    updateProviderConfig({ promptMaxChars: 5000 });
  });
});
```

Note: check the existing `beforeEach` — `updateProviderConfig` writes through `setProviderConfigPathForTests` already configured there; restore the default budget inside the test (as shown) so later tests are unaffected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/story/server-runner.test.ts`
Expected: FAIL — `op: "update"` not in `SceneMutation` (type error) / unknown op ignored.

- [ ] **Step 3: Implement the op**

In `lib/story/server-runner.ts`:

1. Extend the imports:

```ts
import type { Asset, GenerationKind, GenerationSettings, StoryScene } from "@/lib/types";
```

2. Add the patch type next to `SceneMutation`:

```ts
/** Per-scene update from the composer's scene edit mode. Ref values of null
 * clear the ref; `runPrompt` arrives recomposed so a mid-run chain never
 * renders a stale anchor snapshot. An explicit empty `settings` object clears
 * the scene's overrides; an absent key preserves them. */
export interface SceneUpdatePatch {
  prompt?: string;
  kind?: GenerationKind;
  settings?: Partial<GenerationSettings>;
  startImageRef?: string | null;
  endImageRef?: string | null;
  runPrompt?: string;
}
```

3. Extend the union:

```ts
export type SceneMutation =
  | { op: "add"; scene: StoryScene }
  | { op: "remove"; sceneId: string }
  | { op: "move"; sceneId: string; delta: -1 | 1 }
  | { op: "edit"; sceneId: string; prompt: string }
  | { op: "continuity"; value: boolean }
  | { op: "update"; sceneId: string; patch: SceneUpdatePatch };
```

4. In `mutateStoryScenes`, after the `edit` branch and before the `// move` comment, insert:

```ts
  if (mutation.op === "update") {
    const scene = scenes[index];
    // A rendering scene owns its request; a completed scene owns its media.
    // Everything else (queued/canceled/failed) is fair game — the runner
    // reads these fields when the chain reaches the scene.
    if (!scene || scene.status === "generating" || scene.status === "completed") {
      return getStoriesRepository(storyId);
    }
    const patch = mutation.patch;
    const promptMax = getProviderConfig().promptMaxChars;
    const prompt =
      typeof patch.prompt === "string" && patch.prompt.trim()
        ? patch.prompt.trim().slice(0, promptMax)
        : undefined;
    const kind =
      patch.kind === "image" || patch.kind === "video" ? patch.kind : undefined;
    const clearSettings =
      "settings" in patch && !(patch.settings && Object.keys(patch.settings).length);
    const nextSettings = clearSettings
      ? undefined
      : (patch.settings as Partial<GenerationSettings> | undefined);
    patchStoryRepository(storyId, {
      scenes: scenes.map((s) => {
        if (s.id !== mutation.sceneId) return s;
        const next: StoryScene = {
          ...s,
          ...(prompt ? { prompt } : {}),
          ...(kind ? { kind } : {}),
          ...(nextSettings ? { settings: nextSettings } : {}),
          ...(patch.startImageRef !== undefined
            ? { startImageRef: patch.startImageRef ?? undefined }
            : {}),
          ...(patch.endImageRef !== undefined
            ? { endImageRef: patch.endImageRef ?? undefined }
            : {}),
          ...(typeof patch.runPrompt === "string" && patch.runPrompt.trim()
            ? { runPrompt: patch.runPrompt }
            : {}),
        };
        if (clearSettings) delete next.settings;
        return next;
      }),
    });
    return getStoriesRepository(storyId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/story/server-runner.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/story/server-runner.ts lib/story/server-runner.test.ts
git commit -m "feat(story): update mutation op — composer scene edits land server-side with guards"
```

---

### Task 4: PromptComposer — action label/state + hide render-count

**Files:**
- Modify: `components/PromptComposer.tsx`

No unit tests (presentational; exercised by the GUI smoke in Task 7).

- [ ] **Step 1: Add the props**

In the destructured props of `PromptComposer`, after `busy,` add `actionLabel,` `actionDisabled,` `hideRenderCount,`; in the type literal after `busy: boolean;` add:

```ts
  /** Footer action button label — "Update scene" in scene edit mode
   * (default "Generate"). The ⌘+Enter hint follows it. */
  actionLabel?: string;
  /** Disables the footer action button without flipping the footer into
   * cancel mode (used when the selected scene started rendering). */
  actionDisabled?: boolean;
  /** Hides the Variations pill and the Variations + Lock seed rows in the
   * advanced popover — story scenes always render count 1 with no seed. */
  hideRenderCount?: boolean;
```

- [ ] **Step 2: Thread `hideRenderCount` into AdvancedPanel**

Change `AdvancedPanel`'s signature:

```ts
function AdvancedPanel({
  settings,
  onChange,
  onCopyPrompt,
  hideRenderCount = false,
}: {
  settings: GenerationSettings;
  onChange: (patch: Partial<GenerationSettings>) => void;
  onCopyPrompt: () => void;
  hideRenderCount?: boolean;
}) {
```

Wrap the "Variations" `<div>…</div>` block and the "Lock seed" `<label>…</label>` in `{!hideRenderCount && (…)}` (two separate expressions; the negative-prompt block and copy button stay unconditional).

- [ ] **Step 3: Use the props in the body**

1. Variations pill (badge row) — wrap in `{!hideRenderCount && ( … )}`.
2. AdvancedPanel call: `<AdvancedPanel settings={settings} onChange={onChange} onCopyPrompt={onCopyPrompt} hideRenderCount={hideRenderCount} />` — wait, AdvancedPanel is rendered by PromptComposer: pass `hideRenderCount={hideRenderCount}`.
3. Footer + hint:

```tsx
        <span className="hidden text-[11.5px] text-muted lg:block">
          · ⌘ + Enter to {(actionLabel ?? "Generate").toLowerCase()}
        </span>

        {busy ? (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            icon="sparkle"
            onClick={onGenerate}
            disabled={actionDisabled}
            className="ml-auto shrink-0"
          >
            {actionLabel ?? "Generate"}
          </Button>
        )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/PromptComposer.tsx
git commit -m "feat(composer): action label/disabled + hideRenderCount props for scene edit mode"
```

---

### Task 5: Story page — scene edit mode

**Files:**
- Modify: `app/story/page.tsx`

This is the integration task. All snippets land in `StoryPage`.

- [ ] **Step 1: Imports + edit-mode state**

Add to the existing `@/lib/story/chain` import block area:

```ts
import {
  applySceneOverrides,
  diffSettingsBaseline,
  mergedSceneSettings,
} from "@/lib/story/scene-settings";
```

After the `editCancelingRef` declaration, add:

```ts
  // Scene edit mode: the composer shows ONE queued/canceled/failed scene's
  // prompt, kind, frames and settings. The live draft is stashed on entry and
  // restored on exit — editing a scene never destroys an unsaved draft.
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [scenePrompt, setScenePrompt] = useState("");
  const [sceneKind, setSceneKind] = useState<"image" | "video">("image");
  const [sceneSettings, setSceneSettings] = useState<GenerationSettings>({
    ...DEFAULT_IMAGE_SETTINGS,
    kind: "image",
    count: 1,
  });
  const [sceneRefs, setSceneRefs] = useState<{ startImageRef?: string; endImageRef?: string }>({});
  // The merged settings view at entry — the diff baseline for Update.
  const [sceneBaseline, setSceneBaseline] = useState<GenerationSettings | null>(null);
  const stashRef = useRef<{
    prompt: string;
    settings: GenerationSettings;
    kind: "image" | "video";
    refs: { startImageRef?: string; endImageRef?: string };
    promptError?: string;
  } | null>(null);
```

Below the `scenes`/`running` derivations, add:

```ts
  const editing = selectedSceneId !== null;
  const selectedScene = editing ? scenes.find((s) => s.id === selectedSceneId) : undefined;
  const editingIndex = selectedScene ? scenes.indexOf(selectedScene) : -1;
  // Active (composer-facing) values: the scene buffer while editing, the
  // story draft otherwise.
  const activeKind = editing ? sceneKind : kind;
  const activePrompt = editing ? scenePrompt : prompt;
  const activeRefs = editing ? sceneRefs : draftRefs;
  const activeSettings = editing ? sceneSettings : settings;
```

- [ ] **Step 2: Scene-scoped catalog and model**

`useModelCatalog` calls are hooks — add one keyed to the scene kind (declared next to the existing `catalog`):

```ts
  // Catalog for the scene being edited — may differ from the story kind.
  const editCatalog = useModelCatalog(editing ? sceneKind : kind);
```

Replace the existing single catalog usage carefully — keep `catalog` exactly as-is (story-level; the LoRA-snap effect and chain pill stay story-scoped) and derive the composer-facing values after `selectedModel`:

```ts
  const composerCatalog = editing ? editCatalog : catalog;
  const composerModelId = editing
    ? (sceneSettings.modelId ?? editCatalog.defaultModelId)
    : modelId;
  const composerSelectedModel = composerCatalog.models.find((m) => m.id === composerModelId);
```

Then repoint the composer-only derived values (the story-level `selectedModel` stays for the chain pill):

```ts
  const endSupported = Boolean(composerSelectedModel?.frameInput?.end);
  const stylesSupported = composerSelectedModel?.stylesSupported ?? true;
```

(The `loraCapable`/`loraModel` composer props below switch to `composerSelectedModel`.)

- [ ] **Step 3: Enter / exit / update**

Place after `commitScenePromptEdit`:

```ts
  /* --------------------------- scene edit mode --------------------------- */

  function enterSceneEdit(scene: StoryScene) {
    stashRef.current = { prompt, settings, kind, refs: draftRefs, promptError };
    const baseline = mergedSceneSettings(currentSettings(), scene);
    setSelectedSceneId(scene.id);
    setScenePrompt(scene.prompt);
    setSceneKind(scene.kind);
    setSceneSettings(baseline);
    setSceneBaseline(baseline);
    setSceneRefs({
      ...(scene.startImageRef ? { startImageRef: scene.startImageRef } : {}),
      ...(scene.endImageRef ? { endImageRef: scene.endImageRef } : {}),
    });
    setPromptError(undefined);
    setEditingSceneId(null); // one editor per scene — the composer wins
  }

  function exitSceneEdit() {
    setSelectedSceneId(null);
    setSceneBaseline(null);
    const stash = stashRef.current;
    if (stash) {
      setPrompt(stash.prompt);
      setSettings(stash.settings);
      setKind(stash.kind);
      setDraftRefs(stash.refs);
      if (stash.promptError) setPromptError(stash.promptError);
      stashRef.current = null;
    }
  }

  /** Model change inside scene edit mode writes the SCENE buffer — never the
   * global saved pick — with the same LoRA snap the composer path applies. */
  function updateSceneModel(nextModel: string) {
    setSceneSettings((s) => ({
      ...s,
      modelId: nextModel,
      ...(editCatalog.loras.length
        ? {
            loras: snapLorasForModel(
              s.loras ?? [],
              editCatalog.loras,
              editCatalog.models.find((m) => m.id === nextModel)?.model ?? "",
              editCatalog.loraMaxPerRequest,
              userSettings.uncensoredEnabled,
            ),
          }
        : {}),
    }));
  }

  async function handleUpdateScene() {
    const scene = selectedScene;
    if (!scene || !storyId) return;
    if (scene.status === "generating" || scene.status === "completed") {
      toast.push("That scene is rendering — cancel it before updating.", "error");
      return;
    }
    const nextPrompt = scenePrompt.trim();
    if (!nextPrompt) {
      toast.push("A scene needs a prompt before it can render.", "error");
      return;
    }
    const overrides = applySceneOverrides(
      scene.settings,
      diffSettingsBaseline(sceneBaseline ?? currentSettings(), sceneSettings),
    );
    // Anchor-composed prompt recomposed NOW so a mid-run chain never renders
    // a stale snapshot (Generate recomposes again for the whole story).
    const runPrompt = composeSceneWithCharacters(
      nextPrompt,
      attachedCharacters.map((c) => c.spec),
      userSettings.uncensoredEnabled,
    );
    await mutateScene({
      op: "update",
      sceneId: scene.id,
      patch: {
        prompt: nextPrompt.slice(0, promptMax),
        kind: sceneKind,
        settings: Object.keys(overrides).length ? overrides : {},
        startImageRef: sceneRefs.startImageRef ?? null,
        endImageRef: sceneRefs.endImageRef ?? null,
        runPrompt,
      },
    });
    const wasFailed = scene.status === "failed";
    const label = editingIndex + 1;
    exitSceneEdit();
    toast.push(`Scene ${label} updated.`, "success");
    if (wasFailed) {
      // Save + retry in one step — the same requeue the tile button fires.
      void runStoryAction("rerun", { sceneId: scene.id });
    }
  }

  // The selected scene vanished (removed here or in another tab) — leave edit
  // mode and hand the draft back.
  useEffect(() => {
    if (selectedSceneId && scenes.length && !scenes.some((s) => s.id === selectedSceneId)) {
      exitSceneEdit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- exit reads latest state via refs/stash
  }, [scenes, selectedSceneId]);

  // Escape leaves edit mode (not while typing in a form field — the Exit
  // button and clicking the tile again are the other doors).
  useEffect(() => {
    if (!editing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [role='dialog']")) return;
      exitSceneEdit();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing]);
```

Also extend `reset()` (add alongside the existing state clears):

```ts
    setSelectedSceneId(null);
    setSceneBaseline(null);
    stashRef.current = null;
```

- [ ] **Step 4: Generalize Enhance/copy for the active buffer**

Rewrite `handleEnhancePrompt` to read/write the active buffer:

```ts
  async function handleEnhancePrompt() {
    if (!activePrompt.trim() || enhancing || (!editing && running)) return;
    setEnhancing(true);
    try {
      const result = await requestPromptEnhancement({
        prompt: activePrompt,
        kind: activeKind,
        style: stylesSupported ? activeSettings.style : null,
        stylesSupported,
        aspect: activeSettings.aspect,
        duration: activeKind === "video" ? activeSettings.duration : null,
        sceneIndex: editing ? editingIndex + 1 : Math.max(1, scenes.length),
        sceneCount: Math.max(1, scenes.length),
        negativePrompt: activeSettings.negativePrompt || null,
        uncensored: userSettings.uncensoredEnabled,
      });
      const enhanced = result.enhanced.slice(0, promptMax);
      if (editing) setScenePrompt(enhanced);
      else setPrompt(enhanced);
      toast.push(
        result.source === "ai"
          ? "Prompt enhanced with AI — review it and press Generate."
          : "Prompt enriched with style and lighting cues — AI enhancement is unavailable right now.",
        "success",
      );
    } catch (error) {
      if ((error as EnhancementError)?.name !== "AbortError") {
        toast.push(
          (error as EnhancementError).message ?? "Prompt enhancement failed.",
          "error",
        );
      }
    } finally {
      setEnhancing(false);
    }
  }
```

And `onCopyPrompt` becomes:

```ts
              onCopyPrompt={() => {
                void navigator.clipboard
                  ?.writeText(activePrompt)
                  .then(() => toast.push("Prompt copied.", "success"));
              }}
```

(`onPromptChange` also splits: `editing ? setScenePrompt(value) : setPrompt(value)` plus the existing promptError clear when not editing.)

- [ ] **Step 5: Header — swap the story kind toggle for the edit context**

Replace the top-right `<div className="flex items-center gap-2">…</div>` block:

```tsx
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <Badge tone="primary">
                  <Icon name="pen" size={12} /> Editing scene {editingIndex + 1}
                </Badge>
                <Segmented
                  ariaLabel="Scene media type"
                  size="sm"
                  collapseOnMobile
                  value={sceneKind}
                  onChange={(next) => {
                    setSceneKind(next);
                    // Mirror the story toggle: the other kind's saved pick.
                    setSceneSettings((s) => ({
                      ...s,
                      modelId:
                        (next === "video"
                          ? userSettings.videoModel
                          : userSettings.imageModel) ?? undefined,
                    }));
                  }}
                  options={[
                    { value: "image", label: "Image", icon: "image" },
                    { value: "video", label: "Video", icon: "video" },
                  ]}
                />
                <Button variant="ghost" size="sm" icon="close" onClick={exitSceneEdit}>
                  Exit
                </Button>
              </>
            ) : (
              <>
                {(storyId || scenes.length > 0) && (
                  <Button variant="ghost" size="sm" icon="refresh" onClick={reset}>
                    New story
                  </Button>
                )}
                <Segmented
                  ariaLabel="Story media type"
                  size="sm"
                  collapseOnMobile
                  value={kind}
                  onChange={(next) => {
                    setKind(next);
                    setSettings((s) => ({ ...s, kind: next }));
                  }}
                  options={[
                    { value: "image", label: "Image", icon: "image" },
                    { value: "video", label: "Video", icon: "video" },
                  ]}
                />
              </>
            )}
          </div>
```

- [ ] **Step 6: Rewire the PromptComposer props**

```tsx
            <PromptComposer
              kind={activeKind}
              title="Story composer"
              headerBadge={
                editing ? (
                  <Badge tone="primary">
                    <Icon name="pen" size={12} /> Scene {editingIndex + 1}
                  </Badge>
                ) : (
                  <Badge tone="primary">
                    <Icon name="story" size={12} /> {scenes.length || 1} scene
                    {(scenes.length || 1) === 1 ? "" : "s"}
                  </Badge>
                )
              }
              prompt={activePrompt}
              onPromptChange={(value) => {
                if (editing) {
                  setScenePrompt(value);
                } else {
                  setPrompt(value);
                  if (promptError) setPromptError(undefined);
                }
              }}
              promptError={editing ? undefined : promptError}
              settings={activeSettings}
              onSettingsChange={(patch) =>
                editing
                  ? setSceneSettings((s) => ({ ...s, ...patch }))
                  : setSettings((s) => ({ ...s, ...patch }))
              }
              models={composerCatalog.models}
              modelId={composerModelId}
              loraCatalog={composerCatalog.loras}
              loraMaxPerRequest={composerCatalog.loraMaxPerRequest}
              loraCapable={composerSelectedModel?.loraCapable === true}
              loraModel={composerSelectedModel?.model}
              allowNsfwLoras={userSettings.uncensoredEnabled}
              onModelChange={(nextModel) => {
                if (editing) {
                  updateSceneModel(nextModel);
                  return;
                }
                setSelectedModel(kind, nextModel);
                /* …existing story-level body unchanged… */
              }}
              characters={editing ? [] : characters}
              characterIds={editing ? [] : userSettings.storyCharacterIds}
              onCharactersChange={editing ? undefined : setStoryCharacters}
              frames={activeRefs}
              onFramesChange={(patch) =>
                editing
                  ? setSceneRefs((r) => ({ ...r, ...patch }))
                  : setDraftRefs((r) => ({ ...r, ...patch }))
              }
              onFramesError={(message) => toast.push(message, "error")}
              frameEndSupported={endSupported}
              frameNote={
                !Object.keys(activeRefs).length
                  ? undefined
                  : activeKind === "video" && activeRefs.startImageRef && continuityOn
                    ? "This scene starts from your image — the chain continues from here."
                    : activeKind === "image"
                      ? "Your image guides this scene's composition and style."
                      : "This scene starts on your first frame and ends on your last."
              }
              frameNoteIcon={
                activeKind === "video" && activeRefs.startImageRef && continuityOn
                  ? "link"
                  : "image"
              }
              busy={editing ? false : running}
              actionLabel={editing ? "Update scene" : undefined}
              actionDisabled={editing && selectedScene?.status === "generating"}
              hideRenderCount={editing}
              onGenerate={editing ? () => void handleUpdateScene() : handleGenerateAll}
              onCancel={handleCancel}
              onEnhancePrompt={() => void handleEnhancePrompt()}
              enhancing={enhancing}
              onCopyPrompt={/* see Step 4 */}
            />
```

Delete the now-unused local `framesAttached` computation (replaced by the `activeRefs`-based `frameNote` inline).

- [ ] **Step 7: Hide "Add scene" while editing**

In the action row below the composer, wrap the Add scene button:

```tsx
            {!editing && (
              <Button
                variant="secondary"
                size="sm"
                block
                icon="plus"
                disabled={running || scenes.length >= 6}
                onClick={() => void addScene()}
              >
                Add scene
              </Button>
            )}
```

(Continuity + chain pill stay as-is.)

- [ ] **Step 8: Typecheck + existing tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add app/story/page.tsx
git commit -m "feat(story): scene edit mode — select a scene, tweak its settings in the composer, update it"
```

---

### Task 6: Tiles — selection affordance, effective aspect/duration, inline-edit guard

**Files:**
- Modify: `app/story/page.tsx` (the scene grid map)

- [ ] **Step 1: Effective aspect/duration per tile**

Inside the grid map, right after `const typed = scenes[index] as StoryScene | undefined;`:

```ts
              // Per-scene overrides are visible in the grid: tiles show the
              // scene's effective aspect (and video duration).
              const effectiveAspect = typed?.settings?.aspect ?? settings.aspect;
              const effectiveDuration = typed?.settings?.duration ?? settings.duration;
              const ratioStyle = {
                aspectRatio: `${ASPECTS[effectiveAspect].width}/${ASPECTS[effectiveAspect].height}`,
              };
```

(Delete the old `ratioStyle` line; replace `settings.aspect` in the `VideoStage`/`MediaFrame` `ratio` props and `settings.duration` in `durationSeconds` with `effectiveAspect`/`effectiveDuration`.)

- [ ] **Step 2: Selection affordance on editable tiles**

After `const editable = …` add:

```ts
              const selectable =
                typed?.status === "queued" ||
                typed?.status === "canceled" ||
                typed?.status === "failed";
              const selected = editing && typed?.id === selectedSceneId;
```

On the queued, canceled and failed tile branches, change the outer `<div className="relative">` to a clickable container:

```tsx
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit scene ${index + 1} in the composer`}
                      title={selected ? "Editing in the composer — click to exit" : "Edit this scene in the composer"}
                      onClick={() => (selected ? exitSceneEdit() : enterSceneEdit(typed))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selected ? exitSceneEdit() : enterSceneEdit(typed);
                        }
                      }}
                      className={`relative cursor-pointer rounded-[14px] transition-shadow ${
                        selected
                          ? "ring-2 ring-primary"
                          : "hover:ring-1 hover:ring-border-strong"
                      }`}
                    >
```

(the inner content of each branch is unchanged). The generating / completed / placeholder branches keep their plain `<div className="relative">` wrappers.

- [ ] **Step 3: One editor per scene**

Guard the tile prompt's inline edit click:

```tsx
                        onClick={
                          editable && !selected
                            ? () => {
                                editCancelingRef.current = false; // a prior Escape must not swallow this commit
                                setEditDraft(typed.prompt);
                                setEditingSceneId(typed.id);
                              }
                            : undefined
                        }
```

and the `title`/cursor class condition likewise (`editable && !selected`).

- [ ] **Step 4: Typecheck + tests + commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.

```bash
git add app/story/page.tsx
git commit -m "feat(story): scene tiles select into the composer and honor per-scene aspect/duration"
```

---

### Task 7: GUI smoke + full verification

**Files:**
- Create: `scripts/verify-story-scene-edit.mjs`

- [ ] **Step 1: Write the smoke script**

Follow the `verify-frame-dock.mjs` harness (playwright chromium, `check()` helper, 1440×900, no renders fired). Flow:

1. Seed a queued story directly through the API so no render fires: `page.request.post(`${BASE}/api/assets`, { data: storyAsset })` with two queued scenes (`kind: "image"`), scene 2 carrying `settings: { aspect: "16:9" }`; then open `/story?id=<id>`.
2. **Select:** click the scene-2 tile (`[aria-label="Edit scene 2 in the composer"]`) → expect the header badge text `Editing scene 2`, the prompt textarea holds scene 2's prompt, "Update scene" button visible, "Add scene" hidden.
3. **Tweak:** open the aspect PillSelect (`button:has-text("Aspect ratio")`) → pick `1:1`; change the prompt text.
4. **Update:** click `button:has-text("Update scene")` → expect badge gone (header shows the story kind Segmented again) and the scene-2 tile shows a square ratio (`aspect-ratio: 1/1` in its skeleton style).
5. **Server truth:** `page.request.get(`${BASE}/api/stories/${id}`)` → `story.scenes[1].settings.aspect === "1:1"`, prompt updated, and `scenes[0].settings` undefined.
6. **Draft restore:** type a draft prompt in the composer BEFORE selecting a scene, select scene 1, press Escape (or Exit), expect the draft prompt back in the textarea.
7. Write `PASS/FAIL` lines; exit code 1 on any failure; screenshots into `gui-test-screenshots/story-scene-edit/`.

- [ ] **Step 2: Run it against a dev server**

Run: `npm run dev` (worktree server, expect :3100) then `node scripts/verify-story-scene-edit.mjs http://127.0.0.1:3100`
Expected: all PASS.

- [ ] **Step 3: Full suite**

Run: `npx tsc --noEmit && npm test && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-story-scene-edit.mjs
git commit -m "test(story): GUI smoke for scene edit mode"
```

---

## Self-review

- **Spec coverage:** interaction (Task 5 Steps 3/5/6/7, Task 6 Step 2), data model (Task 1), runner merge + chain precedence (Task 2), update op + guards + clamp + ref clearing (Task 3), composer props (Task 4), edge cases — vanished scene (Task 5 Step 3 effect), Escape/exit + stash restore (Step 3), one-editor rule (Task 6 Step 3), tiles effective aspect/duration (Task 6 Step 1), failed save+requeue (Task 5 `handleUpdateScene`), testing (Tasks 2/3 unit + Task 7 GUI). Out-of-scope items (per-scene cast, chain-model pill) untouched — matches spec.
- **Placeholder scan:** none — every code step carries full code; Task 7 Step 1 specifies exact flow and selectors rather than "write a script".
- **Type consistency:** `SceneUpdatePatch`/`SceneSettingsOverride` names consistent across Tasks 1–3 and 5; `mergedSceneSettings(story, scene)` signature matches both call sites; `diffSettingsBaseline(baseline, buffer)` order matches `handleUpdateScene`; `actionLabel`/`actionDisabled`/`hideRenderCount` match Task 4's props.

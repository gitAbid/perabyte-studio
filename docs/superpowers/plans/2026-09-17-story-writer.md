# Story Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/writer` page where the user composes a story with AI text models (write / enhance / split into scenes) and hands the result to the existing story or solo generation pipeline.

**Architecture:** Three operations (`write`, `enhance`, `split`) served by `lib/services/writer.service.ts` over the existing `TextProvider` engine chain (shared resolver extracted from the Enhance service), exposed at `POST /api/writer`. Split returns per-scene visual prompts; the client creates a story record via the existing `POST /api/assets` and navigates to `/story?id=`. Spec: `docs/superpowers/specs/2026-09-17-story-writer-design.md`.

**Tech Stack:** Next.js (App Router, nodejs routes), TypeScript, Tailwind, vitest.

---

## Worktree requirement

**Execute this plan inside a git worktree, never the main working tree** (other sessions run in parallel against this repo):

```bash
git worktree add .worktrees/story-writer -b feat/story-writer
cd .worktrees/story-writer
cp .env.local ../.env.local 2>/dev/null || cp ../../.env.local .env.local   # real env needed at runtime
npm install
```

Each task below commits to `feat/story-writer`.

## Deviation from spec (recorded)

The spec's "Use in Solo" section prescribed a `sessionStorage` handoff. `components/GeneratorScreen.tsx:100-119` already implements `?prompt=` (plus `?style=`, `?aspect=`, `?resolution=`) prefill used by Regenerate links. The plan reuses that seam: Use in Solo navigates to `/generate/image?prompt=<encoded>` — no new handoff mechanism. Task 12 amends the spec line to match.

## File structure

```
lib/repositories/provider-config.repository.ts   MODIFY  tasks.writer key
lib/repositories/provider-config.repository.test.ts  MODIFY  writer key test
lib/services/provider-settings.service.ts        MODIFY  expose + validate writer pick
lib/services/provider-settings.service.test.ts   MODIFY  writer pick tests (may not exist — see Task 2)
components/settings/GeneralSection.tsx           MODIFY  "Story writer" select row
app/settings/page.tsx                            MODIFY  pass writerModel prop
lib/services/text-engine-chain.ts                CREATE shared engine resolver
lib/services/enhancement.service.ts              MODIFY  delegate to shared resolver
lib/constants.ts                                 MODIFY  WRITER_TONES
components/Icon.tsx                              MODIFY  "pen" icon
lib/domain/writer.ts                             CREATE  types, validators, instructions, scene extractor
lib/domain/writer.test.ts                        CREATE  domain tests
lib/services/writer.service.ts                   CREATE  write/enhance/split orchestration
lib/services/writer.service.test.ts              CREATE  service tests
app/api/writer/route.ts                          CREATE  thin controller
lib/writer.ts                                    CREATE  browser fetch client
app/writer/page.tsx                              CREATE  route page
components/writer/WriterView.tsx                 CREATE  the surface
components/SiteChrome.tsx                        MODIFY  nav entries
docs/superpowers/specs/2026-09-17-story-writer-design.md  MODIFY  Solo handoff amendment
```

Run checks with `npm run typecheck` and `npx vitest run <file>` from the worktree root.

---

### Task 1: `tasks.writer` in provider config

**Files:**
- Modify: `lib/repositories/provider-config.repository.ts`
- Test: `lib/repositories/provider-config.repository.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("provider-config.repository", …)` block (the file already imports `updateProviderConfig`, `setProviderConfigPathForTests`, `expect`, `it`):

```ts
  it("persists and preserves a writer task model pick", () => {
    updateProviderConfig({ tasks: { writer: "sogni:qwen3.6-35b-a3b-gguf-iq4xs" } });
    let config = getProviderConfig();
    expect(config.tasks.writer).toBe("sogni:qwen3.6-35b-a3b-gguf-iq4xs");
    expect(config.tasks.enhance).toBeNull();

    // An unrelated patch must not clobber the writer pick.
    updateProviderConfig({ renderTimeouts: { image: 420 } });
    config = getProviderConfig();
    expect(config.tasks.writer).toBe("sogni:qwen3.6-35b-a3b-gguf-iq4xs");
  });
```

Add `getProviderConfig` to the import from the repository if not already imported.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/repositories/provider-config.repository.test.ts`
Expected: FAIL — `tasks.writer` is `undefined` on the default config.

- [ ] **Step 3: Implement the key**

In `lib/repositories/provider-config.repository.ts` make three changes:

1. Find `interface TaskModelConfig` (it currently holds only `enhance: string | null`) and add the writer field:

```ts
export interface TaskModelConfig {
  enhance: string | null;
  /** Story Writer default text model (`<provider>:<model>`), null = chain order. */
  writer: string | null;
}
```

2. In `getDefaultProviderConfig()`, change the tasks default:

```ts
    tasks: {
      enhance: null,
      writer: null,
    },
```

3. In the disk-parse function, directly below the existing `tasksObj.enhance` block, add the same treatment for writer:

```ts
  if (typeof tasksObj.writer === "string" && tasksObj.writer.trim().length > 0) {
    defaults.tasks.writer = tasksObj.writer.trim();
  } else {
    defaults.tasks.writer = null;
  }
```

4. In `updateProviderConfig`'s clone step `tasks: { ...current.tasks }` already copies the new field; find the section that applies `patch.tasks` to `next.tasks` (it assigns `next.tasks.enhance`) and add beside it:

```ts
      if (patch.tasks?.writer !== undefined) {
        next.tasks.writer = patch.tasks.writer;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/repositories/provider-config.repository.test.ts`
Expected: PASS (all tests in the file, including the new one).

- [ ] **Step 5: Commit**

```bash
git add lib/repositories/provider-config.repository.ts lib/repositories/provider-config.repository.test.ts
git commit -m "feat(writer): tasks.writer model pick in provider config"
```

---

### Task 2: expose `tasks.writer` through the settings service

**Files:**
- Modify: `lib/services/provider-settings.service.ts`
- Test: `lib/services/provider-settings.service.test.ts` (create if missing, extending the pattern below)

- [ ] **Step 1: Write the failing test**

Check whether `lib/services/provider-settings.service.test.ts` exists. If yes, add this test following its existing setup helpers. If no, create it with this content:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
} from "@/lib/repositories/provider-config.repository";
import {
  getProviderSettings,
  updateProviderSettings,
} from "@/lib/services/provider-settings.service";

let tempConfigFile: string | null = null;

beforeEach(() => {
  tempConfigFile = path.join(
    os.tmpdir(),
    `provider-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  setProviderConfigPathForTests(tempConfigFile);
});

afterEach(() => {
  resetProviderConfigForTests();
  if (tempConfigFile) {
    fs.rmSync(tempConfigFile, { force: true });
    tempConfigFile = null;
  }
  resetStudioEnvForTests();
});

describe("provider settings writer task pick", () => {
  it("reports tasks.writer in the payload", () => {
    const payload = getProviderSettings();
    expect(payload.tasks.writer).toBeNull();
  });

  it("accepts a known text model and rejects unknown ones", () => {
    updateProviderSettings({ tasks: { writer: "sogni:qwen3.5-35b-a3b-abliterated-gguf-q4km" } });
    expect(getProviderSettings().tasks.writer).toBe(
      "sogni:qwen3.5-35b-a3b-abliterated-gguf-q4km",
    );

    expect(() =>
      updateProviderSettings({ tasks: { writer: "sogni:not-a-model" } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/services/provider-settings.service.test.ts`
Expected: FAIL — TS error `writer does not exist in type '{ enhance?: string | null }'` / payload lacks the field.

- [ ] **Step 3: Implement**

In `lib/services/provider-settings.service.ts`, three changes:

1. `ProviderSettingsPayload.tasks` (line ~50):

```ts
  tasks: { enhance: string | null; writer: string | null };
```

2. `ProviderSettingsUpdate.tasks` (line ~60):

```ts
  tasks?: { enhance?: string | null; writer?: string | null };
```

3. Payload assembly (line ~141):

```ts
    tasks: { enhance: config.tasks.enhance, writer: config.tasks.writer },
```

4. In the update-validation block for `raw.tasks` (below the `raw.tasks.enhance` branch ending at `patch.tasks = { enhance };`), add:

```ts
    if (raw.tasks.writer !== undefined) {
      const writer = raw.tasks.writer;
      if (writer !== null && typeof writer !== "string") {
        throw new ProviderSettingsError("Invalid writer model.", { field: "tasks" });
      }
      if (typeof writer === "string" && !allTextModelIds().has(writer)) {
        throw new ProviderSettingsError(`Unknown writer model "${writer}".`, {
          field: "tasks",
        });
      }
      patch.tasks = { ...(patch.tasks ?? {}), writer };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/services/provider-settings.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/provider-settings.service.ts lib/services/provider-settings.service.test.ts
git commit -m "feat(writer): expose tasks.writer through provider settings service"
```

---

### Task 3: Settings UI — "Story writer" row

**Files:**
- Modify: `components/settings/GeneralSection.tsx`
- Modify: `app/settings/page.tsx`

- [ ] **Step 1: Add the writer prop and row to `TaskModelsCard`**

In `components/settings/GeneralSection.tsx`:

1. Extend the `TaskModelsCard` signature (line ~133) — add `writerModel` to both the destructure and the props type:

```tsx
function TaskModelsCard({
  providers,
  enhanceModel,
  writerModel,
  onUpdate,
}: {
  providers: ProviderView[];
  enhanceModel: string | null;
  writerModel: string | null;
  onUpdate: OnUpdate;
}) {
```

2. Directly below the existing "Prompt enhancement" `SelectField` block (ends line ~204), add:

```tsx
          <SelectField
            label="Story writer"
            value={writerModel ?? ""}
            onChange={(event) =>
              onUpdate({ tasks: { writer: event.target.value || null } }).catch(
                () => undefined,
              )
            }
          >
            <option value="">Auto (recommended)</option>
            {enhanceOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </SelectField>
```

(Reuses `enhanceOptions` — both tasks draw from the same enabled text models.)

3. Thread the prop through the internal caller of `TaskModelsCard` (the `GeneralSection` component, line ~24-40): add `writerModel,` to the props destructure/type there and pass `writerModel={writerModel}` into `<TaskModelsCard …>`.

- [ ] **Step 2: Pass the value from the settings page**

In `app/settings/page.tsx` at line ~114, beside `enhanceModel={data?.tasks.enhance ?? null}` add:

```tsx
              writerModel={data?.tasks.writer ?? null}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/settings/GeneralSection.tsx app/settings/page.tsx
git commit -m "feat(writer): Story writer default-model row in Settings"
```

---

### Task 4: Shared text engine chain (behavior-preserving extraction)

**Files:**
- Create: `lib/services/text-engine-chain.ts`
- Modify: `lib/services/enhancement.service.ts`

- [ ] **Step 1: Create the shared resolver**

`lib/services/text-engine-chain.ts`:

```ts
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { sogniTextComplete, SOGNI_TEXT_MODELS } from "@/lib/providers/sogni/sogni.text";
import {
  pollinationsTextComplete,
  POLLINATIONS_TEXT_MODELS,
} from "@/lib/providers/pollinations/pollinations.text";

/**
 * The text-engine chain shared by every AI-writing task (prompt enhancement,
 * story writer): the configured task model first — when its owning provider is
 * enabled and the model isn't disabled — then Sogni, then Pollinations.
 * Extracted verbatim from enhancement.service so both callers share one order.
 */
export interface TextEngineEntry {
  providerId: "sogni" | "pollinations";
  modelId?: string;
  complete: (
    instruction: string,
    options?: { signal?: AbortSignal; modelId?: string },
  ) => Promise<string>;
}

export function resolveTextEngines(taskModel: string | null): TextEngineEntry[] {
  const config = getProviderConfig();
  const selectedModel = taskModel;

  const sogniEnabled =
    config.providers.sogni?.enabled !== false &&
    !config.providers.sogni?.disabledModels?.includes(selectedModel ?? "");
  const pollinationsEnabled =
    config.providers.pollinations?.enabled !== false &&
    !config.providers.pollinations?.disabledModels?.includes(selectedModel ?? "");

  const sogniModels = SOGNI_TEXT_MODELS.map((m) => m.id);
  const pollinationsModels = POLLINATIONS_TEXT_MODELS.map((m) => m.id);

  const engines: TextEngineEntry[] = [];

  if (selectedModel) {
    if (sogniModels.includes(selectedModel) && sogniEnabled) {
      engines.push({
        providerId: "sogni",
        modelId: selectedModel,
        complete: sogniTextComplete,
      });
    } else if (pollinationsModels.includes(selectedModel) && pollinationsEnabled) {
      engines.push({
        providerId: "pollinations",
        modelId: selectedModel,
        complete: pollinationsTextComplete,
      });
    }
  }

  if (config.providers.sogni?.enabled !== false && !engines.some((e) => e.providerId === "sogni")) {
    engines.push({
      providerId: "sogni",
      complete: sogniTextComplete,
    });
  }
  if (
    config.providers.pollinations?.enabled !== false &&
    !engines.some((e) => e.providerId === "pollinations")
  ) {
    engines.push({
      providerId: "pollinations",
      complete: pollinationsTextComplete,
    });
  }

  return engines;
}
```

- [ ] **Step 2: Delegate from the enhancement service**

In `lib/services/enhancement.service.ts`:

1. Delete the `EngineEntry` interface and the whole `resolveEnhanceEngines()` function (lines ~121-174) plus the now-unused imports `sogniTextComplete`, `SOGNI_TEXT_MODELS`, `pollinationsTextComplete`, `POLLINATIONS_TEXT_MODELS` (keep `getProviderConfig` — the cache key still uses it).
2. Add:

```ts
import { resolveTextEngines } from "@/lib/services/text-engine-chain";
```

3. In `runPromptEnhancement`, replace `const engines = resolveEnhanceEngines();` with:

```ts
    const engines = resolveTextEngines(config.tasks.enhance);
```

- [ ] **Step 3: Verify the refactor is behavior-preserving**

Run: `npx vitest run lib/services/enhancement.service.test.ts && npm run typecheck`
Expected: all enhancement tests PASS (they assert chain order and fallback), no type errors.

- [ ] **Step 4: Commit**

```bash
git add lib/services/text-engine-chain.ts lib/services/enhancement.service.ts
git commit -m "refactor(text): extract shared text-engine chain from enhancement service"
```

---

### Task 5: Writer constants + icon

**Files:**
- Modify: `lib/constants.ts`
- Modify: `components/Icon.tsx`

- [ ] **Step 1: Add the tone table to `lib/constants.ts`**

Below `DURATIONS` (line ~51):

```ts
/** Story Writer tone presets — folded into the writing instruction, not render styles. */
export const WRITER_TONES = {
  none: "No particular tone",
  dark: "Dark",
  whimsical: "Whimsical",
  romantic: "Romantic",
  thriller: "Thriller",
  documentary: "Documentary",
} as const;
export type WriterToneKey = keyof typeof WRITER_TONES;
```

- [ ] **Step 2: Add the "pen" icon to `components/Icon.tsx`**

Add `"pen"` to the `IconName` union (after `"chip"`) and to `PATHS`:

```ts
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/constants.ts components/Icon.tsx
git commit -m "feat(writer): tone presets and pen icon"
```

---

### Task 6: Domain — types, validators, instructions, scene extractor

**Files:**
- Create: `lib/domain/writer.ts`
- Test: `lib/domain/writer.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/domain/writer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  WRITER_DRAFT_MAX,
  WRITER_IDEA_MAX,
  clampScenePrompt,
  enhanceDraftInstruction,
  extractStoryScenes,
  parseEnhanceBody,
  parseSplitBody,
  parseWriteBody,
  splitScenesInstruction,
  writeStoryInstruction,
} from "@/lib/domain/writer";

describe("writer request validation", () => {
  it("rejects an empty or oversized idea", () => {
    expect(() => parseWriteBody({ action: "write", brief: { idea: "   " } })).toThrow(
      /idea/i,
    );
    expect(() =>
      parseWriteBody({ action: "write", brief: { idea: "x".repeat(WRITER_IDEA_MAX + 1) } }),
    ).toThrow(/idea/i);
  });

  it("defaults scene count and clamps out-of-range values", () => {
    expect(parseWriteBody({ action: "write", brief: { idea: "a chase" } }).sceneCount).toBe(5);
    expect(parseWriteBody({ action: "write", brief: { idea: "a", sceneCount: 0 } }).sceneCount).toBe(1);
    expect(parseWriteBody({ action: "write", brief: { idea: "a", sceneCount: 99 } }).sceneCount).toBe(12);
  });

  it("ignores unknown tone names and normalizes character names", () => {
    const parsed = parseWriteBody({
      action: "write",
      brief: { idea: "a", tone: "nope", characterNames: [" Ada ", "", "Riven"] },
    });
    expect(parsed.tone).toBeNull();
    expect(parsed.characterNames).toEqual(["Ada", "Riven"]);
  });

  it("validates enhance and split bodies", () => {
    expect(() => parseEnhanceBody({ action: "enhance", draft: "", instruction: "x" })).toThrow();
    expect(() => parseEnhanceBody({ action: "enhance", draft: "ok", instruction: "" })).toThrow();
    expect(() =>
      parseSplitBody({ action: "split", draft: "y".repeat(WRITER_DRAFT_MAX + 1), sceneCount: 3 }),
    ).toThrow();
    expect(parseSplitBody({ action: "split", draft: "prose", sceneCount: 4 })).toMatchObject({
      sceneCount: 4,
    });
    expect(parseSplitBody({ action: "split", draft: "prose" }).sceneCount).toBe(5);
  });
});

describe("instruction builders", () => {
  it("embeds the brief fields", () => {
    const text = writeStoryInstruction({
      idea: "a neon chase",
      sceneCount: 5,
      tone: "dark",
      characterNames: ["Ada"],
      uncensored: true,
    });
    expect(text).toContain("a neon chase");
    expect(text).toContain("5");
    expect(text).toContain("dark");
    expect(text).toContain("Ada");
  });

  it("enhance instruction carries draft and instruction", () => {
    const text = enhanceDraftInstruction("old draft", "make it darker");
    expect(text).toContain("old draft");
    expect(text).toContain("make it darker");
  });

  it("split instruction demands JSON output with the requested count", () => {
    const text = splitScenesInstruction("prose", 4, []);
    expect(text).toContain("4");
    expect(text).toContain('"scenes"');
    expect(text).toContain("JSON");
  });
});

describe("extractStoryScenes", () => {
  it("parses a clean JSON object", () => {
    const parsed = extractStoryScenes(
      JSON.stringify({ title: "The Chase", scenes: ["scene one", "scene two"] }),
      2,
    );
    expect(parsed).toEqual({ title: "The Chase", scenes: ["scene one", "scene two"] });
  });

  it("survives code fences and surrounding chatter", () => {
    const raw = 'Here you go!\n```json\n{"title":"T","scenes":["a","b"]}\n```\nHope that helps.';
    expect(extractStoryScenes(raw, 2)).toEqual({ title: "T", scenes: ["a", "b"] });
  });

  it("filters empty scenes and clamps to the requested count", () => {
    const raw = JSON.stringify({ title: "T", scenes: ["a", "", "  ", "b", "c", "d"] });
    expect(extractStoryScenes(raw, 3)).toEqual({ title: "T", scenes: ["a", "b", "c"] });
  });

  it("returns null on unusable replies", () => {
    expect(extractStoryScenes("no json at all", 3)).toBeNull();
    expect(extractStoryScenes('{"scenes": "not an array"}', 3)).toBeNull();
    expect(extractStoryScenes('{"title":"T","scenes":[]}', 3)).toBeNull();
  });

  it("trims over-length scenes at a sentence boundary", () => {
    const long = `${"A".repeat(900)}. ${"B".repeat(900)}.`;
    const parsed = extractStoryScenes(JSON.stringify({ scenes: [long] }), 1);
    expect(parsed!.scenes[0].length).toBeLessThanOrEqual(1000);
    expect(parsed!.scenes[0].endsWith(".")).toBe(true);
  });
});

describe("clampScenePrompt", () => {
  it("keeps short prompts untouched", () => {
    expect(clampScenePrompt("short")).toBe("short");
  });
  it("falls back to a hard cut without sentence punctuation", () => {
    expect(clampScenePrompt("x".repeat(1400)).length).toBe(1000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/domain/writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/domain/writer.ts`**

```ts
import { PROMPT_MAX, WRITER_TONES, type WriterToneKey } from "@/lib/constants";

/**
 * Story Writer domain (pure): request validation, instruction builders and the
 * scene-split extractor. No I/O — the service layers engines and retries on top.
 */

export const WRITER_IDEA_MAX = 2000;
export const WRITER_DRAFT_MAX = 20_000;
export const WRITER_INSTRUCTION_MAX = 500;
export const WRITER_MIN_SCENES = 1;
export const WRITER_MAX_SCENES = 12;
export const WRITER_DEFAULT_SCENES = 5;

export interface WriterBrief {
  idea: string;
  sceneCount: number;
  tone: WriterToneKey | null;
  characterNames: string[];
  uncensored: boolean;
}

export class WriterValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "WriterValidationError";
    this.field = field;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export function parseWriteBody(body: Record<string, unknown>): WriterBrief {
  const brief = (body.brief ?? {}) as Record<string, unknown>;
  const idea = text(brief.idea, WRITER_IDEA_MAX);
  if (!idea) {
    throw new WriterValidationError("Describe your story idea first.", "idea");
  }
  const tone =
    typeof brief.tone === "string" && brief.tone in WRITER_TONES
      ? (brief.tone as WriterToneKey)
      : null;
  return {
    idea,
    sceneCount: clampInt(brief.sceneCount, WRITER_MIN_SCENES, WRITER_MAX_SCENES, WRITER_DEFAULT_SCENES),
    tone,
    characterNames: cleanNames(brief.characterNames),
    uncensored: brief.uncensored === true,
  };
}

export interface EnhanceRequest {
  draft: string;
  instruction: string;
}

export function parseEnhanceBody(body: Record<string, unknown>): EnhanceRequest {
  const draft = text(body.draft, WRITER_DRAFT_MAX);
  if (!draft) {
    throw new WriterValidationError("Write or generate a draft first.", "draft");
  }
  const instruction = text(body.instruction, WRITER_INSTRUCTION_MAX);
  if (!instruction) {
    throw new WriterValidationError("Tell the writer what to change.", "instruction");
  }
  return { draft, instruction };
}

export interface SplitRequest {
  draft: string;
  sceneCount: number;
  characterNames: string[];
}

export function parseSplitBody(body: Record<string, unknown>): SplitRequest {
  const draft = text(body.draft, WRITER_DRAFT_MAX);
  if (!draft) {
    throw new WriterValidationError("Write or generate a draft first.", "draft");
  }
  return {
    draft,
    sceneCount: clampInt(
      body.sceneCount,
      WRITER_MIN_SCENES,
      WRITER_MAX_SCENES,
      WRITER_DEFAULT_SCENES,
    ),
    characterNames: cleanNames(body.characterNames),
  };
}

/* ------------------------------ instructions ------------------------------ */

export function writeStoryInstruction(brief: WriterBrief): string {
  const parts = [
    `Write a short narrative story based on this idea: ${brief.idea}.`,
    `Structure it in roughly ${brief.sceneCount} distinct beats/paragraphs.`,
  ];
  if (brief.tone) parts.push(`Tone: ${brief.tone}.`);
  if (brief.characterNames.length) {
    parts.push(`Recurring characters (use these names): ${brief.characterNames.join(", ")}.`);
  }
  if (brief.uncensored) {
    parts.push("Do not sanitize or moralize; write the scene as imagined.");
  }
  parts.push("Reply with the story prose only — no titles, no commentary.");
  return parts.join(" ");
}

export function enhanceDraftInstruction(draft: string, instruction: string): string {
  return [
    `Rewrite the story below following this instruction: ${instruction}`,
    "Keep the same voice and characters unless told otherwise. Reply with the rewritten story only.",
    "---",
    draft,
  ].join("\n");
}

const SCENE_PROMPT_RULES = [
  "Each scene string must be a self-contained visual generation prompt: describe the shot, the characters (by name and look), the setting, mood and camera.",
  "No scene references earlier scenes ('as before', 'the same room') — each must stand alone.",
];

export function splitScenesInstruction(
  draft: string,
  sceneCount: number,
  characterNames: string[],
): string {
  const cast = characterNames.length
    ? ` Recurring characters: ${characterNames.join(", ")}.`
    : "";
  return [
    `Split the story below into exactly ${sceneCount} scenes.`,
    ...SCENE_PROMPT_RULES,
    `Reply ONLY with JSON: {"title": "short story title", "scenes": ["scene 1 prompt", …]} with ${sceneCount} scene strings.${cast}`,
    "---",
    draft,
  ].join("\n");
}

export const STRICT_SPLIT_SUFFIX =
  "Your previous reply was not usable. Reply ONLY with the JSON object — no fences, no prose before or after.";

/* ---------------------------- scene extraction ---------------------------- */

/** Cut an over-length scene prompt at the last sentence end that fits. */
export function clampScenePrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PROMPT_MAX) return trimmed;
  const slice = trimmed.slice(0, PROMPT_MAX);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("…"));
  if (lastStop > PROMPT_MAX * 0.5) return slice.slice(0, lastStop + 1);
  return slice;
}

/**
 * Extract `{title, scenes}` from a model reply. Tolerates code fences,
 * surrounding chatter, empty scene strings and over-count replies; each scene
 * is clamped to PROMPT_MAX. Returns null when nothing usable survives.
 */
export function extractStoryScenes(
  raw: string,
  expectedCount?: number,
): { title: string; scenes: string[] } | null {
  if (!raw) return null;
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let data: unknown;
  try {
    data = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.scenes)) return null;

  const scenes = record.scenes
    .filter((s): s is string => typeof s === "string")
    .map((s) => clampScenePrompt(s))
    .filter(Boolean);
  if (!scenes.length) return null;

  const limited =
    expectedCount && expectedCount > 0 ? scenes.slice(0, expectedCount) : scenes;
  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim().slice(0, 80)
      : "Untitled story";
  return { title, scenes: limited };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/domain/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/writer.ts lib/domain/writer.test.ts
git commit -m "feat(writer): domain validation, instructions and scene extractor"
```

---

### Task 7: Service — write/enhance/split orchestration

**Files:**
- Create: `lib/services/writer.service.ts`
- Test: `lib/services/writer.service.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/services/writer.service.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import {
  runWriterAction,
  WriterServiceError,
} from "@/lib/services/writer.service";

let tempConfigFile: string | null = null;

beforeEach(() => {
  tempConfigFile = path.join(
    os.tmpdir(),
    `writer-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  setProviderConfigPathForTests(tempConfigFile);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProviderConfigForTests();
  if (tempConfigFile) {
    fs.rmSync(tempConfigFile, { force: true });
    tempConfigFile = null;
  }
  resetStudioEnvForTests();
});

/** Fetch stub whose reply text is the first item, one per call. */
function stubReplies(replies: string[]) {
  let call = 0;
  const fetchMock = vi.fn(() => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
        status: 200,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SPLIT_JSON = JSON.stringify({ title: "The Chase", scenes: ["s1", "s2", "s3"] });

describe("writer service", () => {
  it("writes a story through the engine chain", async () => {
    stubReplies(["Once upon a rainy night…"]);
    const result = await runWriterAction({
      action: "write",
      brief: { idea: "a neon chase", sceneCount: 3 },
    });
    expect(result).toMatchObject({
      text: "Once upon a rainy night…",
      provider: "sogni",
    });
  });

  it("falls through to the next engine when the first fails", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve(new Response("nope", { status: 503 }));
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
            status: 200,
          }),
        );
      }),
    );
    const result = await runWriterAction({
      action: "enhance",
      draft: "draft text",
      instruction: "make it darker",
    });
    expect(result.text).toBe("recovered");
  });

  it("retries split once with a stricter instruction before failing", async () => {
    const fetchMock = stubReplies(["not json at all", SPLIT_JSON]);
    const result = await runWriterAction({
      action: "split",
      draft: "prose to split",
      sceneCount: 3,
    });
    expect(result.title).toBe("The Chase");
    expect(result.scenes).toEqual(["s1", "s2", "s3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a retryable error when every engine fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("down", { status: 503 }))),
    );
    await expect(
      runWriterAction({ action: "write", brief: { idea: "x" } }),
    ).rejects.toBeInstanceOf(WriterServiceError);
  });

  it("validates the body before spending the engine", async () => {
    await expect(runWriterAction({ action: "write", brief: { idea: "" } })).rejects.toThrow(
      /idea/i,
    );
    await expect(
      runWriterAction({ action: "bogus" } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/action/i);
  });

  it("honours the tasks.writer pick (engine receives the model)", async () => {
    updateProviderConfig({ tasks: { writer: "pollinations:default" } });
    const fetchMock = stubReplies(["pol story"]);
    const result = await runWriterAction({ action: "write", brief: { idea: "x" } });
    expect(result.provider).toBe("pollinations");
    expect(result.model).toBe("default");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("pollinations");
  });
});
```

Notes for the engineer: the Sogni chat reply shape `{choices:[{message:{content}}]}` matches `lib/providers/sogni/sogni.chat.ts`; if Pollinations uses a different wire shape, adjust the stub for that provider's call accordingly (check `pollinations.text.ts` first).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/services/writer.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/services/writer.service.ts`**

```ts
import { enhanceDraftInstruction, extractStoryScenes, parseEnhanceBody, parseSplitBody, parseWriteBody, splitScenesInstruction, STRICT_SPLIT_SUFFIX, writeStoryInstruction } from "@/lib/domain/writer";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import { resolveTextEngines } from "@/lib/services/text-engine-chain";

/**
 * Story Writer orchestration (Facade): write, enhance and split over the
 * shared text-engine chain. Unlike prompt enhancement there is NO
 * deterministic fallback — a template cannot write a story — so a total
 * engine failure surfaces as a retryable error, and there is no reply cache
 * (regenerate must re-roll, never replay).
 */

export interface WriterTextResult {
  text: string;
  model: string;
  provider: string;
}

export interface WriterSplitResult {
  title: string;
  scenes: string[];
  model: string;
  provider: string;
}

export class WriterServiceError extends Error {
  readonly field?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    options?: { field?: string; retryable?: boolean; status?: number },
  ) {
    super(message);
    this.name = "WriterServiceError";
    this.field = options?.field;
    this.retryable = options?.retryable ?? true;
    this.status = options?.status ?? 400;
  }
}

function engineLabel(entry: {
  providerId: string;
  modelId?: string;
}): { model: string; provider: string } {
  const modelId = entry.modelId ?? `${entry.providerId}:default`;
  const at = modelId.indexOf(":");
  return {
    provider: at > 0 ? modelId.slice(0, at) : entry.providerId,
    model: at > 0 ? modelId.slice(at + 1) : modelId,
  };
}

async function completeViaChain(
  instruction: string,
  options: { signal?: AbortSignal; logger: Logger },
): Promise<{ text: string; engine: { providerId: string; modelId?: string } }> {
  const taskModel = getProviderConfig().tasks.writer;
  const engines = resolveTextEngines(taskModel);
  if (!engines.length) {
    throw new WriterServiceError(
      "No text model is available. Enable a provider in Settings and retry.",
      { retryable: false },
    );
  }
  let lastError: unknown;
  for (const engine of engines) {
    try {
      const reply = await engine.complete(instruction, {
        signal: options.signal,
        modelId: engine.modelId,
      });
      if (!reply.trim()) throw new Error("Empty reply");
      return { text: reply, engine };
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      lastError = error;
      options.logger.warn("writer engine failed — trying the next one", {
        engine: engine.providerId,
        model: engine.modelId,
        message: (error as Error)?.message,
      });
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new WriterServiceError("The writer models are unavailable right now — try again.");
}

export async function runWriterAction(
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<WriterTextResult | WriterSplitResult> {
  const log = (options.logger ?? rootLogger).child({ surface: "writer" });
  const action = body.action;

  if (action === "write") {
    const brief = parseWriteBody(body);
    const started = Date.now();
    const { text, engine } = await completeViaChain(writeStoryInstruction(brief), {
      signal: options.signal,
      logger: log,
    });
    log.info("story written", { ...engineLabel(engine), elapsedMs: Date.now() - started });
    return { text, ...engineLabel(engine) };
  }

  if (action === "enhance") {
    const request = parseEnhanceBody(body);
    const started = Date.now();
    const { text, engine } = await completeViaChain(
      enhanceDraftInstruction(request.draft, request.instruction),
      { signal: options.signal, logger: log },
    );
    log.info("story enhanced", { ...engineLabel(engine), elapsedMs: Date.now() - started });
    return { text, ...engineLabel(engine) };
  }

  if (action === "split") {
    const request = parseSplitBody(body);
    const started = Date.now();
    const base = splitScenesInstruction(
      request.draft,
      request.sceneCount,
      request.characterNames,
    );
    // One stricter retry when the reply isn't parseable (spec: parse failure).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const instruction =
        attempt === 0 ? base : `${base}\n${STRICT_SPLIT_SUFFIX}`;
      const { text, engine } = await completeViaChain(instruction, {
        signal: options.signal,
        logger: log,
      });
      const parsed = extractStoryScenes(text, request.sceneCount);
      if (parsed) {
        log.info("story split", {
          ...engineLabel(engine),
          scenes: parsed.scenes.length,
          attempts: attempt + 1,
          elapsedMs: Date.now() - started,
        });
        return { ...parsed, ...engineLabel(engine) };
      }
      log.warn("split reply unparseable", { attempt: attempt + 1 });
    }
    throw new WriterServiceError(
      "The writer could not split that draft into scenes — try rephrasing or retry.",
      { retryable: true },
    );
  }

  throw new WriterServiceError("Unknown writer action.", { field: "action", retryable: false });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/services/writer.service.test.ts`
Expected: PASS. If the Pollinations engine test fails on wire shape, adjust only the test stub.

- [ ] **Step 5: Commit**

```bash
git add lib/services/writer.service.ts lib/services/writer.service.test.ts
git commit -m "feat(writer): write/enhance/split service over shared engine chain"
```

---

### Task 8: API route

**Files:**
- Create: `app/api/writer/route.ts`

- [ ] **Step 1: Create the route (mirrors `/api/enhance`)**

```ts
import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { runWriterAction, WriterServiceError } from "@/lib/services/writer.service";
import { WriterValidationError } from "@/lib/domain/writer";

export const runtime = "nodejs";

const log = logger.child({ route: "api/writer" });

/**
 * Thin controller for the story writer: parse → service → response.
 * Validation failures are 400s with a field hint; engine failures are
 * retryable 502s. Creative writing has no deterministic fallback.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }

  try {
    const response = await runWriterAction(body, {
      signal: request.signal,
      logger: log,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || request.signal.aborted) {
      log.info("writer action cancelled by client");
      return new NextResponse(null, { status: 499 });
    }
    if (error instanceof WriterValidationError) {
      log.warn("writer request rejected", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field, retryable: false },
        { status: 400 },
      );
    }
    if (error instanceof WriterServiceError) {
      log.warn("writer action failed", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field, retryable: error.retryable },
        { status: error.retryable ? 502 : error.status },
      );
    }
    log.error("writer action failed unexpectedly", { error });
    return NextResponse.json(
      { error: "Something went wrong in the writer. Please try again.", retryable: true },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/writer/route.ts
git commit -m "feat(writer): /api/writer route"
```

---

### Task 9: Browser client

**Files:**
- Create: `lib/writer.ts`

- [ ] **Step 1: Create `lib/writer.ts` (mirrors `lib/enhancement.ts`)**

```ts
"use client";

import type { WriterBrief } from "@/lib/domain/writer";
import { logClientEvent } from "@/lib/logging/logger";

/**
 * Browser access to the story-writer service. Mirrors lib/enhancement.ts:
 * typed payloads in, `{ error, field, retryable }` mapped errors out.
 */

export interface WriterTextResponse {
  text: string;
  model: string;
  provider: string;
}

export interface WriterSplitResponse {
  title: string;
  scenes: string[];
  model: string;
  provider: string;
}

export type WriterResponse = WriterTextResponse | WriterSplitResponse;

export type WriterPayload =
  | { action: "write"; brief: WriterBrief; modelId?: string }
  | { action: "enhance"; draft: string; instruction: string; modelId?: string }
  | {
      action: "split";
      draft: string;
      sceneCount: number;
      characterNames?: string[];
      modelId?: string;
    };

export class WriterError extends Error {
  field?: string;
  retryable: boolean;
  constructor(message: string, field?: string, retryable = true) {
    super(message);
    this.name = "WriterError";
    this.field = field;
    this.retryable = retryable;
  }
}

export async function requestWriterAction(
  payload: WriterPayload,
  signal?: AbortSignal,
): Promise<WriterResponse> {
  let response: Response;
  try {
    response = await fetch("/api/writer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    logClientEvent("writer request failed", { action: payload.action });
    throw new WriterError(
      "We could not reach the writer service. Check your connection and retry.",
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      retryable?: boolean;
    };
    throw new WriterError(
      body.error ?? "Something went wrong in the writer.",
      body.field,
      body.retryable ?? response.status >= 500,
    );
  }

  return (await response.json()) as WriterResponse;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/writer.ts
git commit -m "feat(writer): browser client for /api/writer"
```

---

### Task 10: Writer page — brief, canvas, write/enhance

**Files:**
- Create: `app/writer/page.tsx`
- Create: `components/writer/WriterView.tsx`

- [ ] **Step 1: Create the route page**

`app/writer/page.tsx`:

```tsx
import type { Metadata } from "next";
import { WriterView } from "@/components/writer/WriterView";

export const metadata: Metadata = {
  title: "Writer",
  description: "Compose a story with AI, then split it into scenes to render.",
};

export default function WriterPage() {
  return <WriterView />;
}
```

- [ ] **Step 2: Create `components/writer/WriterView.tsx`**

Full component — brief bar, draft canvas, write/enhance, model pill, cast, autosave. Split/solo buttons render here but call handlers created in Task 11 (this file compiles after Task 11; land both tasks before typechecking if preferred — the plan orders them so this task's code already contains the Task 11 handlers, marked).

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CastPicker } from "@/components/CastPicker";
import { Icon } from "@/components/Icon";
import { PillSelect } from "@/components/PillSelect";
import { Button, useToast } from "@/components/ui";
import { useCharacters } from "@/lib/character-store";
import { WRITER_TONES, type WriterToneKey } from "@/lib/constants";
import { WRITER_DEFAULT_SCENES, WRITER_DRAFT_MAX } from "@/lib/domain/writer";
import { requestWriterAction, WriterError } from "@/lib/writer";
import { putStoryAsset } from "@/lib/story/records";
import { useSettings } from "@/lib/store";
import { createWriterStoryAsset } from "@/lib/writer-story";
```

> Engineer note: `lib/writer-story.ts` (`createWriterStoryAsset`) is created in **Task 11** — implement Tasks 10 and 11 together, then typecheck.

The full component body:

```tsx
const DRAFT_KEY = "perabyte.writer.draft.v1";
const SCENE_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

interface SavedWriterDraft {
  idea: string;
  sceneCount: number;
  tone: WriterToneKey;
  draft: string;
  updatedAt: number;
}

export function WriterView() {
  const router = useRouter();
  const toast = useToast();
  const { characters } = useCharacters();
  const { settings: userSettings } = useSettings();

  const [idea, setIdea] = useState("");
  const [sceneCount, setSceneCount] = useState(WRITER_DEFAULT_SCENES);
  const [tone, setTone] = useState<WriterToneKey>("none");
  const [castIds, setCastIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [instruction, setInstruction] = useState("");
  const [undoDraft, setUndoDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "write" | "enhance" | "split" | "solo">(null);
  const [error, setError] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);

  /* Restore the autosaved draft once on mount. */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<SavedWriterDraft>;
      if (typeof saved.idea === "string") setIdea(saved.idea);
      if (typeof saved.draft === "string") setDraft(saved.draft);
      if (typeof saved.sceneCount === "number") setSceneCount(saved.sceneCount);
      if (saved.tone && saved.tone in WRITER_TONES) setTone(saved.tone);
    } catch {
      /* corrupted draft — start clean */
    }
  }, []);

  /* Autosave (debounced). */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const payload: SavedWriterDraft = { idea, sceneCount, tone, draft, updatedAt: Date.now() };
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
      } catch {
        /* storage full/blocked — non-fatal */
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [idea, sceneCount, tone, draft]);

  /* Writer model options from the provider settings payload. */
  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!alive || !data) return;
        const options = (data.providers as Array<{
          label: string;
          enabled: boolean;
          textModels: Array<{ id: string; label: string; enabled: boolean }>;
        }>)
          .filter((provider) => provider.enabled)
          .flatMap((provider) =>
            provider.textModels
              .filter((model) => model.enabled)
              .map((model) => ({ value: model.id, label: `${provider.label} — ${model.label}` })),
          );
        setModelOptions(options);
        const preferred = data.tasks?.writer;
        if (typeof preferred === "string" && options.some((o) => o.value === preferred)) {
          setModelId(preferred);
        } else if (options.length) {
          setModelId(options[0].value);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const characterNames = useCallback(
    () =>
      castIds
        .map((id) => characters.find((c) => c.id === id)?.name)
        .filter((n): n is string => Boolean(n)),
    [castIds, characters],
  );

  async function runAction(action: "write" | "enhance" | "split" | "solo") {
    if (busy) return;
    setError(null);
    if (action === "write" && !idea.trim()) {
      setError("Describe your story idea first.");
      return;
    }
    if (action !== "write" && !draft.trim()) {
      setError("Write or generate a draft first.");
      return;
    }
    if (action === "enhance" && !instruction.trim()) {
      setError("Tell the writer what to change.");
      return;
    }
    setBusy(action);
    try {
      if (action === "write") {
        const result = await requestWriterAction({
          action: "write",
          brief: {
            idea: idea.trim(),
            sceneCount,
            tone,
            characterNames: characterNames(),
            uncensored: userSettings.uncensoredEnabled,
          },
          modelId: modelId || undefined,
        });
        setUndoDraft(draft || null);
        setDraft("text" in result ? result.text : draft);
      } else if (action === "enhance") {
        const result = await requestWriterAction({
          action: "enhance",
          draft,
          instruction: instruction.trim(),
          modelId: modelId || undefined,
        });
        setUndoDraft(draft);
        setDraft("text" in result ? result.text : draft);
        setInstruction("");
      } else if (action === "split") {
        const result = await requestWriterAction({
          action: "split",
          draft,
          sceneCount,
          characterNames: characterNames(),
          modelId: modelId || undefined,
        });
        if (!("scenes" in result)) return;
        const asset = createWriterStoryAsset({
          title: result.title,
          prose: draft,
          scenes: result.scenes,
          characterIds: castIds,
        });
        const created = await putStoryAsset(asset);
        if (!created) {
          toast.push("We could not save the story. Your draft is still here — retry.", "error");
          return;
        }
        router.push(`/story?id=${asset.id}`);
      } else {
        // "solo": split to one scene, hand the prompt to Solo Mode via the
        // existing ?prompt= prefill (same seam as History regenerate links).
        const result = await requestWriterAction({
          action: "split",
          draft,
          sceneCount: 1,
          modelId: modelId || undefined,
        });
        if (!("scenes" in result) || !result.scenes[0]) return;
        router.push(`/generate/image?prompt=${encodeURIComponent(result.scenes[0])}`);
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(e instanceof WriterError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const busyLabel =
    busy === "write"
      ? "Writing…"
      : busy === "enhance"
        ? "Rewriting…"
        : busy === "split"
          ? "Splitting…"
          : busy === "solo"
            ? "Preparing…"
            : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:px-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="pen" className="h-5 w-5 text-ink-soft" />
          <h1 className="text-[19px] font-bold tracking-tight text-ink">Writer</h1>
        </div>
        <PillSelect
          icon="chip"
          label={modelOptions.find((o) => o.value === modelId)?.label ?? "Writer model"}
          value={modelId}
          options={modelOptions}
          onChange={(next) => setModelId(next)}
          align="right"
        />
      </header>

      {/* BRIEF */}
      <section className="rounded-[14px] border border-border bg-surface p-4">
        <label className="text-[12px] font-bold uppercase tracking-wide text-muted" htmlFor="writer-idea">
          Brief
        </label>
        <textarea
          id="writer-idea"
          value={idea}
          onChange={(event) => setIdea(event.target.value.slice(0, 2000))}
          rows={3}
          placeholder="A neon-noir chase through a rainy megacity where the courier discovers the package is a person…"
          className="mt-2 w-full resize-y rounded-[10px] border border-border bg-raised p-3 text-[13.5px] leading-relaxed text-ink placeholder:text-muted/70"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PillSelect
            icon="layers"
            label={`${sceneCount} scene${sceneCount === 1 ? "" : "s"}`}
            value={String(sceneCount)}
            options={SCENE_CHOICES.map((n) => ({ value: String(n), label: `${n}` }))}
            onChange={(next) => setSceneCount(Number(next))}
          />
          <PillSelect
            icon="sliders"
            label={WRITER_TONES[tone]}
            value={tone}
            options={Object.entries(WRITER_TONES).map(([value, label]) => ({ value, label }))}
            onChange={(next) => setTone(next as WriterToneKey)}
          />
          <CastPicker characters={characters} selectedIds={castIds} onChange={setCastIds} />
          <span className="grow" />
          <Button variant="primary" onClick={() => runAction("write")} disabled={busy !== null}>
            {busy === "write" ? "Writing…" : "Write for me"}
          </Button>
        </div>
      </section>

      {/* DRAFT */}
      <section className="rounded-[14px] border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <label className="text-[12px] font-bold uppercase tracking-wide text-muted" htmlFor="writer-draft">
            Draft
          </label>
          {undoDraft !== null && (
            <button
              type="button"
              className="text-[12px] font-semibold text-muted hover:text-ink"
              onClick={() => {
                setDraft(undoDraft);
                setUndoDraft(null);
              }}
            >
              Undo rewrite
            </button>
          )}
        </div>
        <textarea
          id="writer-draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, WRITER_DRAFT_MAX))}
          rows={12}
          placeholder="Write your story here, or describe it in the brief and hit “Write for me”…"
          className="mt-2 w-full resize-y rounded-[10px] border border-border bg-raised p-3 text-[13.5px] leading-relaxed text-ink placeholder:text-muted/70"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={instruction}
            onChange={(event) => setInstruction(event.target.value.slice(0, 500))}
            placeholder="Enhance with: make it darker and half the length…"
            className="h-8 grow rounded-full border border-border bg-raised px-3 text-[12.5px] text-ink placeholder:text-muted/70"
          />
          <Button variant="primary" onClick={() => runAction("enhance")} disabled={busy !== null}>
            {busy === "enhance" ? "Rewriting…" : "Enhance"}
          </Button>
        </div>
      </section>

      {/* HAND-OFF */}
      <section className="flex flex-wrap items-center justify-center gap-3">
        <Button variant="secondary" onClick={() => runAction("solo")} disabled={busy !== null || !draft.trim()}>
          {busy === "solo" ? "Preparing…" : "Use in Solo"}
        </Button>
        <Button variant="primary" onClick={() => runAction("split")} disabled={busy !== null || !draft.trim()}>
          {busy === "split" ? "Splitting…" : `Split into ${sceneCount} scene${sceneCount === 1 ? "" : "s"}`}
        </Button>
      </section>

      {error && (
        <p className="text-center text-[12.5px] font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      {busyLabel && busy !== "write" && busy !== "enhance" && (
        <p className="text-center text-[12px] text-muted">{busyLabel}</p>
      )}
    </div>
  );
}
```

Style notes for the engineer: this studio uses semantic tokens (`bg-surface`, `border-border`, `text-ink`, `text-muted`, `bg-raised`) — match neighboring pages if names drift; `Button` variants come from `components/ui.tsx` (check `variant` prop values there and use the closest to "primary"/"secondary"; adjust if the API differs). No focus rings anywhere — hover/tint shifts only.

- [ ] **Step 3: Typecheck (may fail on Task 11 imports — proceed to Task 11 first if so)**

Run: `npm run typecheck`

- [ ] **Step 4: Commit together with Task 11**

---

### Task 11: Story-record builder (`lib/writer-story.ts`)

**Files:**
- Create: `lib/writer-story.ts`

- [ ] **Step 1: Create the builder**

```ts
import { DEFAULT_IMAGE_SETTINGS, titleFromPrompt } from "@/lib/constants";
import type { Asset, StoryScene } from "@/lib/types";

/**
 * Builds the story asset the Writer hands to Story Mode. Same id scheme,
 * settings defaults and scene shape the story page uses, so the record is
 * indistinguishable from one created there (chain, cast anchors and convert
 * all apply unchanged downstream).
 */
export function createWriterStoryAsset(input: {
  title: string;
  prose: string;
  scenes: string[];
  characterIds: string[];
}): Asset {
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const scenes: StoryScene[] = input.scenes.map((prompt) => ({
    id: `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    prompt,
    url: null,
    status: "queued",
    kind: "image",
  }));
  return {
    id,
    kind: "story",
    title: input.title || titleFromPrompt(input.prose),
    prompt: input.prose,
    url: "",
    variants: [],
    settings: { ...DEFAULT_IMAGE_SETTINGS },
    createdAt: Date.now(),
    favorite: false,
    mode: "Story Mode",
    scenes,
    meta: {
      continuity: true,
      running: false,
      characterIds: input.characterIds,
    },
  };
}
```

Check `Asset.meta` typing: `Record<string, string | number | boolean | string[]>` — `characterIds: string[]` fits; `continuity: true` / `running: false` fit.

- [ ] **Step 2: Typecheck both UI tasks**

Run: `npm run typecheck`
Expected: no errors (fix `Button` variant / token names against `components/ui.tsx` and neighboring pages if the compiler or visual check flags them).

- [ ] **Step 3: Commit**

```bash
git add app/writer/page.tsx components/writer/WriterView.tsx lib/writer-story.ts
git commit -m "feat(writer): /writer page — brief, draft canvas, split-to-story and solo handoff"
```

---

### Task 12: Nav entries + spec amendment

**Files:**
- Modify: `components/SiteChrome.tsx`
- Modify: `docs/superpowers/specs/2026-09-17-story-writer-design.md`

- [ ] **Step 1: Sidebar nav**

In `components/SiteChrome.tsx`, in the `NAV` array (line ~18) between the Generate and Characters entries add:

```ts
  { href: "/writer", label: "Writer", icon: "pen" },
```

In the mobile nav array (`MOBILE_NAV`, line ~392) between "Solo Mode" and "Story Mode" add:

```ts
  { href: "/writer", label: "Writer", icon: "pen" },
```

- [ ] **Step 2: Amend the spec's Solo hand-off paragraph**

Replace the sessionStorage bullet in the spec with:

```markdown
- **Use in Solo** (secondary): runs split with count 1 → navigates to
  `/generate/image?prompt=<encoded>`, reusing the existing `?prompt=` prefill
  seam in `GeneratorScreen` (the same mechanism History/Results "Regenerate"
  links use). Chosen over a sessionStorage channel during planning — the seam
  already existed and one less handoff protocol beats URL-length concerns at
  PROMPT_MAX-scale prompts.
```

- [ ] **Step 3: Commit**

```bash
git add components/SiteChrome.tsx docs/superpowers/specs/2026-09-17-story-writer-design.md
git commit -m "feat(writer): nav entry + spec amendment for solo handoff"
```

---

### Task 13: Full verification

- [ ] **Step 1: Whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean, full suite green (baseline: whatever is green on master — record the count).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `/writer` route appears in the route table; build succeeds.

- [ ] **Step 3: Browser smoke (dev server)**

Run: `npm run dev` then verify in a browser:

1. Sidebar and mobile nav show **Writer**; the page renders with empty brief/draft.
2. Enter an idea → **Write for me** → prose appears in the draft (needs a working Sogni or Pollinations key; if neither, the error line shows the retryable message — that is also correct behavior).
3. Type an enhance instruction → **Enhance** → draft changes; **Undo rewrite** restores the previous text; reload the page → draft and brief are restored from autosave.
4. **Split into N scenes** → lands on `/story?id=…` with N queued scene cards → **Generate** runs the normal chain.
5. **Use in Solo** → lands on `/generate/image` with the composer prefilled.
6. Settings → General → "Story writer" row lists text models and persists a pick; the Writer model pill reflects it on next load.

- [ ] **Step 4: Final commit (if smoke fixes were needed) and merge**

Follow the finishing-a-development-branch flow: all green → merge `feat/story-writer` to master, remove the worktree.

---

## Self-review notes (already applied)

- Spec coverage: brief (T5/T6/T10), model pick (T1–T3, T10), write (T6/T7/T10), enhance (T6/T7/T10), split+story handoff (T6/T7/T10/T11), solo handoff (T9–T12), nav (T12), no-fallback error policy (T7/T8), tests (T1/T2/T6/T7) — all spec sections map to tasks.
- `WRITER_DRAFT_MAX` is exported from the domain module and used by the canvas cap; `WRITER_TONES` lives in constants (like IMAGE_STYLES).
- The writer-story asset uses `kind: "image"` scenes — the story page's kind toggle / per-scene kind remains user-controlled there, matching how the page creates fresh scenes.

# Provider & Model Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/settings` page managing provider enable/disable, API keys, per-provider model toggles, and per-task model selection (image / video / enhance) — every change applying instantly.

**Architecture:** Server-side runtime config (`.studio/settings.json`, gitignored) read at request time through a cached repository; `GET/PUT /api/settings` backs the page; the registry gains an optional `ProviderGate`, the enhance chain becomes config-driven, and the client bumps a catalog version after each save so open Model pills re-fetch. Spec: `docs/superpowers/specs/2026-09-15-provider-settings-design.md`.

**Tech Stack:** Next.js (App Router, nodejs runtime), TypeScript, Tailwind, vitest (node env, `lib/**/*.test.ts` only — UI verified by build + browser), localStorage external store for client settings.

**Deviation from spec (approved scope, noted here):** `ProviderGate` lives in `lib/providers/types.ts` beside the other provider contracts, not in `registry.ts`. Sogni chat model ids verified live 2026-09-15 via `GET https://api.sogni.ai/v1/models`.

**Work first, always:** Tasks 1–12 all run inside the worktree created in Task 1 (`/Users/abid/Projects/perabyte-studio/.worktrees/provider-settings`, branch `feature/provider-settings` off `feature/story-continuation@e5a67e4`). Never touch the main working tree — it carries uncommitted story work.

---

### Task 1: Worktree setup

**Files:** none created (git plumbing only)

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/abid/Projects/perabyte-studio
git worktree add .worktrees/provider-settings -b feature/provider-settings feature/story-continuation
```

Expected: `Preparing worktree (checking out 'feature/story-continuation')` + `new branch` message.

- [ ] **Step 2: Install dependencies in the worktree**

```bash
cd /Users/abid/Projects/perabyte-studio/.worktrees/provider-settings
npm install
```

Expected: clean install (reuses npm cache). `.worktrees/` is already gitignored in the main repo.

- [ ] **Step 3: Verify baseline tests pass**

```bash
npx vitest run
```

Expected: all existing suites PASS (this is the known-good baseline).

---

### Task 2: Provider config repository

**Files:**
- Create: `lib/repositories/provider-config.repository.ts`
- Test: `lib/repositories/provider-config.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/repositories/provider-config.repository.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_CONFIG,
  getProviderConfig,
  mergeProviderConfigPatch,
  providerGate,
  resetProviderConfigForTests,
  updateProviderConfig,
  type ProviderConfig,
} from "@/lib/repositories/provider-config.repository";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "perabyte-settings-"));
  process.env.STUDIO_SETTINGS_PATH = path.join(dir, "settings.json");
  resetProviderConfigForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STUDIO_SETTINGS_PATH;
  resetProviderConfigForTests();
});

describe("provider config repository", () => {
  it("returns defaults when no file exists", () => {
    expect(getProviderConfig()).toEqual(DEFAULT_PROVIDER_CONFIG);
  });

  it("persists an update and re-reads it from disk", () => {
    updateProviderConfig({
      providers: { sogni: { enabled: false } },
    });
    resetProviderConfigForTests(); // drop the memory cache
    const config = getProviderConfig();
    expect(config.providers.sogni.enabled).toBe(false);
    expect(config.providers["apikey-fan"].enabled).toBe(true); // defaults kept
    const raw = JSON.parse(readFileSync(process.env.STUDIO_SETTINGS_PATH!, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.providers.sogni.enabled).toBe(false);
  });

  it("clears a stored key with apiKey null and treats '' as clear", () => {
    updateProviderConfig({ providers: { "apikey-fan": { apiKey: "sk-stored" } } });
    expect(getProviderConfig().providers["apikey-fan"].apiKey).toBe("sk-stored");
    updateProviderConfig({ providers: { "apikey-fan": { apiKey: null } } });
    expect(getProviderConfig().providers["apikey-fan"].apiKey).toBeNull();
    updateProviderConfig({ providers: { "apikey-fan": { apiKey: "" } } });
    expect(getProviderConfig().providers["apikey-fan"].apiKey).toBeNull();
  });

  it("merges a corrupt file onto defaults instead of crashing", () => {
    writeFileSync(process.env.STUDIO_SETTINGS_PATH!, "{not json", "utf8");
    resetProviderConfigForTests();
    expect(getProviderConfig()).toEqual(DEFAULT_PROVIDER_CONFIG);
  });

  it("merges a partial file, coercing bad field types", () => {
    writeFileSync(
      process.env.STUDIO_SETTINGS_PATH!,
      JSON.stringify({
        version: 1,
        providers: { sogni: { enabled: false, apiKey: 42, disabledModels: ["sogni:ok", 7] } },
        tasks: { enhance: "sogni:m" },
        junk: true,
      }),
      "utf8",
    );
    resetProviderConfigForTests();
    const config = getProviderConfig();
    expect(config.providers.sogni).toEqual({
      enabled: false,
      apiKey: null, // non-string coerced away
      disabledModels: ["sogni:ok"], // non-string entries dropped
    });
    expect(config.tasks).toEqual({ enhance: "sogni:m" });
  });

  it("mergeProviderConfigPatch previews the merged result without persisting", () => {
    updateProviderConfig({ providers: { sogni: { apiKey: "sk-1" } } });
    const preview = mergeProviderConfigPatch({ providers: { sogni: { enabled: false } } });
    expect(preview.providers.sogni).toMatchObject({ enabled: false, apiKey: "sk-1" });
    // Nothing written: a fresh read still has the old state.
    resetProviderConfigForTests();
    expect(getProviderConfig().providers.sogni.enabled).toBe(true);
  });

  it("providerGate reads through the live cache", () => {
    expect(providerGate().isEnabled("sogni")).toBe(true);
    expect(providerGate().isModelEnabled("sogni", "sogni:m")).toBe(true);
    const config = structuredClone(DEFAULT_PROVIDER_CONFIG) as ProviderConfig;
    config.providers.sogni.enabled = false;
    config.providers.pollinations.disabledModels = ["pollinations:flux"];
    updateProviderConfig(config); // full config is also a valid patch shape
    expect(providerGate().isEnabled("sogni")).toBe(false);
    expect(providerGate().isModelEnabled("pollinations", "pollinations:flux")).toBe(false);
    expect(providerGate().isModelEnabled("pollinations", "pollinations:other")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/repositories/provider-config.repository.test.ts`
Expected: FAIL — cannot resolve `@/lib/repositories/provider-config.repository`.

- [ ] **Step 3: Write the repository**

```ts
// lib/repositories/provider-config.repository.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logging/logger";
import type { ProviderGate } from "@/lib/providers/types";

/**
 * Server-side provider settings repository. Backs the /settings page:
 * provider enable/disable, API keys saved from Settings, per-provider disabled
 * models, and the enhance task model. The JSON file (gitignored) stores only
 * deltas over the defaults so it stays forward-compatible; every read merges
 * onto the defaults and the in-memory cache is invalidated on write — the
 * next request after a change sees the new state, no restart needed.
 */
const log = logger.child({ surface: "provider-config" });

export type ProviderId = "apikey-fan" | "sogni" | "pollinations";

export interface ProviderConfigEntry {
  enabled: boolean;
  /** Key saved from Settings; null → the env var applies. Write-only: never served raw. */
  apiKey: string | null;
  /** App-wide model ids (`<providerId>:<model>`) hidden from every picker. */
  disabledModels: string[];
}

export interface ProviderConfig {
  providers: Record<ProviderId, ProviderConfigEntry>;
  tasks: {
    /** Enhance engine model id, or null for the auto chain. */
    enhance: string | null;
  };
}

export interface ProviderConfigPatch {
  providers?: Partial<Record<ProviderId, Partial<ProviderConfigEntry>>>;
  tasks?: { enhance?: string | null };
}

export const PROVIDER_IDS: ProviderId[] = ["apikey-fan", "sogni", "pollinations"];

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  providers: {
    "apikey-fan": { enabled: true, apiKey: null, disabledModels: [] },
    sogni: { enabled: true, apiKey: null, disabledModels: [] },
    pollinations: { enabled: true, apiKey: null, disabledModels: [] },
  },
  tasks: { enhance: null },
};

function settingsPath(): string {
  return process.env.STUDIO_SETTINGS_PATH?.trim() || ".studio/settings.json";
}

let cache: ProviderConfig | null = null;

function coerceEntry(raw: unknown): Partial<ProviderConfigEntry> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const entry: Partial<ProviderConfigEntry> = {};
  if (typeof source.enabled === "boolean") entry.enabled = source.enabled;
  if (typeof source.apiKey === "string") entry.apiKey = source.apiKey || null;
  if (source.apiKey === null) entry.apiKey = null;
  if (Array.isArray(source.disabledModels)) {
    entry.disabledModels = source.disabledModels.filter(
      (model): model is string => typeof model === "string",
    );
  }
  return Object.keys(entry).length ? entry : null;
}

function mergeDefaults(raw: unknown): ProviderConfig {
  const config = structuredClone(DEFAULT_PROVIDER_CONFIG);
  if (typeof raw !== "object" || raw === null) return config;
  const source = raw as Record<string, unknown>;
  if (typeof source.providers === "object" && source.providers !== null) {
    const providers = source.providers as Record<string, unknown>;
    for (const id of PROVIDER_IDS) {
      const entry = coerceEntry(providers[id]);
      if (entry) config.providers[id] = { ...config.providers[id], ...entry };
    }
  }
  if (typeof source.tasks === "object" && source.tasks !== null) {
    const tasks = (source.tasks as Record<string, unknown>).enhance;
    if (typeof tasks === "string" || tasks === null) config.tasks.enhance = tasks;
  }
  return config;
}

function readFromDisk(): ProviderConfig {
  const file = settingsPath();
  if (!existsSync(file)) return structuredClone(DEFAULT_PROVIDER_CONFIG);
  try {
    return mergeDefaults(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    // Corrupt file: run on defaults rather than taking the studio down.
    log.warn("unreadable provider settings file — using defaults", {
      file,
      message: (error as Error)?.message,
    });
    return structuredClone(DEFAULT_PROVIDER_CONFIG);
  }
}

export function getProviderConfig(): ProviderConfig {
  cache ??= readFromDisk();
  return cache;
}

/** Pure merge of a patch onto the live config — used to preview + validate
 * updates before anything is persisted. */
export function mergeProviderConfigPatch(patch: ProviderConfigPatch): ProviderConfig {
  const config = structuredClone(getProviderConfig());
  if (patch.providers) {
    for (const [id, change] of Object.entries(patch.providers)) {
      if (!(id in config.providers) || !change) continue;
      const current = config.providers[id as ProviderId];
      config.providers[id as ProviderId] = {
        enabled: change.enabled ?? current.enabled,
        apiKey: change.apiKey !== undefined ? change.apiKey : current.apiKey,
        disabledModels: change.disabledModels ?? current.disabledModels,
      };
    }
  }
  if (patch.tasks?.enhance !== undefined) config.tasks.enhance = patch.tasks.enhance;
  return config;
}

export function updateProviderConfig(patch: ProviderConfigPatch): ProviderConfig {
  const config = mergeProviderConfigPatch(patch);
  const file = settingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  cache = config;
  return config;
}

/** Gate wired into the provider registry. Reads through the live cache on
 * every call, so settings changes apply to the very next request. */
export function providerGate(): ProviderGate {
  return {
    isEnabled: (providerId) =>
      getProviderConfig().providers[providerId as ProviderId]?.enabled ?? true,
    isModelEnabled: (providerId, modelId) =>
      !getProviderConfig()
        .providers[providerId as ProviderId]?.disabledModels.includes(modelId),
  };
}

/** Test hook: inject a config without touching the filesystem. */
export function setProviderConfigForTests(config: ProviderConfig | null): void {
  cache = config ? structuredClone(config) : null;
}

/** Test hook: drop the in-memory cache (next read hits disk / defaults). */
export function resetProviderConfigForTests(): void {
  cache = null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/repositories/provider-config.repository.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/repositories/provider-config.repository.ts lib/repositories/provider-config.repository.test.ts
git commit -m "feat(settings): provider config repository — deltas over defaults, instant invalidate"
```

---

### Task 3: API keys saved in Settings override env

**Files:**
- Modify: `lib/config/env.ts`
- Test: `lib/config/env.test.ts` (additions)

- [ ] **Step 1: Add the failing tests** (append a new `describe` inside `env.test.ts`, and extend the existing `afterEach` cleanup)

```ts
// lib/config/env.test.ts — new imports at top:
import {
  DEFAULT_PROVIDER_CONFIG,
  resetProviderConfigForTests,
  setProviderConfigForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import type { ProviderConfig } from "@/lib/repositories/provider-config.repository";
// afterEach gains:  resetProviderConfigForTests();

describe("provider settings key overrides", () => {
  const configWith = (fn: (config: ProviderConfig) => void): ProviderConfig => {
    const config = structuredClone(DEFAULT_PROVIDER_CONFIG) as ProviderConfig;
    fn(config);
    return config;
  };

  it("prefers the key saved in Settings over the env key", () => {
    setEnv({ SOGNI_API_KEY: "sk-env" });
    setProviderConfigForTests(
      configWith((c) => {
        c.providers.sogni.apiKey = "sk-settings";
      }),
    );
    resetStudioEnvForTests();
    expect(getStudioEnv().sogniApiKey).toBe("sk-settings");
  });

  it("falls back to the env key when no Settings key is stored", () => {
    setEnv({ SOGNI_API_KEY: "sk-env" });
    resetStudioEnvForTests();
    expect(getStudioEnv().sogniApiKey).toBe("sk-env");
  });

  it("picks up a newly saved key without a restart (cache invalidation)", () => {
    setEnv({ SOGNI_API_KEY: undefined, APIKEY_FAN_API_KEY: "sk-fan-env" });
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-fan-env");
    updateProviderConfig({ providers: { "apikey-fan": { apiKey: "sk-fan-new" } } });
    // updateProviderConfig → invalidateStudioEnv() → next read re-merges.
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-fan-new");
  });

  it("clearing the Settings key returns to the env key", () => {
    setEnv({ SOGNI_API_KEY: "sk-env" });
    updateProviderConfig({ providers: { sogni: { apiKey: "sk-settings" } } });
    expect(getStudioEnv().sogniApiKey).toBe("sk-settings");
    updateProviderConfig({ providers: { sogni: { apiKey: null } } });
    expect(getStudioEnv().sogniApiKey).toBe("sk-env");
  });
});
```

Also add `SOGNI_API_KEY: undefined` handling: the existing `setEnv` helper already deletes undefined keys. Extend the file's existing `afterEach` block to also call `resetProviderConfigForTests()` and delete `SOGNI_API_KEY` if it was set (add `SOGNI_API_KEY: undefined` to its `setEnv({...})` call).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/config/env.test.ts`
Expected: FAIL — `getStudioEnv().sogniApiKey` is `"sk-env"`, not `"sk-settings"`.

- [ ] **Step 3: Implement the override layer**

In `lib/config/env.ts`:

```ts
// new import:
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";

// inside parseEnv(), replace the two key lines of the return object:
  const config = getProviderConfig();
  const settingsFanKey = config.providers["apikey-fan"].apiKey;
  const settingsSogniKey = config.providers.sogni.apiKey;

  return {
    apiKeyFanBaseUrl,
    apiKeyFanApiKey: settingsFanKey ?? (apiKey ? apiKey : null),
    sogniApiKey: settingsSogniKey ?? (sogniApiKey ? sogniApiKey : null),
    // …rest unchanged
  };
```

```ts
// below getStudioEnv():
/** Drop the parsed snapshot so the next getStudioEnv() re-reads env + settings.
 * Called by the settings service after every config write. */
export function invalidateStudioEnv(): void {
  cached = null;
}

/** Test hook: force a re-read of process.env. */
export function resetStudioEnvForTests(): void {
  invalidateStudioEnv();
}
```

Then wire the automatic invalidation in `lib/repositories/provider-config.repository.ts` — `updateProviderConfig` becomes:

```ts
export function updateProviderConfig(patch: ProviderConfigPatch): ProviderConfig {
  const config = mergeProviderConfigPatch(patch);
  const file = settingsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  cache = config;
  invalidateStudioEnv();
  return config;
}
```

with `import { invalidateStudioEnv } from "@/lib/config/env";` at the top of the repository. (Dependency direction: env → repository for the merged read; repository → env for write-side invalidation. Both are server-only, the import graph stays acyclic at the module level because env.ts only calls the repository *inside* `parseEnv()` at runtime, and the repository only calls `invalidateStudioEnv()` at runtime.)

Wait — that *is* a static import cycle (`env.ts` ↔ repository). Break it: the repository must NOT import env.ts. Instead, `env.ts` exposes the invalidation via a registration hook. In `lib/config/env.ts`:

```ts
let externalInvalidate: (() => void) | null = null;

/** Register a callback fired whenever the env snapshot must be dropped
 * (provider settings writes). Avoids a static import cycle. */
export function onInvalidateStudioEnv(callback: () => void): void {
  externalInvalidate = callback;
}
```

and in the repository module scope:

```ts
import { onInvalidateStudioEnv } from "@/lib/config/env";
// after updateProviderConfig definition:
onInvalidateStudioEnv(() => {
  cache = null;
});
```

Hmm — that registers the *repository's* cache clear, not env's. Reversing it is cleaner: the **service layer** (Task 7) owns cross-cache invalidation exactly as the spec says: `updateProviderConfig(patch)` stays as in Task 2 (invalidates only its own cache), and `applyProviderSettingsUpdate` calls `invalidateStudioEnv()` itself. **Drop `onInvalidateStudioEnv` entirely.** The Task 3 test "picks up a newly saved key without a restart" moves to Task 7's service test file, where the service is in the loop. The three other tests in this task stand (they call `resetStudioEnvForTests()` explicitly or go through explicit invalidation).

Final shape for this task: env.ts gains the import + merge + `invalidateStudioEnv()` export (aliasing `resetStudioEnvForTests`), the repository is untouched, and the third test is rewritten to invalidate explicitly:

```ts
  it("picks up a newly saved key once the env cache is invalidated", () => {
    setEnv({ SOGNI_API_KEY: undefined, APIKEY_FAN_API_KEY: "sk-fan-env" });
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-fan-env");
    updateProviderConfig({ providers: { "apikey-fan": { apiKey: "sk-fan-new" } } });
    invalidateStudioEnv(); // the settings service does this after every write
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-fan-new");
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/config/env.test.ts lib/repositories/provider-config.repository.test.ts`
Expected: PASS (all, including the pre-existing env tests).

- [ ] **Step 5: Commit**

```bash
git add lib/config/env.ts lib/config/env.test.ts
git commit -m "feat(config): settings-stored API keys override env in StudioEnv"
```

---

### Task 4: Registry ProviderGate

**Files:**
- Modify: `lib/providers/types.ts` (add `ProviderGate`)
- Modify: `lib/providers/registry.ts`
- Test: `lib/providers/registry.test.ts` (additions)

- [ ] **Step 1: Add the failing tests** (append inside `registry.test.ts`)

```ts
import { providerGate } from "@/lib/repositories/provider-config.repository";
import {
  DEFAULT_PROVIDER_CONFIG,
  setProviderConfigForTests,
  resetProviderConfigForTests,
} from "@/lib/repositories/provider-config.repository";
// (merge into the existing import list — vi import style of the file stays)

describe("registry provider gate", () => {
  afterEach(() => resetProviderConfigForTests());

  const gateConfig = () => {
    const config = structuredClone(DEFAULT_PROVIDER_CONFIG);
    config.providers["apikey-fan"].enabled = false;
    config.providers.pollinations.disabledModels = ["pollinations:flux"];
    return config;
  };

  it("filters disabled providers and models out of the lists", () => {
    setProviderConfigForTests(gateConfig());
    const registry = createRegistry([grok, flux]);
    expect(registry.listModels("image").map((m) => m.id)).toEqual([]);
    expect(registry.listModels("video").map((m) => m.id)).toEqual([
      "pollinations:flux-keyframe",
    ]);
  });

  it("defaultModel skips disabled providers and models", () => {
    setProviderConfigForTests(gateConfig());
    const registry = createRegistry([grok, flux]);
    expect(registry.defaultModel("video").id).toBe("pollinations:flux-keyframe");
  });

  it("resolve returns null for a disabled model but findAnywhere still finds it", () => {
    setProviderConfigForTests(gateConfig());
    const registry = createRegistry([grok, flux]);
    expect(registry.resolve("pollinations:flux")).toBeNull();
    expect(registry.findAnywhere("pollinations:flux")?.provider.id).toBe("pollinations");
  });

  it("hidden models are gated too", () => {
    setProviderConfigForTests(gateConfig());
    const hidden: ModelDescriptor = {
      id: "pollinations:flux-end",
      providerId: "pollinations",
      kind: "video",
      model: "flux-end",
      label: "Flux end",
      frameInput: { start: true, end: true },
    };
    const provider = fakeProvider({ id: "pollinations", configured: true });
    (provider as { listHiddenModels: () => ModelDescriptor[] }).listHiddenModels = () => [hidden];
    const registry = createRegistry([provider]);
    expect(registry.listAllModels("video")).toEqual([]);
  });

  it("a disabled provider's models resolve to null even when configured", () => {
    setProviderConfigForTests(gateConfig());
    const registry = createRegistry([grok, flux]);
    expect(registry.resolve("apikey-fan:grok-imagine-image-2.0")).toBeNull();
  });

  it("no gate passed means everything is enabled (existing behaviour)", () => {
    const registry = createRegistry([grok, flux]);
    expect(registry.listModels("image").map((m) => m.id)).toEqual([
      "apikey-fan:grok-imagine-image-2.0",
      "pollinations:flux",
    ]);
  });
});
```

Note: `createRegistry` with an explicitly injected gate is also exercised implicitly — the app wiring is covered in Task 7's service tests.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/providers/registry.test.ts`
Expected: FAIL — gate config has no effect yet (first test's `listModels("image")` returns both models).

- [ ] **Step 3: Implement**

Add to `lib/providers/types.ts` (below `GenerationProvider`):

```ts
/**
 * Provider settings gate: consulted before models are listed or resolved.
 * A disabled provider hides its whole catalog; a disabled model drops out of
 * pickers and resolution. Absent gate = everything enabled (tests, defaults).
 */
export interface ProviderGate {
  isEnabled(providerId: string): boolean;
  isModelEnabled(providerId: string, modelId: string): boolean;
}
```

Rewrite `lib/providers/registry.ts`:

```ts
import type { ModelKind, ModelDescriptor } from "@/lib/domain/models";
import type { ImageProvider, VideoProvider, ProviderGate } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import { apiKeyFanProvider } from "@/lib/providers/apikey-fan/apikey-fan.provider";
import { sogniProvider } from "@/lib/providers/sogni/sogni.provider";
import { pollinationsProvider } from "@/lib/providers/pollinations/pollinations.provider";
import { providerGate } from "@/lib/repositories/provider-config.repository";

/**
 * Provider registry (Factory). `createRegistry` accepts any provider list and
 * an optional settings gate — tests inject fakes; the app uses
 * `getGenerationRegistry()`, which wires the real adapters plus the live
 * provider-settings gate in priority order (keyed providers first, fallback
 * last).
 */
export interface ResolvedModel {
  provider: ImageProvider | VideoProvider;
  model: ModelDescriptor;
}

export interface ProviderRegistry {
  listModels(kind: ModelKind): ModelDescriptor[];
  listAllModels(kind: ModelKind): ModelDescriptor[];
  defaultModel(kind: ModelKind): ModelDescriptor;
  resolve(modelId: string): ResolvedModel | null;
  findAnywhere(modelId: string): { provider: AnyProvider; model: ModelDescriptor } | null;
}

type AnyProvider = ImageProvider & Partial<VideoProvider>;

const PERMISSIVE_GATE: ProviderGate = {
  isEnabled: () => true,
  isModelEnabled: () => true,
};

let registered: AnyProvider[] = [];

/** Every registered provider — configured or not, enabled or not. Used by the
 * settings inventory, which must show the full picture. */
export function getRegisteredProviders(): AnyProvider[] {
  return registered;
}

function modelsOf(provider: AnyProvider, kind: ModelKind): ModelDescriptor[] {
  return kind === "image"
    ? (provider as ImageProvider).listImageModels()
    : (provider as VideoProvider).listVideoModels?.() ?? [];
}

function hiddenModelsOf(provider: AnyProvider): ModelDescriptor[] {
  return provider.listHiddenModels?.() ?? [];
}

export function createRegistry(
  providers: AnyProvider[],
  gate: ProviderGate = PERMISSIVE_GATE,
): ProviderRegistry {
  registered = providers;
  const gateEnabled = (provider: AnyProvider) =>
    gate.isEnabled(provider.id) && provider.isConfigured();

  return {
    listModels(kind) {
      return providers
        .filter(gateEnabled)
        .flatMap((provider) =>
          modelsOf(provider, kind).filter((model) =>
            gate.isModelEnabled(provider.id, model.id),
          ),
        );
    },

    listAllModels(kind) {
      return providers
        .filter(gateEnabled)
        .flatMap((provider) =>
          [...modelsOf(provider, kind), ...hiddenModelsOf(provider)].filter((model) =>
            gate.isModelEnabled(provider.id, model.id),
          ),
        );
    },

    defaultModel(kind) {
      const models = this.listModels(kind);
      const fallback = models[0];
      if (!fallback) {
        throw new ProviderError("No render provider is available.", { retryable: false });
      }
      return fallback;
    },

    resolve(modelId) {
      const found = this.findAnywhere(modelId);
      if (
        found &&
        gate.isEnabled(found.provider.id) &&
        found.provider.isConfigured() &&
        gate.isModelEnabled(found.provider.id, modelId)
      ) {
        return { provider: found.provider, model: found.model };
      }
      return null;
    },

    findAnywhere(modelId) {
      for (const provider of providers) {
        const model = [
          ...modelsOf(provider, "image"),
          ...modelsOf(provider, "video"),
          ...hiddenModelsOf(provider),
        ].find((candidate) => candidate.id === modelId);
        if (model) return { provider, model };
      }
      return null;
    },
  };
}

let registry: ProviderRegistry | null = null;

export function getGenerationRegistry(): ProviderRegistry {
  registry ??= createRegistry([apiKeyFanProvider, sogniProvider, pollinationsProvider], providerGate());
  return registry;
}

/** Test hook: swap the app registry. */
export function setRegistryForTests(fake: ProviderRegistry | null): void {
  registry = fake;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/providers/registry.test.ts lib/providers/registry.wiring.test.ts`
Expected: PASS (new + existing). If the wiring test asserts an exact `createRegistry` call signature, update it to expect the gate argument.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/types.ts lib/providers/registry.ts lib/providers/registry.test.ts lib/providers/registry.wiring.test.ts
git commit -m "feat(registry): ProviderGate — provider/model enable filtering + settings inventory access"
```

---

### Task 5: TextProvider capability (Sogni + Pollinations)

**Files:**
- Modify: `lib/providers/types.ts`
- Modify: `lib/providers/sogni/sogni.text.ts`
- Modify: `lib/providers/sogni/sogni.provider.ts`
- Modify: `lib/providers/pollinations/pollinations.text.ts`
- Modify: `lib/providers/pollinations/pollinations.provider.ts`
- Test: `lib/providers/sogni/sogni.text.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// lib/providers/sogni/sogni.text.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { SOGNI_TEXT_MODELS, sogniTextComplete } from "@/lib/providers/sogni/sogni.text";

function okReply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
});

describe("sogniTextComplete", () => {
  it("sends the requested chat model to the completions endpoint", async () => {
    process.env.SOGNI_API_KEY = "test-key";
    resetStudioEnvForTests();
    const fetchMock = vi.fn(async () => okReply("Enhanced prompt."));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await sogniTextComplete(SOGNI_TEXT_MODELS[1].id, "make it pop");
    expect(reply).toBe("Enhanced prompt.");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("qwen3.6-35b-a3b-gguf-iq4xs");
    expect(fetchMock.mock.calls[0][0]).toContain("/v1/chat/completions");
  });

  it("falls back to the default model for a bare or unknown id", async () => {
    process.env.SOGNI_API_KEY = "test-key";
    resetStudioEnvForTests();
    const fetchMock = vi.fn(async () => okReply("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await sogniTextComplete("sogni:not-a-model", "hi");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe(
      "qwen3.5-35b-a3b-abliterated-gguf-q4km",
    );
  });

  it("refuses to run without a key (engine falls through)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sogniTextComplete(SOGNI_TEXT_MODELS[0].id, "hi")).rejects.toThrow(
      "Sogni is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty content reply as a failure", async () => {
    process.env.SOGNI_API_KEY = "test-key";
    resetStudioEnvForTests();
    vi.stubGlobal("fetch", vi.fn(async () => okReply("")));
    await expect(sogniTextComplete(SOGNI_TEXT_MODELS[0].id, "hi")).rejects.toThrow(
      "empty reply",
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/providers/sogni/sogni.text.test.ts`
Expected: FAIL — `SOGNI_TEXT_MODELS` does not exist / `sogniTextComplete` ignores the model argument.

- [ ] **Step 3: Implement**

`lib/providers/types.ts` — add below `ProviderGate`:

```ts
export interface TextCompletionOptions {
  signal?: AbortSignal;
}

/** A text-capable provider's chat models, in preference order. */
export interface TextModelDescriptor {
  /** App-wide id: `<providerId>:<providerModelId>`. */
  id: string;
  label: string;
}

/** Optional provider capability: chat-style text completion (Enhance). */
export interface TextProvider {
  listTextModels(): TextModelDescriptor[];
  textComplete(
    modelId: string,
    instruction: string,
    options?: TextCompletionOptions,
  ): Promise<string>;
}
```

Rewrite `lib/providers/sogni/sogni.text.ts` (the fetch/error handling body is unchanged except `model` now comes from the argument):

```ts
import { getStudioEnv } from "@/lib/config/env";
import { buildModelId, parseModelId } from "@/lib/domain/models";
import type { TextCompletionOptions, TextModelDescriptor } from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";

/**
 * Text-completion adapter over Sogni's OpenAI-compatible chat endpoint.
 * Primary Enhance engine: the key is already required for Sogni renders,
 * completions ride the account subscription (no per-call charge observed).
 *
 * Reasoning quirk: with a tight `max_tokens` the model spends everything on
 * hidden reasoning and answers `content: ""` — an empty content is treated
 * as an engine failure so the service falls through to the next engine.
 */
const PROVIDER_ID = "sogni";
const DEFAULT_MODEL = "qwen3.5-35b-a3b-abliterated-gguf-q4km";
const TIMEOUT_MS = 25_000;

/** Chat models verified live 2026-09-15 (GET /v1/models). */
export const SOGNI_TEXT_MODELS: TextModelDescriptor[] = [
  { id: buildModelId(PROVIDER_ID, DEFAULT_MODEL), label: "Qwen 3.5 35B (uncensored)" },
  { id: buildModelId(PROVIDER_ID, "qwen3.6-35b-a3b-gguf-iq4xs"), label: "Qwen 3.6 35B" },
  {
    id: buildModelId(PROVIDER_ID, "deepseek-v4-flash-vision-exp-dspark-1m"),
    label: "DeepSeek V4 Flash Vision",
  },
];

export interface TextCompletionOptionsSogni extends TextCompletionOptions {}

export async function sogniTextComplete(
  modelId: string,
  instruction: string,
  options: TextCompletionOptions = {},
): Promise<string> {
  const env = getStudioEnv();
  if (!env.sogniApiKey) {
    throw new ProviderError("Sogni is not configured.", { retryable: false });
  }
  const model = parseModelId(modelId)?.model ?? DEFAULT_MODEL;

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.sogniRestUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.sogniApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You rewrite AI-generation prompts. Follow the user's rules exactly and reply with the rewritten prompt only.",
          },
          { role: "user", content: instruction },
        ],
        max_tokens: 700,
        stream: false,
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new ProviderError("The Sogni enhancer timed out.", { retryable: true });
    }
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ProviderError("The Sogni enhancer is unreachable.", { retryable: true });
  }

  if (!response.ok) {
    throw new ProviderError(`The Sogni enhancer replied ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = body?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) {
    throw new ProviderError("The Sogni enhancer returned an empty reply.", {
      retryable: true,
    });
  }
  return content;
}
```

(Drop the `TextCompletionOptionsSogni` placeholder if unused — keep only what's referenced. The old `TextCompletionOptions` local interface is deleted; consumers import the one from `types.ts`.)

`lib/providers/pollinations/pollinations.text.ts` — add:

```ts
import { buildModelId } from "@/lib/domain/models";
import type { TextModelDescriptor } from "@/lib/providers/types";

/** The legacy GET endpoint serves one shared-pool model. */
export const POLLINATIONS_TEXT_MODELS: TextModelDescriptor[] = [
  { id: buildModelId("pollinations", "default"), label: "Pollinations (free tier)" },
];
```

(the existing `pollinationsTextComplete(instruction, options)` signature stays; the local `TextCompletionOptions` interface stays — it is structurally identical to the shared one and only adds `seed`. Change it to `import type { TextCompletionOptions } from "@/lib/providers/types"` and extend: `interface PollinationsTextOptions extends TextCompletionOptions { seed?: number }` — update the function signature accordingly.)

`lib/providers/sogni/sogni.provider.ts`:

```ts
// type changes: export const sogniProvider: ImageProvider & VideoProvider & TextProvider = {
// new imports: import type { TextProvider } from "@/lib/providers/types";
//              import { SOGNI_TEXT_MODELS, sogniTextComplete } from "@/lib/providers/sogni/sogni.text";
// new members on the singleton:
  listTextModels: () => SOGNI_TEXT_MODELS,
  textComplete: (modelId, instruction, options) =>
    sogniTextComplete(modelId, instruction, options),
```

`lib/providers/pollinations/pollinations.provider.ts`:

```ts
// type changes: export const pollinationsProvider: ImageProvider & VideoProvider & TextProvider = {
// new imports: import type { TextProvider } from "@/lib/providers/types";
//              import { POLLINATIONS_TEXT_MODELS } from "@/lib/providers/pollinations/pollinations.text";
//              import { pollinationsTextComplete } from "@/lib/providers/pollinations/pollinations.text"; // merge into one import line
// new members on the singleton:
  listTextModels: () => POLLINATIONS_TEXT_MODELS,
  textComplete: (_modelId, instruction, options) =>
    pollinationsTextComplete(instruction, options),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/providers/sogni/sogni.text.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/types.ts lib/providers/sogni/sogni.text.ts lib/providers/sogni/sogni.provider.ts lib/providers/pollinations/pollinations.text.ts lib/providers/pollinations/pollinations.provider.ts lib/providers/sogni/sogni.text.test.ts
git commit -m "feat(text): TextProvider capability — Sogni chat models + Pollinations default"
```

---

### Task 6: Config-driven enhancement chain

**Files:**
- Modify: `lib/services/enhancement.service.ts`
- Test: `lib/services/enhancement.service.test.ts` (additions + cleanup hook)

- [ ] **Step 1: Add the failing tests**

In `enhancement.service.test.ts`, extend imports and `afterEach`:

```ts
import { structuredClone } from "node:util"; // NOT needed — structuredClone is global in node ≥17; omit
import {
  DEFAULT_PROVIDER_CONFIG,
  resetProviderConfigForTests,
  setProviderConfigForTests,
} from "@/lib/repositories/provider-config.repository";
import type { ProviderConfig } from "@/lib/repositories/provider-config.repository";
// afterEach gains:  resetProviderConfigForTests();

function configWith(fn: (config: ProviderConfig) => void): ProviderConfig {
  const config = structuredClone(DEFAULT_PROVIDER_CONFIG) as ProviderConfig;
  fn(config);
  return config;
}
```

New tests:

```ts
  it("skips engines whose provider is switched off in settings", async () => {
    enableSogni();
    setProviderConfigForTests(
      configWith((c) => {
        c.providers.pollinations.enabled = false;
      }),
    );
    const fetchMock = mockFetchOnce(async () => {
      throw new Error("must not be called");
    });
    const result = await runPromptEnhancement(BODY);
    expect(result.source).toBe("fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a disabled enhance model in the auto chain", async () => {
    enableSogni();
    setProviderConfigForTests(
      configWith((c) => {
        c.providers.sogni.disabledModels = ["sogni:qwen3.5-35b-a3b-abliterated-gguf-q4km"];
      }),
    );
    const fetchMock = mockFetchOnce(async () => {
      throw new Error("must not be called");
    });
    const result = await runPromptEnhancement(BODY);
    expect(result.source).toBe("fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes to the selected enhance model", async () => {
    enableSogni();
    setProviderConfigForTests(
      configWith((c) => {
        c.tasks.enhance = "sogni:qwen3.6-35b-a3b-gguf-iq4xs";
      }),
    );
    const fetchMock = mockFetchOnce(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "Picked model reply." } }] }), {
          status: 200,
        }),
    );
    const result = await runPromptEnhancement(BODY);
    expect(result.source).toBe("ai");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("qwen3.6-35b-a3b-gguf-iq4xs");
  });

  it("does not reuse a cached reply across different enhance models", async () => {
    enableSogni();
    const fetchMock = mockFetchOnce(async () => new Response("First take.", { status: 200 }));
    await runPromptEnhancement({ prompt: "a red barn", kind: "image" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setProviderConfigForTests(
      configWith((c) => {
        c.tasks.enhance = "pollinations:default";
      }),
    );
    await runPromptEnhancement({ prompt: "a red barn", kind: "image" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
```

(For the last test, `pollinations:default` is owned by Pollinations, so the Sogni default still chains after it — either way a second fetch must happen, proving the cache no longer masks the change.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/services/enhancement.service.test.ts`
Expected: the new tests FAIL (settings ignored; cache reused across model change).

- [ ] **Step 3: Implement**

In `lib/services/enhancement.service.ts`:

Replace the imports of the two text modules and the `ENGINES` const with:

```ts
import type { TextProvider } from "@/lib/providers/types";
import { sogniProvider } from "@/lib/providers/sogni/sogni.provider";
import { pollinationsProvider } from "@/lib/providers/pollinations/pollinations.provider";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";
import type { ProviderId } from "@/lib/repositories/provider-config.repository";

/** Text engines in priority order — keyed provider first, keyless fallback. */
const TEXT_ENGINES: TextProvider[] = [sogniProvider, pollinationsProvider];

interface TextEngineCall {
  /** App-wide model id driving this attempt (also the log label). */
  engineId: string;
  run: (instruction: string, options: { signal?: AbortSignal }) => Promise<string>;
}

/**
 * One attempt per enabled text provider: its default (first) model — or
 * exactly the user's chosen enhance model on the provider that owns it.
 * A selected model that is disabled, or whose provider is off, simply drops
 * out; the remaining enabled providers keep the chain alive.
 */
function buildEngineChain(): TextEngineCall[] {
  const config = getProviderConfig();
  const selected = config.tasks.enhance;
  const chain: TextEngineCall[] = [];
  for (const provider of TEXT_ENGINES) {
    const entry = config.providers[provider.id as ProviderId];
    if (entry && !entry.enabled) continue;
    const models = provider
      .listTextModels()
      .filter((model) => !entry?.disabledModels.includes(model.id));
    if (!models.length) continue;
    const model =
      selected && models.some((candidate) => candidate.id === selected)
        ? models.find((candidate) => candidate.id === selected)!
        : models[0];
    chain.push({
      engineId: model.id,
      run: (instruction, options) =>
        provider.textComplete(model.id, instruction, options),
    });
  }
  return chain;
}
```

Update `cacheKey` to include the selection (so switching models is never masked by a cached reply):

```ts
function cacheKey(request: ValidatedEnhancement): string {
  const context = { ...request, enhanceModel: getProviderConfig().tasks.enhance };
  delete (context as { prompt?: string }).prompt;
  return createHash("sha1")
    .update(JSON.stringify({ prompt: request.prompt, context }))
    .digest("hex");
}
```

Update the loop in `runPromptEnhancement`:

```ts
    const instruction = enhancementInstruction(request.prompt, request);
    let lastError: unknown;
    for (const engine of buildEngineChain()) {
      try {
        const reply = await engine.run(instruction, { signal: options.signal });
        // …body identical to the current loop, with `engine: engine.engineId`
        // in the log.info call and the same sanitize/cache/return flow…
```

(Keep the abort check, sanitizer, cache set, and the final deterministic-fallback catch exactly as they are.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/services/enhancement.service.test.ts`
Expected: PASS (new + all existing).

- [ ] **Step 5: Commit**

```bash
git add lib/services/enhancement.service.ts lib/services/enhancement.service.test.ts
git commit -m "feat(enhance): config-driven engine chain with task model selection"
```

---

### Task 7: Provider settings service (inventory + validation)

**Files:**
- Create: `lib/services/provider-settings.service.ts`
- Test: `lib/services/provider-settings.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/provider-settings.service.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { buildModelId, type ModelDescriptor } from "@/lib/domain/models";
import { createRegistry, setRegistryForTests } from "@/lib/providers/registry";
import type { ImageProvider, VideoProvider } from "@/lib/providers/types";
import {
  DEFAULT_PROVIDER_CONFIG,
  resetProviderConfigForTests,
} from "@/lib/repositories/provider-config.repository";
import {
  applyProviderSettingsUpdate,
  getProviderSettings,
  ProviderSettingsError,
} from "@/lib/services/provider-settings.service";
import type { ProviderConfig } from "@/lib/repositories/provider-config.repository";

function fakeProvider(options: {
  id: string;
  label?: string;
  configured?: boolean;
  models?: ModelDescriptor[];
  textModelIds?: string[];
}): ImageProvider & VideoProvider & Partial<{ listTextModels: () => { id: string; label: string }[] }> {
  const models = options.models ?? [];
  const provider: ImageProvider & VideoProvider & Record<string, unknown> = {
    id: options.id,
    label: options.label ?? options.id,
    isConfigured: () => options.configured ?? true,
    listImageModels: () => models.filter((m) => m.kind === "image"),
    generateImage: async () => [],
    listVideoModels: () => models.filter((m) => m.kind === "video"),
    generateVideo: async () => [],
  };
  if (options.textModelIds) {
    provider.listTextModels = () =>
      options.textModelIds!.map((id) => ({ id, label: id.split(":")[1] }));
  }
  return provider as ImageProvider & VideoProvider;
}

const grokModel: ModelDescriptor = {
  id: buildModelId("apikey-fan", "grok-imagine-image-2.0"),
  providerId: "apikey-fan",
  kind: "image",
  model: "grok-imagine-image-2.0",
  label: "Grok Imagine 2.0",
};

const polliImage: ModelDescriptor = {
  id: buildModelId("pollinations", "flux"),
  providerId: "pollinations",
  kind: "image",
  model: "flux",
  label: "Flux",
};

function wireRegistry() {
  createRegistry([
    fakeProvider({ id: "apikey-fan", label: "apikey.fan", models: [grokModel], textModelIds: undefined }),
    fakeProvider({ id: "sogni", label: "Sogni AI", models: [], textModelIds: ["sogni:qwen-a", "sogni:qwen-b"] }),
    fakeProvider({ id: "pollinations", label: "Pollinations", models: [polliImage], textModelIds: ["pollinations:default"] }),
  ]);
}

afterEach(() => {
  setRegistryForTests(null);
  resetProviderConfigForTests();
  delete process.env.SOGNI_API_KEY;
  delete process.env.APIKEY_FAN_API_KEY;
  resetStudioEnvForTests();
});

describe("provider settings service", () => {
  it("builds the inventory in priority order with masked keys", () => {
    process.env.SOGNI_API_KEY = "sk-env-key-1234";
    resetStudioEnvForTests();
    wireRegistry();
    const payload = getProviderSettings();
    expect(payload.providers.map((p) => p.id)).toEqual(["apikey-fan", "sogni", "pollinations"]);
    const sogni = payload.providers[1];
    expect(sogni.keySource).toBe("env");
    expect(sogni.keyMasked).toBe("••••1234");
    expect(sogni.keySupported).toBe(true);
    expect(payload.providers[2].keySupported).toBe(false); // Pollinations is keyless
    expect(payload.providers[0].keySource).toBeNull();
    expect(sogni.textModels.map((m) => m.id)).toEqual(["sogni:qwen-a", "sogni:qwen-b"]);
  });

  it("reports a Settings-saved key with its source and mask", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ providers: { sogni: { apiKey: "sk-saved-9999" } } });
    const sogni = getProviderSettings().providers[1];
    expect(sogni.keySource).toBe("settings");
    expect(sogni.keyMasked).toBe("••••9999");
  });

  it("shows hidden frame-capable models but not plain hidden ones", () => {
    wireRegistry();
    // sogni fake has no hidden models; assert pollinations surface + enabled flags
    const polli = getProviderSettings().providers[2];
    expect(polli.models.map((m) => m.id)).toEqual(["pollinations:flux"]);
    expect(polli.models[0].enabled).toBe(true);
  });

  it("applies toggles and disables models", () => {
    wireRegistry();
    const payload = applyProviderSettingsUpdate({
      providers: { "apikey-fan": { enabled: false }, pollinations: { disabledModels: ["pollinations:flux"] } },
    });
    expect(payload.providers[0].enabled).toBe(false);
    expect(payload.providers[2].models[0].enabled).toBe(false);
    expect(payload.providers[2].textModels[0].enabled).toBe(true); // models only
  });

  it("rejects disabling the last enabled provider", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ providers: { "apikey-fan": { enabled: false }, sogni: { enabled: false } } });
    expect(() =>
      applyProviderSettingsUpdate({ providers: { pollinations: { enabled: false } } }),
    ).toThrow(ProviderSettingsError);
  });

  it("rejects unknown providers, models, and enhance targets", () => {
    wireRegistry();
    expect(() => applyProviderSettingsUpdate({ providers: { nope: { enabled: false } } })).toThrow(ProviderSettingsError);
    expect(() =>
      applyProviderSettingsUpdate({ providers: { sogni: { disabledModels: ["sogni:ghost"] } } }),
    ).toThrow(/Unknown model/);
    expect(() => applyProviderSettingsUpdate({ tasks: { enhance: "sogni:ghost" } })).toThrow(/enhancement/i);
    expect(() => applyProviderSettingsUpdate({ providers: { sogni: { apiKey: 5 as unknown as string } } })).toThrow(ProviderSettingsError);
  });

  it("treats an empty-string key as clear", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ providers: { sogni: { apiKey: "sk-temp-abcd" } } });
    expect(getProviderSettings().providers[1].keySource).toBe("settings");
    const payload = applyProviderSettingsUpdate({ providers: { sogni: { apiKey: "" } } });
    expect(payload.providers[1].keySource).not.toBe("settings");
  });

  it("accepts the enhance selection only from known text models", () => {
    wireRegistry();
    const payload = applyProviderSettingsUpdate({ tasks: { enhance: "sogni:qwen-b" } });
    expect(payload.tasks.enhance).toBe("sogni:qwen-b");
    applyProviderSettingsUpdate({ tasks: { enhance: null } });
    expect(getProviderSettings().tasks.enhance).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/services/provider-settings.service.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service**

```ts
// lib/services/provider-settings.service.ts
import { getStudioEnv, invalidateStudioEnv } from "@/lib/config/env";
import type { ModelDescriptor } from "@/lib/domain/models";
import { getRegisteredProviders } from "@/lib/providers/registry";
import type { TextProvider } from "@/lib/providers/types";
import {
  PROVIDER_IDS,
  getProviderConfig,
  mergeProviderConfigPatch,
  updateProviderConfig,
  type ProviderConfigPatch,
  type ProviderId,
} from "@/lib/repositories/provider-config.repository";

/**
 * Provider settings orchestration (Facade): assembles the full provider
 * inventory for the /settings page (never exposing raw keys) and validates +
 * applies updates. Validation lives here rather than in the repository so the
 * repository stays a thin, dependency-free persistence layer.
 */

export interface ProviderModelView {
  id: string;
  kind: "image" | "video";
  label: string;
  hint?: string;
  enabled: boolean;
  frameInput?: { start: boolean; end: boolean };
}

export interface ProviderTextModelView {
  id: string;
  label: string;
  enabled: boolean;
}

export interface ProviderView {
  id: string;
  label: string;
  enabled: boolean;
  /** Whether this provider takes an API key at all (Pollinations is keyless). */
  keySupported: boolean;
  keySource: "settings" | "env" | null;
  keyMasked: string | null;
  models: ProviderModelView[];
  textModels: ProviderTextModelView[];
}

export interface ProviderSettingsPayload {
  providers: ProviderView[];
  tasks: { enhance: string | null };
}

export interface ProviderSettingsUpdate {
  providers?: Record<
    string,
    { enabled?: boolean; apiKey?: string | null; disabledModels?: string[] }
  >;
  tasks?: { enhance?: string | null };
}

export class ProviderSettingsError extends Error {
  readonly status = 400;
  readonly field?: string;

  constructor(message: string, options?: { field?: string }) {
    super(message);
    this.name = "ProviderSettingsError";
    this.field = options?.field;
  }
}

const KEY_ENV_FIELD: Partial<Record<ProviderId, "apiKeyFanApiKey" | "sogniApiKey">> = {
  "apikey-fan": "apiKeyFanApiKey",
  sogni: "sogniApiKey",
};

function maskKey(key: string): string {
  return `••••${key.slice(-4)}`;
}

function keyView(id: ProviderId): Pick<ProviderView, "keySupported" | "keySource" | "keyMasked"> {
  const envField = KEY_ENV_FIELD[id];
  const stored = getProviderConfig().providers[id]?.apiKey;
  if (stored) return { keySupported: true, keySource: "settings", keyMasked: maskKey(stored) };
  const envKey = envField ? getStudioEnv()[envField] : null;
  if (envKey) return { keySupported: true, keySource: "env", keyMasked: maskKey(envKey) };
  return { keySupported: envField !== undefined, keySource: null, keyMasked: null };
}

function listableModels(provider: ReturnType<typeof getRegisteredProviders>[number]): ModelDescriptor[] {
  const visible = [
    ...(provider.listImageModels ?? []),
    ...(provider.listVideoModels?.() ?? []),
  ];
  const hidden = provider.listHiddenModels?.() ?? [];
  // Picker models plus hidden models any picker can surface (frame-capable).
  return [...visible, ...hidden.filter((model) => model.frameInput)];
}

export function getProviderSettings(): ProviderSettingsPayload {
  const config = getProviderConfig();
  const providers = getRegisteredProviders().map((provider) => {
    const id = provider.id as ProviderId;
    const entry = config.providers[id];
    const disabled = entry?.disabledModels ?? [];
    const models = listableModels(provider).map((model) => ({
      id: model.id,
      kind: model.kind,
      label: model.label,
      hint: model.hint,
      enabled: !disabled.includes(model.id),
      frameInput: model.frameInput,
    }));
    const textProvider = provider as TextProvider;
    const textModels =
      "listTextModels" in textProvider
        ? textProvider.listTextModels().map((model) => ({
            id: model.id,
            label: model.label,
            enabled: !disabled.includes(model.id),
          }))
        : [];
    return {
      id,
      label: provider.label,
      enabled: entry?.enabled ?? true,
      ...keyView(id),
      models,
      textModels,
    };
  });
  return { providers, tasks: { enhance: config.tasks.enhance } };
}

function knownModelIds(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const provider of getRegisteredProviders()) {
    map.set(provider.id, new Set(listableModels(provider).map((model) => model.id)));
  }
  return map;
}

function allTextModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const provider of getRegisteredProviders()) {
    const text = provider as TextProvider;
    if ("listTextModels" in text) {
      text.listTextModels().forEach((model) => ids.add(model.id));
    }
  }
  return ids;
}

export function applyProviderSettingsUpdate(body: unknown): ProviderSettingsPayload {
  if (typeof body !== "object" || body === null) {
    throw new ProviderSettingsError("Invalid settings payload.");
  }
  const raw = body as ProviderSettingsUpdate;
  const patch: ProviderConfigPatch = {};
  const knownModels = knownModelIds();

  if (raw.providers !== undefined) {
    if (typeof raw.providers !== "object" || raw.providers === null) {
      throw new ProviderSettingsError("Invalid providers payload.", { field: "providers" });
    }
    const providerPatch: NonNullable<ProviderConfigPatch["providers"]> = {};
    for (const [id, change] of Object.entries(raw.providers)) {
      if (!PROVIDER_IDS.includes(id as ProviderId)) {
        throw new ProviderSettingsError(`Unknown provider "${id}".`, { field: "providers" });
      }
      if (typeof change !== "object" || change === null) {
        throw new ProviderSettingsError(`Invalid update for "${id}".`, { field: "providers" });
      }
      const entry: { enabled?: boolean; apiKey?: string | null; disabledModels?: string[] } = {};
      if (change.enabled !== undefined) {
        if (typeof change.enabled !== "boolean") {
          throw new ProviderSettingsError("Enabled must be true or false.", { field: "providers" });
        }
        entry.enabled = change.enabled;
      }
      if (change.apiKey !== undefined) {
        if (change.apiKey !== null && typeof change.apiKey !== "string") {
          throw new ProviderSettingsError("The API key must be text.", { field: "providers" });
        }
        entry.apiKey = change.apiKey === "" ? null : change.apiKey;
      }
      if (change.disabledModels !== undefined) {
        if (!Array.isArray(change.disabledModels)) {
          throw new ProviderSettingsError("Invalid model list.", { field: "providers" });
        }
        const known = knownModels.get(id) ?? new Set<string>();
        for (const modelId of change.disabledModels) {
          if (!known.has(modelId)) {
            throw new ProviderSettingsError(`Unknown model "${modelId}".`, { field: "providers" });
          }
        }
        entry.disabledModels = change.disabledModels.filter((m) => typeof m === "string");
      }
      providerPatch[id as ProviderId] = entry;
    }
    patch.providers = providerPatch;
  }

  if (raw.tasks !== undefined) {
    if (typeof raw.tasks !== "object" || raw.tasks === null) {
      throw new ProviderSettingsError("Invalid tasks payload.", { field: "tasks" });
    }
    if (raw.tasks.enhance !== undefined) {
      const enhance = raw.tasks.enhance;
      if (enhance !== null && typeof enhance !== "string") {
        throw new ProviderSettingsError("Invalid enhancement model.", { field: "tasks" });
      }
      if (typeof enhance === "string" && !allTextModelIds().has(enhance)) {
        throw new ProviderSettingsError(`Unknown enhancement model "${enhance}".`, { field: "tasks" });
      }
      patch.tasks = { enhance };
    }
  }

  // The last enabled provider is load-bearing: renders need at least one.
  const preview = mergeProviderConfigPatch(patch);
  const enabledCount = PROVIDER_IDS.filter((id) => preview.providers[id].enabled).length;
  if (enabledCount === 0) {
    throw new ProviderSettingsError("Keep at least one provider enabled.", { field: "providers" });
  }

  updateProviderConfig(patch);
  invalidateStudioEnv();
  return getProviderSettings();
}
```

Note on `listableModels`: `provider.listImageModels` is always present (`ImageProvider`), so the spread is `...(provider.listImageModels())`. Adjust the first spread to `...provider.listImageModels()` if the type of `getRegisteredProviders()[number]` keeps `listImageModels` non-optional.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/services/provider-settings.service.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/services/provider-settings.service.ts lib/services/provider-settings.service.test.ts
git commit -m "feat(settings): provider settings service — inventory, validation, masked keys"
```

---

### Task 8: `/api/settings` route

**Files:**
- Create: `app/api/settings/route.ts`

- [ ] **Step 1: Implement** (thin over the service — route logic is covered by the service tests)

```ts
// app/api/settings/route.ts
import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  applyProviderSettingsUpdate,
  getProviderSettings,
  ProviderSettingsError,
} from "@/lib/services/provider-settings.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/settings" });

/** Full provider inventory for the settings page. Keys are masked — raw keys
 * are write-only. */
export async function GET() {
  return NextResponse.json(getProviderSettings(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function PUT(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // falls through to the validation error below
  }
  try {
    const payload = applyProviderSettingsUpdate(body);
    log.info("provider settings updated");
    return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProviderSettingsError) {
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: error.status },
      );
    }
    log.warn("provider settings update failed", { message: (error as Error)?.message });
    return NextResponse.json({ error: "Could not save settings." }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/api/settings/route.ts
git commit -m "feat(api): GET/PUT /api/settings"
```

---

### Task 9: Client catalog invalidation + nullable model defaults

**Files:**
- Modify: `lib/repositories/settings.repository.ts`
- Modify: `lib/model-catalog.ts`
- Test: `lib/repositories/settings.repository.test.ts` (addition)

- [ ] **Step 1: Add the failing test** (inside the existing `describe`)

```ts
  it("bumps the catalog version on demand", () => {
    expect(getCatalogVersion()).toBe(0);
    bumpCatalogVersion();
    expect(getCatalogVersion()).toBe(1);
    bumpCatalogVersion();
    expect(getCatalogVersion()).toBe(2);
  });

  it("accepts null to clear a model default", () => {
    setSelectedModel("image", "pollinations:flux");
    setSelectedModel("image", null);
    expect(getSelectedModel("image")).toBeNull();
  });
```

with `bumpCatalogVersion` and `getCatalogVersion` added to the import list.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/repositories/settings.repository.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

`lib/repositories/settings.repository.ts` — widen the setter and add the version counter:

```ts
export function setSelectedModel(kind: GenerationKind, modelId: string | null) {
  update(kind === "video" ? { videoModel: modelId } : { imageModel: modelId });
}
```

```ts
// Bumped after a provider-settings save so open model catalogs re-fetch.
let catalogVersion = 0;

export function bumpCatalogVersion(): void {
  catalogVersion += 1;
  emit();
}

export function getCatalogVersion(): number {
  return catalogVersion;
}

/** Reactive view for hooks that must re-run when provider settings change. */
export function useCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => catalogVersion, () => 0);
}
```

`lib/model-catalog.ts` — invalidate + version-aware hook:

```ts
import { useCatalogVersion } from "@/lib/repositories/settings.repository";
// …existing code…

/** Drop cached catalog promises so the next useModelCatalog call re-fetches.
 * Called after provider settings change. */
export function invalidateModelCatalog(): void {
  catalogCache.clear();
}

export function useModelCatalog(
  kind: GenerationKind,
  frame?: "start" | "end",
): CatalogState {
  const version = useCatalogVersion();
  const [state, setState] = useState<CatalogState>({
    models: [],
    defaultModelId: null,
    loading: true,
  });

  useEffect(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true }));
    fetchCatalog(kind, frame)
      .then((catalog) => {
        if (active) {
          setState({ models: catalog.models, defaultModelId: catalog.defaultModelId, loading: false });
        }
      })
      .catch(() => {
        if (active) setState({ models: [], defaultModelId: null, loading: false });
      });
    return () => {
      active = false;
    };
  }, [kind, frame, version]);

  return state;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/repositories/settings.repository.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/repositories/settings.repository.ts lib/repositories/settings.repository.test.ts lib/model-catalog.ts
git commit -m "feat(catalog): client invalidation on settings change + nullable model defaults"
```

---

### Task 10: `/settings` page

**Files:**
- Create: `app/settings/page.tsx`
- Create: `components/settings/ContentPreferencesSection.tsx`
- Create: `components/settings/ProvidersSection.tsx`
- Create: `components/settings/TaskModelsSection.tsx`
- Modify: `components/ui.tsx` (Toggle gains `disabled`)

No unit tests (repo convention: UI verified by typecheck, build, browser — Task 12).

- [ ] **Step 1: Extend Toggle with `disabled`** (`components/ui.tsx`) — add `disabled?: boolean` to the props type, pass it to the `<button>` (`disabled={disabled}`), and append `disabled:opacity-40 disabled:cursor-not-allowed` to the button className.

- [ ] **Step 2: ContentPreferencesSection** — move the Uncensored block out of the dialog verbatim:

```tsx
// components/settings/ContentPreferencesSection.tsx
"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog, Toggle, useToast } from "@/components/ui";
import { setUncensoredEnabled, useSettings } from "@/lib/repositories/settings.repository";

/** The single gate for every uncensored feature — disabled by default, with
 * an explicit adult-content confirmation before it turns on. */
export function ContentPreferencesSection() {
  const toast = useToast();
  const { settings } = useSettings();
  const [confirmUncensored, setConfirmUncensored] = useState(false);

  return (
    <section>
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
        Content preferences
      </p>
      <div className="mt-3 rounded-[14px] border border-border bg-surface p-4">
        <Toggle
          label="Uncensored Mode"
          description="Unlocks the Character Studio Uncensored mode and adult (18+) image and video generation. Off by default."
          checked={settings.uncensoredEnabled}
          onChange={(next) => {
            if (next) {
              setConfirmUncensored(true);
              return;
            }
            setUncensoredEnabled(false);
            toast.push("Uncensored Mode disabled. Renders stay safe.");
          }}
        />
        {settings.uncensoredEnabled ? (
          <p className="mt-3 flex items-start gap-1.5 rounded-[10px] bg-[#fffbeb] px-2.5 py-2 text-[12px] font-medium text-warning">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
            Uncensored Mode is on. All content is intended for adults (18+) only.
          </p>
        ) : (
          <p className="mt-3 text-[11.5px] leading-snug text-muted">
            Enabling requires confirming you are 18+ and accept adult-content generation.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmUncensored}
        title="Enable Uncensored Mode?"
        body="This unlocks adult (18+) content, including explicit image, video and character generation. Characters are always adults. You confirm you are 18 or older."
        confirmLabel="Enable 18+ mode"
        onCancel={() => setConfirmUncensored(false)}
        onConfirm={() => {
          setUncensoredEnabled(true);
          setConfirmUncensored(false);
          toast.push("Uncensored Mode enabled.", "success");
        }}
      />
    </section>
  );
}
```

- [ ] **Step 3: ProvidersSection**

```tsx
// components/settings/ProvidersSection.tsx
"use client";

import { useState } from "react";
import { Badge, Toggle, useToast } from "@/components/ui";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export function ProvidersSection({
  providers,
  onUpdate,
}: {
  providers: ProviderView[];
  onUpdate: OnUpdate;
}) {
  const enabledCount = providers.filter((provider) => provider.enabled).length;

  return (
    <section>
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Providers</p>
      <div className="mt-3 space-y-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            lockDisable={provider.enabled && enabledCount <= 1}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </section>
  );
}

function statusOf(provider: ProviderView): { label: string; tone: "success" | "warning" | "neutral" } {
  if (!provider.enabled) return { label: "Off", tone: "neutral" };
  return provider.keySource || !provider.keySupported
    ? { label: "Active", tone: "success" }
    : { label: "Needs API key", tone: "warning" };
}

function ProviderCard({
  provider,
  lockDisable,
  onUpdate,
}: {
  provider: ProviderView;
  lockDisable: boolean;
  onUpdate: OnUpdate;
}) {
  const toast = useToast();
  const [keyDraft, setKeyDraft] = useState("");
  const status = statusOf(provider);

  function saveKey() {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setKeyDraft("");
    onUpdate({ providers: { [provider.id]: { apiKey: trimmed } } }).catch(() => undefined);
  }

  function clearKey() {
    setKeyDraft("");
    onUpdate({ providers: { [provider.id]: { apiKey: null } } }).catch(() => undefined);
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-bold text-ink">{provider.label}</p>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <Toggle
          label={`Enable ${provider.label}`}
          checked={provider.enabled}
          disabled={lockDisable}
          onChange={(next) => {
            if (!next && lockDisable) {
              toast.push("Keep at least one provider enabled.");
              return;
            }
            onUpdate({ providers: { [provider.id]: { enabled: next } } }).catch(() => undefined);
          }}
        />
      </div>
      {lockDisable ? (
        <p className="mt-1 text-[11.5px] text-muted">
          {provider.label} is your only enabled provider.
        </p>
      ) : null}

      {provider.keySupported ? (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-[12px] font-semibold text-ink-soft">API key</p>
          <p className="mt-0.5 text-[11.5px] text-muted">
            {provider.keySource === "settings"
              ? `Saved in Settings ${provider.keyMasked}`
              : provider.keySource === "env"
                ? `Using environment key ${provider.keyMasked}`
                : "Not configured"}
          </p>
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              value={keyDraft}
              placeholder={provider.keySource ? "Replace key…" : "Paste API key…"}
              aria-label={`${provider.label} API key`}
              onChange={(event) => setKeyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveKey();
              }}
              className="h-9 w-full rounded-[10px] border border-border-strong bg-white px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={saveKey}
              disabled={!keyDraft.trim()}
              className="h-9 shrink-0 rounded-[10px] bg-primary px-3 text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
            {provider.keySource === "settings" ? (
              <button
                type="button"
                onClick={clearKey}
                className="h-9 shrink-0 rounded-[10px] border border-border-strong px-3 text-[12.5px] font-semibold text-ink-soft transition-colors hover:bg-surface-2"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {provider.models.length || provider.textModels.length ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {provider.models.length ? (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Models</p>
              <div className="mt-1 divide-y divide-border">
                {provider.models.map((model) => (
                  <ModelRow
                    key={model.id}
                    label={model.label}
                    hint={model.hint}
                    checked={model.enabled}
                    onToggle={() =>
                      onUpdate({
                        providers: { [provider.id]: { enabled: true } },
                      }).then(() =>
                        // Second update flips the model once the provider is on.
                        onUpdate({
                          providers: {
                            [provider.id]: {
                              disabledModels: model.enabled
                                ? [...provider.models.filter((m) => m.enabled).map((m) => m.id), model.id].filter(
                                    (id) => id !== "" && provider.models.some((m) => m.id === id && m.enabled !== (id === model.id) || id === model.id),
                                  )
                                : provider.models
                                    .filter((m) => m.enabled)
                                    .map((m) => m.id)
                                    .filter((id) => id !== model.id),
                            },
                          },
                        }),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
```

**Stop — that onToggle draft is wrong.** Disabled-model updates must send the **full next disabled list** for the provider, and enabling a disabled provider is a separate concern. Replace the whole `ModelRow` onToggle with a clean precomputed patch:

```tsx
                  <ModelRow
                    key={model.id}
                    label={model.label}
                    hint={model.hint}
                    checked={model.enabled}
                    onToggle={() => {
                      const currentlyDisabled = provider.models
                        .filter((m) => !m.enabled)
                        .map((m) => m.id)
                        .concat(provider.textModels.filter((m) => !m.enabled).map((m) => m.id));
                      const nextDisabled = model.enabled
                        ? [...currentlyDisabled, model.id]
                        : currentlyDisabled.filter((id) => id !== model.id);
                      onUpdate({
                        providers: { [provider.id]: { disabledModels: nextDisabled } },
                      }).catch(() => undefined);
                    }}
                  />
```

with the shared row component at the bottom of the file:

```tsx
function ModelRow({
  label,
  hint,
  checked,
  onToggle,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div>
        <p className="text-[12.5px] font-medium text-ink">{label}</p>
        {hint ? <p className="text-[11.5px] text-muted">{hint}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={`Toggle ${label}`}
        onClick={onToggle}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-border-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
```

And render text models under their own sub-heading inside the same bordered block (after the models list):

```tsx
          {provider.textModels.length ? (
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Text models</p>
              <div className="mt-1 divide-y divide-border">
                {provider.textModels.map((model) => (
                  <ModelRow
                    key={model.id}
                    label={model.label}
                    checked={model.enabled}
                    onToggle={() => {
                      const currentlyDisabled = provider.models
                        .filter((m) => !m.enabled)
                        .map((m) => m.id)
                        .concat(provider.textModels.filter((m) => !m.enabled).map((m) => m.id));
                      const nextDisabled = model.enabled
                        ? [...currentlyDisabled, model.id]
                        : currentlyDisabled.filter((id) => id !== model.id);
                      onUpdate({
                        providers: { [provider.id]: { disabledModels: nextDisabled } },
                      }).catch(() => undefined);
                    }}
                  />
                ))}
              </div>
            </div>
          ) : null}
```

(The `ProviderCard` model block therefore contains the Models group, the Text models group, and nothing else — discard the earlier wrong `onToggle` snippet entirely.)

- [ ] **Step 4: TaskModelsSection**

```tsx
// components/settings/TaskModelsSection.tsx
"use client";

import { SelectField } from "@/components/ui";
import { useModelCatalog } from "@/lib/model-catalog";
import { setSelectedModel, useSettings } from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export function TaskModelsSection({
  providers,
  enhanceModel,
  onUpdate,
}: {
  providers: ProviderView[];
  enhanceModel: string | null;
  onUpdate: OnUpdate;
}) {
  const { settings, ready } = useSettings();
  const image = useModelCatalog("image");
  const video = useModelCatalog("video");
  const enhanceOptions = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.textModels
        .filter((model) => model.enabled)
        .map((model) => ({ id: model.id, label: `${provider.label} — ${model.label}` })),
    );

  return (
    <section>
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Task models</p>
      <div className="mt-3 space-y-4 rounded-[14px] border border-border bg-surface p-4">
        {ready ? (
          <>
            <SelectField
              label="Default image model"
              value={settings.imageModel ?? ""}
              onChange={(event) => setSelectedModel("image", event.target.value || null)}
            >
              <option value="">Workspace default</option>
              {image.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Default video model"
              value={settings.videoModel ?? ""}
              onChange={(event) => setSelectedModel("video", event.target.value || null)}
            >
              <option value="">Workspace default</option>
              {video.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Prompt enhancement"
              value={enhanceModel ?? ""}
              onChange={(event) =>
                onUpdate({ tasks: { enhance: event.target.value || null } }).catch(() => undefined)
              }
            >
              <option value="">Auto (recommended)</option>
              {enhanceOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </SelectField>

            <p className="border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
              Per-workspace choices made with the Model badge in each prompt window override
              these defaults.
            </p>
          </>
        ) : (
          <p className="text-[12.5px] text-muted">Loading models…</p>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: The page**

```tsx
// app/settings/page.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { ContentPreferencesSection } from "@/components/settings/ContentPreferencesSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import { TaskModelsSection } from "@/components/settings/TaskModelsSection";
import { useToast } from "@/components/ui";
import { bumpCatalogVersion, invalidateModelCatalog } from "@/lib/model-catalog";
import type {
  ProviderSettingsPayload,
  ProviderSettingsUpdate,
} from "@/lib/services/provider-settings.service";

export default function SettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<ProviderSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/settings")
      .then(async (response) => {
        if (!response.ok) throw new Error(`settings ${response.status}`);
        return (await response.json()) as ProviderSettingsPayload;
      })
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch(() => {
        if (active) setLoadError("Could not load provider settings. Is the studio server running?");
      });
    return () => {
      active = false;
    };
  }, []);

  const onUpdate = useCallback(
    async (patch: ProviderSettingsUpdate) => {
      const previous = data;
      if (previous) setData(optimisticMerge(previous, patch));
      try {
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const payload = (await response.json()) as ProviderSettingsPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Could not save settings.");
        setData(payload);
        invalidateModelCatalog();
        bumpCatalogVersion();
      } catch (cause) {
        // Roll the optimistic merge back from server truth.
        const recovery = await fetch("/api/settings").catch(() => null);
        if (recovery?.ok) setData((await recovery.json()) as ProviderSettingsPayload);
        else if (previous) setData(previous);
        toast.push((cause as Error).message || "Could not save settings.");
        throw cause;
      }
    },
    [data, toast],
  );

  return (
    <div className="mx-auto w-full max-w-[720px] flex-1 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-lg font-bold text-ink">Settings</h1>
        <p className="mt-1 text-[13px] text-muted">
          Studio-wide preferences, stored on this device.
        </p>
      </header>

      <div className="mt-6 space-y-8 pb-10">
        <ContentPreferencesSection />
        {loadError ? (
          <p className="text-[13px] font-medium text-danger">{loadError}</p>
        ) : data ? (
          <>
            <ProvidersSection providers={data.providers} onUpdate={onUpdate} />
            <TaskModelsSection
              providers={data.providers}
              enhanceModel={data.tasks.enhance}
              onUpdate={onUpdate}
            />
          </>
        ) : (
          <p className="text-[13px] text-muted">Loading settings…</p>
        )}
      </div>
    </div>
  );
}

/** Optimistic client-side mirror of the patch, so toggles feel instant even
 * before the PUT resolves. Server truth replaces it on response. */
function optimisticMerge(
  current: ProviderSettingsPayload,
  patch: ProviderSettingsUpdate,
): ProviderSettingsPayload {
  const providers = current.providers.map((provider) => {
    const change = patch.providers?.[provider.id];
    if (!change) return provider;
    const disabledModels = change.disabledModels ?? null;
    return {
      ...provider,
      enabled: change.enabled ?? provider.enabled,
      keySource:
        change.apiKey === undefined
          ? provider.keySource
          : change.apiKey
            ? ("settings" as const)
            : null,
      keyMasked:
        change.apiKey === undefined || change.apiKey === null
          ? change.apiKey === null
            ? null
            : provider.keyMasked
          : `••••${change.apiKey.slice(-4)}`,
      models: disabledModels
        ? provider.models.map((model) => ({
            ...model,
            enabled: !disabledModels.includes(model.id),
          }))
        : provider.models,
      textModels: disabledModels
        ? provider.textModels.map((model) => ({
            ...model,
            enabled: !disabledModels.includes(model.id),
          }))
        : provider.textModels,
    };
  });
  return {
    providers,
    tasks: patch.tasks?.enhance !== undefined ? { enhance: patch.tasks.enhance } : current.tasks,
  };
}
```

Note: `onUpdate` rethrows after rollback so component callers' `.catch(() => undefined)` stays quiet — the toast already fired.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/settings/page.tsx components/settings/ContentPreferencesSection.tsx components/settings/ProvidersSection.tsx components/settings/TaskModelsSection.tsx components/ui.tsx
git commit -m "feat(settings): /settings page — providers, API keys, model toggles, task models"
```

---

### Task 11: Chrome wiring — retire the dialog

**Files:**
- Modify: `components/SiteChrome.tsx`
- Delete: `components/settings/SettingsDialog.tsx`

- [ ] **Step 1: Rewire SiteChrome**

- Remove the `SettingsDialog` import, the `settingsOpen` state, and the trailing `<SettingsDialog … />` render (including its comment about backdrop-blur trapping — no longer applicable).
- Replace the account-menu settings `<button>` with:

```tsx
                <Link
                  href="/settings"
                  role="menuitem"
                  className="block rounded-[10px] px-2.5 py-2 text-[13px] font-medium text-ink-soft hover:bg-surface-2"
                  onClick={() => setAccountOpen(false)}
                >
                  Settings
                </Link>
```

- Add a settings button next to the account button (inside the `ml-auto flex items-center gap-2` div, before the account `<div>`):

```tsx
          <Link
            href="/settings"
            aria-label="Settings"
            className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-muted hover:text-ink"
          >
            <Icon name="sliders" size={16} />
          </Link>
```

- Add to `FOOTER_LINKS`: `{ href: "/settings", label: "Settings" },` before the Style guide entry.

- [ ] **Step 2: Delete the dialog**

```bash
git rm components/settings/SettingsDialog.tsx
```

- [ ] **Step 3: Typecheck + grep for stragglers**

Run: `npm run typecheck && grep -rn "SettingsDialog" components app lib || true`
Expected: typecheck clean, no references.

- [ ] **Step 4: Commit**

```bash
git add components/SiteChrome.tsx
git commit -m "feat(chrome): header, account menu and footer entry points to /settings; drop dialog"
```

---

### Task 12: Gitignore, Sogni guide note, full verification

**Files:**
- Modify: `.gitignore`
- Modify: `docs/sogni-api-guide.md`
- Modify: `lib/providers/sogni/catalog.test.ts` — only if Task 4's registry change ripples (it should not).

- [ ] **Step 1: Ignore the settings file** — append to `.gitignore` under the media-cache block:

```
# provider settings saved from the /settings page
/.studio
```

- [ ] **Step 2: Document the Sogni LLM routes** — append a short section to `docs/sogni-api-guide.md`:

```markdown
## LLM surface (verified live 2026-09-15)

- `GET /v1/models` → the three chat models:
  `qwen3.5-35b-a3b-abliterated-gguf-q4km` (default Enhance model, uncensored),
  `qwen3.6-35b-a3b-gguf-iq4xs`, `deepseek-v4-flash-vision-exp-dspark-1m`.
- `POST /v1/chat/completions` — OpenAI-compatible; Bearer auth with the regular
  Sogni key; rides the account subscription (no per-call charge observed).
  Tight `max_tokens` spends on hidden reasoning → empty `content` (treated as
  engine failure by the Enhance chain).
```

- [ ] **Step 3: Full test suite + typecheck + build**

Run:
```bash
npm test && npm run typecheck && npm run build
```
Expected: all green, build succeeds.

- [ ] **Step 4: Live API verification** (dev server in the worktree; port 3311 — never 3000)

```bash
npm run dev -- -p 3311 &   # from the worktree root
sleep 8
# 1. Inventory: masked keys, three providers
curl -s http://localhost:3311/api/settings | head -c 600
# 2. Toggle a model off
curl -s -X PUT http://localhost:3311/api/settings -H 'content-type: application/json' \
  -d '{"providers":{"sogni":{"disabledModels":["sogni:qwen3.6-35b-a3b-gguf-iq4xs"]}}}' > /dev/null
# 3. The disabled model is gone from the catalog instantly
curl -s "http://localhost:3311/api/models?kind=image" | grep -c "qwen3.6-35b-a3b-gguf-iq4xs" || echo "0 (hidden ✓)"
# 4. Last-provider rule enforced
curl -s -X PUT http://localhost:3311/api/settings -H 'content-type: application/json' \
  -d '{"providers":{"sogni":{"enabled":false},"apikey-fan":{"enabled":false},"pollinations":{"enabled":false}}}'
# → {"error":"Keep at least one provider enabled.",...} with status 400
# 5. Restore
curl -s -X PUT http://localhost:3311/api/settings -H 'content-type: application/json' \
  -d '{"providers":{"sogni":{"enabled":true,"disabledModels":[]}}}' > /dev/null
```

Expected: step 1 shows `"keyMasked":"••••…"` (never a raw key); step 3 shows the model absent from the catalog with no server restart; step 4 returns 400.

- [ ] **Step 5: Browser verification of `/settings`** (GUI pass per `browser-verification-gotchas` memory: dev server already on 3311; use the session's browser tooling)

1. Open `http://localhost:3311/settings` — three sections render; providers show status badges.
2. Toggle Sogni off → badge flips to "Off" and its models gray out **without reload**; the generate page's Model pill (open in a second tab) drops Sogni models after the catalog bump.
3. Toggle Sogni back on; disable one Sogni video model → it disappears from the video pill in the other tab.
4. Paste a dummy API key for apikey.fan → Save → hint reads "Saved in Settings ••••abcd"; Clear → returns to "Using environment key …" (env key present in `.env.local`) or "Not configured".
5. Try to disable the last enabled provider → toggle blocked with the inline hint.
6. Task models: switch Prompt enhancement to a specific Sogni model, run Enhance on `/generate/image`, confirm the dev-server log shows `engine: "sogni:<chosen-model>"`; switch back to Auto.
7. Kill the dev server.

- [ ] **Step 6: Final commit**

```bash
git add .gitignore docs/sogni-api-guide.md
git commit -m "chore: ignore .studio settings, document Sogni LLM routes"
```

---

## Verification matrix (spec § → proof)

| Spec requirement | Proof |
| --- | --- |
| Provider enable/disable, instant | Task 4 tests + Task 12 step 4 (no restart) |
| API keys in Settings, masked reads, env fallback | Task 3 tests + Task 7 tests + Task 12 step 4.1 |
| Per-provider model toggles | Task 4 tests + Task 7 test + Task 12 step 3 |
| Task models: image/video/enhance | Task 6 tests + Task 10 components |
| Instant client refresh | Task 9 (`bumpCatalogVersion` → `useModelCatalog` refetch) + Task 12 step 5.2 |
| Last-provider rule | Task 7 test + Task 12 step 4.4 |
| Enhance never fails | Task 6: all-disabled → deterministic fallback (existing suite) |

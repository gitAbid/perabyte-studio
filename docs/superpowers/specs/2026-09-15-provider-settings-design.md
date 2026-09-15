# Provider & Model Settings — Design

Date: 2026-09-15
Status: pending review
Related: `docs/superpowers/specs/2026-09-15-sogni-provider-design.md`, `lib/repositories/settings.repository.ts`, `lib/providers/registry.ts`, `lib/services/enhancement.service.ts`

## Goal

A dedicated `/settings` page where the user manages API providers end to end: enable/disable a
provider, set or clear its API key, enable/disable individual models per provider, and pick the
default model per task (image, video, prompt enhancement). Every change applies instantly — no
reload, no restart.

## Decisions (agreed with the user)

1. **All three tasks** get model selection in Settings: default Image model, default Video model,
   and the Prompt Enhancement model. The per-workspace Model badge keeps working — it and the
   Settings default share the same stored preference.
2. **Separate page, not a dialog**: `/settings` replaces `SettingsDialog`; the header account-menu
   item and a new header button navigate to it.
3. **API keys are managed in Settings** and must take effect without a server restart.

## Research basis (verified in the codebase, 2026-09-15)

- Providers are server-side singletons (`apikey-fan`, `sogni`, `pollinations`) registered in
  `createRegistry` (`lib/providers/registry.ts`); `isConfigured()` reads `getStudioEnv()`, which
  caches `process.env` once (`APIKEY_FAN_API_KEY`, `SOGNI_API_KEY`; Pollinations is keyless).
- The registry already gates on `isConfigured()`; `resolve()` returning null triggers the existing
  fallback paths (unknown model → registry default; i2v swap target missing → graceful no-swap).
- Prompt enhancement (`lib/services/enhancement.service.ts`) walks a hardcoded engine chain —
  `sogniTextComplete` (model id hardcoded in `sogni.text.ts`) → `pollinationsTextComplete` →
  deterministic fallback — and never fails the user.
- User settings live client-side in localStorage via an external store
  (`lib/repositories/settings.repository.ts`): `uncensoredEnabled`, `imageModel`, `videoModel`.
  `imageModel`/`videoModel` are already the "global default per kind" the Model badge writes.
- `/api/models` serves the merged catalog with `no-store`; the client promise-cache
  (`lib/model-catalog.ts`) is never invalidated — anything provider-related changing server-side
  would not reach open prompt windows without a reload.
- `docs/sogni-api-guide.md` predates the LLM surface: Sogni's chat model list (3 models, verified
  live 2026-09-15: two qwen-35B variants incl. the abliterated one, one deepseek vision) must be
  re-verified live during implementation; the abliterated id
  `qwen3.5-35b-a3b-abliterated-gguf-q4km` is the current hardcoded default.
- `Icon.tsx` has no gear glyph; `sliders` is the established settings-style icon.

## Architecture: server-side runtime config (Approach A)

Provider enablement, API keys, disabled models, and the enhance-model choice are **server
capabilities**, so they live in a gitignored local config file read at request time. A small
repository owns read/validate/write/invalidate; `GET/PUT /api/settings` backs the page. The
registry, env layer, and enhance chain consult the config per request → server-side changes are
instant by construction. The client bumps a catalog version after a successful write so open Model
pills refresh instantly too.

Rejected alternatives: **per-request client prefs** (keys would live in localStorage and travel in
every request body; every API surface must thread prefs; "disabled" only enforced client-side) and
**rewriting `.env.local`** (needs a server restart — fails the instant-apply requirement).

Image/Video task defaults stay **client-side**: they are exactly the existing `imageModel` /
`videoModel` fields; the Settings page just exposes editors for them. Only the enhance model is
server-side, because the engine chain runs there.

---

## 1. Config file & repository

File: `.studio/settings.json` (gitignored; path overridable via `STUDIO_SETTINGS_PATH` for tests).
Absent file or missing fields = defaults, so the file only ever stores deltas:

```json
{
  "version": 1,
  "providers": {
    "apikey-fan":   { "enabled": true, "apiKey": null, "disabledModels": [] },
    "sogni":        { "enabled": true, "apiKey": null, "disabledModels": [] },
    "pollinations": { "enabled": true, "apiKey": null, "disabledModels": [] }
  },
  "tasks": { "enhance": null }
}
```

New server-only `lib/repositories/provider-config.repository.ts` (same layer as the other
repositories, no imports from env.ts or the registry — it reads `process.env.STUDIO_SETTINGS_PATH`
directly, so no dependency cycle):

- `getProviderConfig(): ProviderConfig` — file merged over defaults, cached in module memory.
- `updateProviderConfig(patch): ProviderConfig` — deep-merges the validated patch, persists,
  invalidates its own cache, returns the fresh config. (It does **not** touch the env cache — the
  service layer owns cross-cache invalidation, see §3.)
- A corrupt/unreadable file logs a warning and yields defaults — never crashes the studio.
- Validation (known provider/model ids, ≥1 enabled provider, key shape) lives in the route/service
  layer (§2), keeping the repository dependency-free.

## 2. API surface

`app/api/settings/route.ts` (runtime nodejs), thin over a new
`lib/services/provider-settings.service.ts`:

- **GET** → `{ providers: [{ id, label, enabled, keySource: "settings" | "env" | null, keyMasked:
  "••••abcd" | null, models: [{ id, kind, label, hint, enabled, frameInput }], textModels: [{ id,
  label, enabled }] }], tasks: { enhance: string | null } }`.
  Models listed = picker models ∪ hidden models with frame capability (the ones any picker can
  surface). Pure auto-swap siblings (i2v targets) are not listed — they follow their provider's
  gate automatically. Keys are **never** returned raw: masked last-4 plus source only.
- **PUT** body: `{ providers?: { [id]: { enabled?, apiKey? (string | null; "" means clear),
  disabledModels? } }, tasks?: { enhance?: string | null } }`. Validates ids against the provider
  inventory, rejects disabling the last enabled provider (400, same rule the UI enforces), writes,
  invalidates caches, returns the same shape as GET so the page replaces its mirror with truth.

## 3. API keys & env precedence

`lib/config/env.ts` merges the config over parsed env when exposing keys:
**settings key > env key > null**. Clearing the key in Settings falls back to env automatically;
the UI says which source is active ("Saved in Settings ••••abcd" / "Using environment key
••••abcd" / "Not configured"). After a successful write the service calls a public
`invalidateStudioEnv()` (the existing `resetStudioEnvForTests` stays as an alias), so all six
`getStudioEnv()` call sites pick up the new key on their next call. Raw keys are write-only via
PUT; `SOGNI_APP_ID` and endpoint URLs stay env-only (not user-facing).

## 4. Registry gating

`createRegistry(providers, gate?)` gains an optional gate:

```ts
export interface ProviderGate {
  isEnabled(providerId: string): boolean;
  isModelEnabled(providerId: string, modelId: string): boolean;
}
```

`getGenerationRegistry()` wires a gate reading the config; tests inject fakes (existing pattern);
no gate passed = everything enabled (all current tests unaffected). The gate filters:

- `listModels` / `listAllModels`: provider must be enabled **and** configured; models must pass
  `isModelEnabled`.
- `defaultModel`: first surviving model; none → existing `ProviderError` (unchanged contract).
- `resolve(modelId)`: returns null for a disabled provider/model — which reuses the existing
  fallback behavior end to end (generation falls back to the default model; the i2v auto-swap
  refuses a disabled sibling and degrades gracefully; story end-capable resolution skips it).
- `findAnywhere`: unchanged (ignores the gate) — provider labels and the "unknown vs
  unconfigured" distinction keep working.

## 5. Enhancement engine config

New optional `TextProvider` capability on provider adapters (Interface Segregation, in
`lib/providers/types.ts`):

```ts
export interface TextModelDescriptor { id: string; label: string }
export interface TextProvider {
  listTextModels(): TextModelDescriptor[];
  textComplete(modelId: string, instruction: string, options?: TextCompletionOptions): Promise<string>;
}
```

- `sogni.text.ts`: `textComplete` takes the model id (the current hardcoded abliterated model
  becomes the default); `listTextModels()` returns Sogni's chat models (ids re-verified live during
  implementation; `docs/sogni-api-guide.md` updated with the LLM routes as a side effect).
- `pollinations.text.ts`: `listTextModels()` → one entry ("Pollinations (free tier)");
  `textComplete` keeps the legacy GET endpoint (model id unused).
- `enhancement.service.ts` builds the chain per request from the config: selected task model first
  (when its provider is enabled and the model not disabled), then remaining enabled text engines in
  registry priority order, then the deterministic fallback. The never-fail contract is unchanged;
  with every text engine disabled the result is simply `source: "fallback"`. The reply-cache key
  includes the enhance-model selection so switching models isn't masked by a cached reply.

## 6. Task model selection

- **Image / Video default**: editors in Settings for the existing `settings.imageModel` /
  `settings.videoModel` (dropdown of enabled models from the catalog + a "Workspace default"
  reset to null). No server involvement; disabled models fall back server-side as today.
- **Prompt enhancement**: stored server-side in `tasks.enhance`; dropdown lists "Auto (recommended)"
  plus the text models of enabled providers.

## 7. Settings page UI

`app/settings/page.tsx` + focused section components under `components/settings/`:

- **Layout**: content-page style like `/history` — max-w ~720px column, page scrolls naturally,
  SiteHeader/Footer from the root layout. Title "Settings", subtitle "Studio-wide preferences,
  stored on this device."
- **Sections**, in order:
  1. *Content preferences* — the Uncensored Mode block, moved as-is (ConfirmDialog flow intact).
  2. *Providers* — one card per provider: header row with label, status `Badge` (Active / Needs
     API key / Off) and the master `Toggle`; API-key row (password input + Save + Clear, with the
     source hint from §3); *Models* list — one row per model (label + hint) with a small toggle.
     Disabling the last enabled provider is blocked in the UI (disabled toggle + inline hint, no
     toast) mirroring the server rule.
  3. *Task models* — the three dropdowns from §6.
- **Data flow**: page fetches GET on mount into local state; toggles and selects PUT immediately
  (optimistic, rolled back with an error toast if the PUT fails); the key input applies on Save.
  Every successful PUT replaces the local mirror with the response (source of truth).
- **Chrome**: account-menu "Settings" item becomes a `Link` to `/settings`; a `sliders`-icon header
  button links there too (visible on mobile, where the account menu is hidden); "Settings" joins
  `FOOTER_LINKS`. `SettingsDialog.tsx` is deleted.

## 8. Instant-apply mechanics (client)

`bumpCatalogVersion()` on the client settings external store (module-level counter, not persisted).
`useModelCatalog` subscribes to it and re-runs its effect; `invalidateModelCatalog()` (new export
in `lib/model-catalog.ts`) clears the promise cache so the refetch is real. The Settings page calls
both after each successful PUT → every open Model pill, the Settings dropdowns, and provider status
reflect the change without a reload. Enhance reads the config per request, so the next click already
uses the new engine.

## 9. Error handling & edge cases

- In-flight renders are untouched by settings changes (config is read at request start).
- A stored image/video model id that later gets disabled: server resolve returns null → registry
  default (existing stale-id path). The pill self-corrects on the next catalog refresh.
- Key removed in Settings but present in env → provider stays configured via env (shown in UI).
- All text engines disabled → deterministic enhancement fallback; all providers disabled is
  prevented (UI + server).
- Corrupt config file → defaults + warning log.

## 10. Testing (vitest, service/repository level per existing conventions)

- `provider-config.repository.test.ts`: defaults merge, persist round-trip, corrupt-file
  tolerance, cache invalidation.
- `registry.test.ts` additions: gate filters lists, defaultModel skips disabled, resolve returns
  null for disabled model/provider, findAnywhere unaffected, no-gate default permissive.
- `env.test.ts` additions: settings key wins, clearing falls back to env, invalidation works.
- `enhancement.service.test.ts` additions: disabled provider/model engines skipped, selected model
  first, selection in cache key, all-disabled → fallback.
- `provider-settings.service.test.ts`: GET inventory shape (masked keys, sources), PUT validation
  (unknown ids, last-provider rule, empty-string key clears).

## 11. Out of scope

"Test connection" button for keys, multi-key profiles, remote sync of settings, editing
`SOGNI_APP_ID`/endpoint URLs, per-workspace model overrides beyond the existing badge.

## Rollout note

Implementation happens in a `.worktrees/<branch>` worktree (main tree carries uncommitted
story-continuation work). Touch points avoid the dirty files (`GeneratorScreen.tsx`,
`PromptComposer.tsx`, `lib/store.ts`) — the catalog version lives in the settings repository's
store, and generator screens keep reading models through `useModelCatalog`.

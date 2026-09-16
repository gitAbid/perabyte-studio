# Settings UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-column scrolling `/settings` page with a two-pane shell (sticky section rail + four short sections: General, Providers, Models, Advanced) without changing any data contract.

**Architecture:** Presentation-only. `app/settings/page.tsx` keeps the existing fetch + optimistic-merge + rollback logic and becomes a shell that switches the active section (`?section=` deep link via `history.replaceState`). New/rewritten section components consume the same props as today; model visibility toggles move out of provider cards into a dedicated Models section.

**Tech Stack:** Next.js App Router client components, Tailwind v4 `@theme` tokens (light/dark flips automatically), existing `components/ui` kit (`Toggle`, `Badge`, `Button`, `SelectField`, `ConfirmDialog`, `useToast`), `components/Icon`.

**Spec:** `docs/superpowers/specs/2026-09-16-settings-ui-redesign-design.md`

**Testing note:** No React test infra exists in this repo (all 394 tests are lib-level vitest). Per house pattern, UI is verified by `tsc`/`next build`, full vitest suite, and a browser GUI smoke (light + dark). No new test infra is added (YAGNI).

**Worktree:** All tasks run in `.worktrees/settings-redesign` on branch `feature/settings-ui-redesign`. Before first build there: `cp ../../.env.local .env.local && npm install` (worktrees don't share node_modules or env — see repo memory).

---

### Task 1: Shared section shell + settings nav

**Files:**
- Create: `components/settings/shared.tsx`
- Create: `components/settings/SettingsNav.tsx`

- [ ] **Step 1: Create `components/settings/shared.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";

/** Shared header + container for a settings section pane. */
export function SectionShell({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="animate-fade-up">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
          <Icon name={icon} size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          <p className="text-[12.5px] text-muted">{description}</p>
        </div>
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
```

- [ ] **Step 2: Create `components/settings/SettingsNav.tsx`**

```tsx
"use client";

import { Icon, type IconName } from "@/components/Icon";

const SECTIONS = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "providers", label: "Providers", icon: "chip" },
  { id: "models", label: "Models", icon: "grid" },
  { id: "advanced", label: "Advanced", icon: "clock" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export { SECTIONS };
export type SettingsSectionId = (typeof SECTIONS)[number]["id"];

export function isSettingsSection(value: string | null): value is SettingsSectionId {
  return SECTIONS.some((s) => s.id === value);
}

/** Sticky rail on md+, horizontal chip row on mobile. */
export function SettingsNav({
  section,
  onSelect,
}: {
  section: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="shrink-0 self-start md:sticky md:top-8 md:w-[188px]"
    >
      <div className="flex gap-1.5 overflow-x-auto pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(s.id)}
              className={`flex shrink-0 items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold transition-colors md:w-full ${
                active
                  ? "bg-primary-soft text-primary"
                  : "text-ink-soft hover:bg-surface-2"
              }`}
            >
              <Icon name={s.icon} size={15} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` → expect no errors (files are additions, nothing imports them yet).

- [ ] **Step 4: Commit**

```bash
git add components/settings/shared.tsx components/settings/SettingsNav.tsx
git commit -m "feat(settings): section shell + responsive settings nav"
```

---

### Task 2: AdvancedSection (timeouts, moved verbatim)

**Files:**
- Create: `components/settings/AdvancedSection.tsx`
- Delete (later, Task 7): `components/settings/RenderTimeoutsSection.tsx`

- [ ] **Step 1: Create `components/settings/AdvancedSection.tsx`** — same `TimeoutField` logic as `RenderTimeoutsSection.tsx` (copy verbatim), wrapped in `SectionShell`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { SectionShell } from "@/components/settings/shared";
import type { ProviderSettingsUpdate } from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

const MIN_MINUTES = 0.5;
const MAX_MINUTES = 60;

/** One numeric minutes field that commits on blur/Enter. Local state holds
 * the draft; server truth resyncs only when the draft isn't mid-edit. */
function TimeoutField({
  label,
  hint,
  valueSeconds,
  onCommit,
}: {
  label: string;
  hint: string;
  valueSeconds: number;
  onCommit: (seconds: number) => void;
}) {
  const [minutes, setMinutes] = useState(String(valueSeconds / 60));
  const [committed, setCommitted] = useState(valueSeconds);

  useEffect(() => {
    if (valueSeconds !== committed) {
      setCommitted(valueSeconds);
      setMinutes(String(valueSeconds / 60));
    }
  }, [valueSeconds, committed]);

  function commit() {
    const parsed = Number.parseFloat(minutes.replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setMinutes(String(committed / 60));
      return;
    }
    const clamped = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, parsed));
    const seconds = Math.round(clamped * 60);
    if (seconds === committed) {
      setMinutes(String(committed / 60));
      return;
    }
    setCommitted(seconds);
    setMinutes(String(clamped));
    onCommit(seconds);
  }

  return (
    <label className="flex items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[12px] font-semibold text-ink-soft">{label}</span>
        <span className="block text-[11px] leading-snug text-muted">{hint}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          value={minutes}
          aria-label={label}
          onChange={(event) => setMinutes(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          className="h-8 w-16 rounded-[9px] border border-border-strong bg-raised px-2.5 text-right text-[12.5px] tabular-nums text-ink focus:border-primary focus:outline-none"
        />
        <span className="text-[11.5px] text-muted">min</span>
      </span>
    </label>
  );
}

export function AdvancedSection({
  renderTimeouts,
  onUpdate,
}: {
  renderTimeouts: { image: number; video: number };
  onUpdate: OnUpdate;
}) {
  return (
    <SectionShell
      icon="clock"
      title="Advanced"
      description="Render timeouts"
    >
      <div className="space-y-4 rounded-[14px] border border-border bg-raised p-4">
        <TimeoutField
          label="Image renders"
          hint="How long an image may take before it stops as retryable."
          valueSeconds={renderTimeouts.image}
          onCommit={(seconds) =>
            onUpdate({ renderTimeouts: { image: seconds } }).catch(() => undefined)
          }
        />
        <TimeoutField
          label="Video renders"
          hint="Raise this for long clips — a timed-out job is retried, not lost."
          valueSeconds={renderTimeouts.video}
          onCommit={(seconds) =>
            onUpdate({ renderTimeouts: { video: seconds } }).catch(() => undefined)
          }
        />
        <p className="border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
          Defaults: 5 minutes for images, 10 for videos. Applies to every
          provider; the platform hosting the studio can still cap it lower.
        </p>
      </div>
    </SectionShell>
  );
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add components/settings/AdvancedSection.tsx
git commit -m "feat(settings): Advanced section (timeouts under SectionShell)"
```

---

### Task 3: ProvidersSection rewrite (compact auth-only rows)

Old provider cards inline-listed every model — that list moves to `ModelsSection` (Task 4). This file keeps enable toggle, status badge, min-1-provider lock, and the API-key editor behind an expandable row. Same props as before (`providers`, `onUpdate`), so the old page keeps compiling during the transition.

**Files:**
- Modify (full rewrite): `components/settings/ProvidersSection.tsx`

- [ ] **Step 1: Replace file contents**

```tsx
"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Button, Toggle, useToast } from "@/components/ui";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

function statusOf(provider: ProviderView): {
  label: string;
  tone: "success" | "warning" | "neutral";
} {
  if (!provider.enabled) return { label: "Off", tone: "neutral" };
  return provider.keySource || !provider.keySupported
    ? { label: "Active", tone: "success" }
    : { label: "Needs API key", tone: "warning" };
}

export function ProvidersSection({
  providers,
  onUpdate,
}: {
  providers: ProviderView[];
  onUpdate: OnUpdate;
}) {
  const enabledCount = providers.filter((p) => p.enabled).length;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="divide-y divide-border overflow-hidden rounded-[14px] border border-border bg-raised">
      {providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          lockDisable={provider.enabled && enabledCount <= 1}
          expanded={expanded === provider.id}
          onToggleExpanded={() =>
            setExpanded((cur) => (cur === provider.id ? null : provider.id))
          }
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );
}

function ProviderRow({
  provider,
  lockDisable,
  expanded,
  onToggleExpanded,
  onUpdate,
}: {
  provider: ProviderView;
  lockDisable: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdate: OnUpdate;
}) {
  const status = statusOf(provider);

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} ${provider.label} details`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name="chevron-down"
            size={14}
            className={`shrink-0 text-muted transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <span className="truncate text-[13px] font-bold text-ink">
            {provider.label}
          </span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {!expanded && provider.keyMasked ? (
            <span className="hidden truncate text-[11.5px] text-muted sm:inline">
              {provider.keyMasked}
            </span>
          ) : null}
        </button>
        <ProviderEnableToggle
          provider={provider}
          lockDisable={lockDisable}
          onUpdate={onUpdate}
        />
      </div>
      {lockDisable && !expanded ? (
        <p className="-mt-1 px-4 pb-3 text-[11.5px] text-muted">
          {provider.label} is your only enabled provider.
        </p>
      ) : null}
      {expanded && provider.keySupported ? (
        <KeyEditor provider={provider} onUpdate={onUpdate} />
      ) : null}
    </div>
  );
}

function ProviderEnableToggle({
  provider,
  lockDisable,
  onUpdate,
}: {
  provider: ProviderView;
  lockDisable: boolean;
  onUpdate: OnUpdate;
}) {
  const toast = useToast();
  return (
    <Toggle
      label={`Enable ${provider.label}`}
      checked={provider.enabled}
      disabled={lockDisable}
      onChange={(next) => {
        if (!next && lockDisable) {
          toast.push("Keep at least one provider enabled.");
          return;
        }
        onUpdate({ providers: { [provider.id]: { enabled: next } } }).catch(
          () => undefined,
        );
      }}
    />
  );
}

function KeyEditor({
  provider,
  onUpdate,
}: {
  provider: ProviderView;
  onUpdate: OnUpdate;
}) {
  const [keyDraft, setKeyDraft] = useState("");

  function saveKey() {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setKeyDraft("");
    onUpdate({ providers: { [provider.id]: { apiKey: trimmed } } }).catch(
      () => undefined,
    );
  }

  function clearKey() {
    setKeyDraft("");
    onUpdate({ providers: { [provider.id]: { apiKey: null } } }).catch(
      () => undefined,
    );
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <p className="text-[11.5px] text-muted">
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
          className="h-9 w-full rounded-[10px] border border-border-strong bg-raised px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
        <Button size="sm" onClick={saveKey} disabled={!keyDraft.trim()}>
          Save
        </Button>
        {provider.keySource === "settings" ? (
          <Button variant="secondary" size="sm" onClick={clearKey}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean (props unchanged, old page still compiles).

- [ ] **Step 3: Commit**

```bash
git add components/settings/ProvidersSection.tsx
git commit -m "feat(settings): compact provider rows with expandable key editor"
```

---

### Task 4: ModelsSection (grouped model visibility pills)

Model visibility moves here from provider cards. Same payload contract: every toggle/bulk action sends the provider's FULL next `disabledModels` list (image + video + text share one list — see the old `toggleModel` doc comment).

**Files:**
- Create: `components/settings/ModelsSection.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";
import type { SectionShell } from "@/components/settings/shared";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

type ProviderModel = ProviderView["models"][number];

export function ModelsSection({
  providers,
  onUpdate,
}: {
  providers: ProviderView[];
  onUpdate: OnUpdate;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Icon
          name="search"
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models…"
          aria-label="Filter models"
          className="h-10 w-full rounded-[12px] border border-border-strong bg-raised pl-9 pr-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
      </label>
      {providers.map((provider) => (
        <ProviderModelGroup
          key={provider.id}
          provider={provider}
          filter={query}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );
}

function ProviderModelGroup({
  provider,
  filter,
  onUpdate,
}: {
  provider: ProviderView;
  filter: string;
  onUpdate: OnUpdate;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const all = [...provider.models, ...provider.textModels];
  const onCount = all.filter((m) => m.enabled).length;
  const matches = (list: ProviderModel[]) =>
    filter
      ? list.filter((m) =>
          `${m.label} ${m.hint ?? ""}`.toLowerCase().includes(filter),
        )
      : list;
  const shownModels = matches(provider.models);
  const shownText = matches(provider.textModels);
  if (filter && !shownModels.length && !shownText.length) return null;

  function setAll(nextOn: boolean) {
    const nextDisabled = nextOn ? [] : all.map((m) => m.id);
    onUpdate({
      providers: { [provider.id]: { disabledModels: nextDisabled } },
    }).catch(() => undefined);
  }

  return (
    <div className="rounded-[14px] border border-border bg-raised">
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${provider.label} models`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon
            name="chevron-down"
            size={14}
            className={`shrink-0 text-muted transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          <span className="truncate text-[13px] font-bold text-ink">
            {provider.label}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted">
            {onCount} of {all.length} on
          </span>
        </button>
        <Button variant="text" size="sm" onClick={() => setAll(true)}>
          All on
        </Button>
        <Button variant="text" size="sm" onClick={() => setAll(false)}>
          All off
        </Button>
      </div>
      {!collapsed ? (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {shownModels.length ? (
            <ModelPillGrid
              label={provider.textModels.length ? "Image & video" : undefined}
              models={shownModels}
              provider={provider}
              onUpdate={onUpdate}
            />
          ) : null}
          {shownText.length ? (
            <ModelPillGrid
              label="Text"
              models={shownText}
              provider={provider}
              onUpdate={onUpdate}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ModelPillGrid({
  label,
  models,
  provider,
  onUpdate,
}: {
  label?: string;
  models: ProviderModel[];
  provider: ProviderView;
  onUpdate: OnUpdate;
}) {
  return (
    <div>
      {label ? (
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted">
          {label}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {models.map((model) => (
          <ModelPill
            key={model.id}
            model={model}
            provider={provider}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </div>
  );
}

/** Disabled-model updates must send the full next disabled list for the
 * provider — image, video, and text models share one list. */
function toggleModel(
  provider: ProviderView,
  modelId: string,
  onUpdate: OnUpdate,
) {
  const currentlyDisabled = provider.models
    .filter((m) => !m.enabled)
    .map((m) => m.id)
    .concat(provider.textModels.filter((m) => !m.enabled).map((m) => m.id));
  const target = provider.models.some((m) => m.id === modelId)
    ? provider.models.find((m) => m.id === modelId)!.enabled
    : provider.textModels.find((m) => m.id === modelId)!.enabled;
  const nextDisabled = target
    ? [...currentlyDisabled, modelId]
    : currentlyDisabled.filter((id) => id !== modelId);
  onUpdate({
    providers: { [provider.id]: { disabledModels: nextDisabled } },
  }).catch(() => undefined);
}

function ModelPill({
  model,
  provider,
  onUpdate,
}: {
  model: ProviderModel;
  provider: ProviderView;
  onUpdate: OnUpdate;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={model.enabled}
      aria-label={`${model.enabled ? "Hide" : "Show"} ${model.label} in model pickers`}
      title={model.hint ?? model.label}
      onClick={() => toggleModel(provider, model.id, onUpdate)}
      className={`flex min-w-0 items-center gap-2 rounded-[10px] border px-3 py-2 text-left transition-colors ${
        model.enabled
          ? "border-primary bg-primary-soft text-primary"
          : "border-border bg-surface text-ink-soft hover:border-border-strong"
      }`}
    >
      <span
        className={`grid size-4 shrink-0 place-items-center rounded-full border ${
          model.enabled
            ? "border-primary bg-primary text-white"
            : "border-border-strong"
        }`}
      >
        {model.enabled ? <Icon name="check" size={10} /> : null}
      </span>
      <span className="truncate text-[12.5px] font-medium">{model.label}</span>
    </button>
  );
}
```

Note: remove the stray `import type { SectionShell }` if unused — the section pane wrapper in the page provides the shell; this file only needs the types imported above. (Adjust during implementation: keep imports minimal and `tsc` clean.)

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add components/settings/ModelsSection.tsx
git commit -m "feat(settings): grouped model-visibility pills with filter and bulk toggles"
```

---

### Task 5: GeneralSection (content prefs + task models)

Absorbs `ContentPreferencesSection` (verbatim logic: confirm dialog, toasts, store writes) and `TaskModelsSection` (verbatim logic: catalog selects, enhance options). The warning banner drops its literal `bg-[#fffbeb]` for tokenized `bg-warning/10` so dark mode renders correctly.

**Files:**
- Create: `components/settings/GeneralSection.tsx`
- Delete (Task 7): `components/settings/ContentPreferencesSection.tsx`, `components/settings/TaskModelsSection.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog, SelectField, Toggle, useToast } from "@/components/ui";
import { useModelCatalog } from "@/lib/model-catalog";
import {
  setMaskUncensored,
  setSelectedModel,
  setUncensoredEnabled,
  useSettings,
} from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";
import { SectionShell } from "@/components/settings/shared";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export function GeneralSection({
  providers,
  enhanceModel,
  onUpdate,
}: {
  providers: ProviderView[];
  enhanceModel: string | null;
  onUpdate: OnUpdate;
}) {
  return (
    <SectionShell
      icon="sliders"
      title="General"
      description="Content preferences and default models"
    >
      <ContentPreferencesCard />
      <TaskModelsCard
        providers={providers}
        enhanceModel={enhanceModel}
        onUpdate={onUpdate}
      />
    </SectionShell>
  );
}

function ContentPreferencesCard() {
  const toast = useToast();
  const { settings } = useSettings();
  const [confirmUncensored, setConfirmUncensored] = useState(false);

  return (
    <div className="rounded-[14px] border border-border bg-raised p-4">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        Content
      </p>
      <div className="mt-3">
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
          <p className="mt-3 flex items-start gap-1.5 rounded-[10px] bg-warning/10 px-2.5 py-2 text-[12px] font-medium text-warning">
            <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
            Uncensored Mode is on. All content is intended for adults (18+) only.
          </p>
        ) : (
          <p className="mt-3 text-[11.5px] leading-snug text-muted">
            Enabling requires confirming you are 18+ and accept adult-content
            generation.
          </p>
        )}
      </div>
      <div className="mt-4 border-t border-border pt-4">
        <Toggle
          label="Mask 18+ content"
          description="Blur uncensored (18+) images and videos in your library, previews and results until you choose to show each one. On by default."
          checked={settings.maskUncensored}
          onChange={(next) => {
            setMaskUncensored(next);
            toast.push(
              next
                ? "18+ content is masked again."
                : "Masking off — uncensored renders now show directly.",
            );
          }}
        />
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
    </div>
  );
}

function TaskModelsCard({
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
        .map((model) => ({
          id: model.id,
          label: `${provider.label} — ${model.label}`,
        })),
    );

  return (
    <div className="rounded-[14px] border border-border bg-raised p-4">
      <p className="text-[12px] font-bold uppercase tracking-wide text-muted">
        Default models
      </p>
      {ready ? (
        <div className="mt-3 space-y-4">
          <SelectField
            label="Default image model"
            value={settings.imageModel ?? ""}
            onChange={(event) =>
              setSelectedModel("image", event.target.value || null)
            }
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
            onChange={(event) =>
              setSelectedModel("video", event.target.value || null)
            }
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
              onUpdate({ tasks: { enhance: event.target.value || null } }).catch(
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

          <p className="border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
            Per-workspace choices made with the Model badge in each prompt
            window override these defaults.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-muted">Loading models…</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add components/settings/GeneralSection.tsx
git commit -m "feat(settings): General section (content prefs + default models)"
```

---

### Task 6: Page shell rewrite

**Files:**
- Modify (full rewrite): `app/settings/page.tsx`

- [ ] **Step 1: Replace file contents** — fetch/optimistic-merge logic unchanged from current page; new nav + section switching:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { AdvancedSection } from "@/components/settings/AdvancedSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ModelsSection } from "@/components/settings/ModelsSection";
import { ProvidersSection } from "@/components/settings/ProvidersSection";
import {
  isSettingsSection,
  SettingsNav,
  type SettingsSectionId,
} from "@/components/settings/SettingsNav";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/ui";
import { invalidateModelCatalog } from "@/lib/model-catalog";
import { bumpCatalogVersion } from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsPayload,
  ProviderSettingsUpdate,
} from "@/lib/services/provider-settings.service";

export default function SettingsPage() {
  const toast = useToast();
  const [section, setSection] = useState<SettingsSectionId>("general");
  const [data, setData] = useState<ProviderSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Read the deep link after mount — avoids SSR/hydration mismatch.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("section");
    if (isSettingsSection(value)) setSection(value);
  }, []);

  const onSection = useCallback((next: SettingsSectionId) => {
    setSection(next);
    window.history.replaceState(null, "", `/settings?section=${next}`);
    window.scrollTo({ top: 0 });
  }, []);

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
        if (active) {
          setLoadError(
            "Could not load provider settings. Is the studio server running?",
          );
        }
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
        const payload = (await response.json()) as ProviderSettingsPayload & {
          error?: string;
        };
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
    <div className="mx-auto flex w-full max-w-[980px] flex-1 gap-8 px-4 py-8 sm:px-6">
      <SettingsNav section={section} onSelect={onSection} />
      <div className="min-w-0 flex-1">
        <header>
          <h1 className="text-lg font-bold text-ink">Settings</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
            <span>Studio-wide preferences, stored on this device.</span>
            <span className="inline-flex items-center gap-1 text-[12px]">
              <Icon name="check" size={12} className="text-success" />
              Changes save automatically.
            </span>
          </p>
        </header>

        <div className="mt-6 pb-10">
          {loadError ? (
            <p className="text-[13px] font-medium text-danger">{loadError}</p>
          ) : null}

          {section === "general" ? (
            <GeneralSection
              providers={data?.providers ?? []}
              enhanceModel={data?.tasks.enhance ?? null}
              onUpdate={onUpdate}
            />
          ) : null}

          {section !== "general" && !loadError ? (
            !data ? (
              <p className="text-[13px] text-muted">Loading settings…</p>
            ) : section === "providers" ? (
              <ProvidersSection providers={data.providers} onUpdate={onUpdate} />
            ) : section === "models" ? (
              <ModelsSection providers={data.providers} onUpdate={onUpdate} />
            ) : (
              <AdvancedSection
                renderTimeouts={data.renderTimeouts}
                onUpdate={onUpdate}
              />
            )
          ) : null}
        </div>
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
    tasks:
      patch.tasks?.enhance !== undefined
        ? { enhance: patch.tasks.enhance }
        : current.tasks,
    renderTimeouts: patch.renderTimeouts
      ? { ...current.renderTimeouts, ...patch.renderTimeouts }
      : current.renderTimeouts,
  };
}
```

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add app/settings/page.tsx
git commit -m "feat(settings): two-pane shell with section nav and deep links"
```

---

### Task 7: Remove replaced files + full verify

**Files:**
- Delete: `components/settings/ContentPreferencesSection.tsx`
- Delete: `components/settings/TaskModelsSection.tsx`
- Delete: `components/settings/RenderTimeoutsSection.tsx`

- [ ] **Step 1: Confirm no other importers** — `grep -rn "ContentPreferencesSection\|TaskModelsSection\|RenderTimeoutsSection" app components lib | grep -v node_modules` → expect no hits outside the deleted files themselves.
- [ ] **Step 2: Delete the three files** (`git rm`).
- [ ] **Step 3: Typecheck + full suite + build** — `npx tsc --noEmit && npm test && npm run build` → all green.
- [ ] **Step 4: Browser GUI smoke (light + dark)** against a dev server started in the worktree (port 3210):
  - Nav rail switches all four sections; mobile-width chips row works; `?section=models` deep link opens Models.
  - Providers: last-provider disable shows lock toast; expand row → key editor; masked key caption.
  - Models: toggle a pill → network PUT body carries FULL `disabledModels` list; "All off"/"All on" send complete lists; filter narrows; counts update.
  - General: uncensored confirm dialog flow; Mask 18+ toast; task-model selects populate.
  - Advanced: timeout commit + clamp (enter 0.2 → 0.5).
  - Dark mode: no unflipped white surfaces; warning banner legible in dark.
- [ ] **Step 5: Commit**

```bash
git rm components/settings/ContentPreferencesSection.tsx components/settings/TaskModelsSection.tsx components/settings/RenderTimeoutsSection.tsx
git commit -m "chore(settings): remove replaced single-column sections"
```

---

### Task 8: Finish branch

- Merge `feature/settings-ui-redesign` into `master` (house pattern: `git merge --no-ff`), delete the branch, remove the worktree.
- Update memory file `settings-redesign-branch.md` with outcome + gotchas.

# Workspaces, World Bible & Production Recipes

**Requirement family:** FR-21 + product improvements  
**Creator Alpha:** Required

---

## 1. Purpose

A Workspace is the isolation boundary and reusable creative universe for a series, channel, project family, or recurring world.

---

## 2. Goals

- Isolate generation context.
- Select reusable characters/environments/styles.
- Provide a visible World Bible.
- Provide reusable Production Recipes.
- Snapshot canon into each new production.
- Allow workspace-local variants without mutating global canon.

---

## 3. Non-goals

- Multi-user permissions in v1.
- Collaboration/presence.
- Automatic propagation of workspace changes into historical productions.
- Hidden use of global assets.

---

## 4. Routes / entry points

- `/workspaces`
- `/workspaces/new`
- `/workspaces/[id]`
- `/workspaces/[id]/world`
- `/workspaces/[id]/assets`
- `/workspaces/[id]/recipe`

---

## 5. Primary UI/UX flow

```text
Create Workspace
  ↓
Name + format + language + rating
  ↓
Select Characters
  ↓
Select Environments
  ↓
Choose / create style
  ↓
Optional World Bible
  ↓
Production Recipe
  ↓
Workspace Home
  ↓
Create Production → snapshot current canon
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Milo & Luna                              [Create Episode]│
├──────────────────────────────────────────────────────┤
│ Cast        Environments        Style                 │
│ [Milo]      [Forest]            [3D Storybook]       │
│ [Luna]      [House]                                  │
├──────────────────────────────────────────────────────┤
│ World Bible                      Production Recipe    │
│ 12 rules                         Kids Cartoon         │
├──────────────────────────────────────────────────────┤
│ Productions                                          │
│ [Dragon Trouble — First Cut Ready]                   │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes and owns the `Workspace` aggregate.

World Bible:
```ts
interface WorldBible {
  rules: { id: string; text: string; category?: string }[];
  tone?: string;
  recurringObjects?: string[];
  pronunciation?: Record<string,string>;
  avoid?: string[];
}
```

Production Recipe:
```ts
interface ProductionRecipe {
  id: string;
  name: string;
  aspect: string;
  targetDuration?: string;
  shotDurationRange?: [number, number];
  narrationLevel?: "low"|"medium"|"high";
  cameraEnergy?: "gentle"|"balanced"|"energetic";
  qualityStrategy: "economy"|"balanced"|"best";
}
```

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Removing an asset affects only future generation.
- Historical productions retain snapshot refs.
- Global browsing is explicit and logged.
- Workspace-local variant displays `Local to this workspace`.
- Adult workspaces must clearly explain export-only publishing policy.
- Missing/deleted global source does not invalidate pinned production snapshot refs.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- workspace CRUD
- workspace asset membership
- world-bible versioning
- production-recipe versioning
- workspace-local canon fork
- production snapshot creation
- isolation validator

Critical test helper:
`assertResolvedRefsWithinWorkspace(job)`

---

## 10. Acceptance tests

1. Random generation jobs never contain unrelated global references.
2. Removing a character from Workspace does not alter an existing Production snapshot.
3. Workspace-local variant does not replace global canon.
4. `Save to Global Library` creates a new global revision.
5. Production creation snapshots the exact selected canon revisions.
6. World Bible rules are available to story and prompt composers through one shared resolver.

---

## 11. Parallel subagent plan

**Agent A — Workspace data/domain**
- entity + migration
- membership APIs
- snapshot service
- isolation tests

**Agent B — Workspace UI**
- create/edit/home
- asset selection
- local/global distinction

**Agent C — World Bible**
- editor
- versioning
- semantic categories
- read projection

**Agent D — Production Recipe**
- presets
- editor
- recipe inheritance
- quality strategy link

**Integrator**
- owns schema migration sequencing
- freezes resolver API before downstream agents consume it

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Blocks:
- dependable Auto Mode
- production creation
- isolation-sensitive generation

Can run in parallel with Studio Home UI and shared Canon UI once schema is frozen.

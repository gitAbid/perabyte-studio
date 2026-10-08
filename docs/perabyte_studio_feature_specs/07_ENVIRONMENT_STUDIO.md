# Environment Studio

**Requirement family:** FR-23  
**Creator Alpha:** Required

---

## 1. Purpose

Create reusable visual locations with stable identity, structured lighting/state, and derived views.

---

## 2. Goals

- Generate 3–4 environment variants.
- Select and refine one environment identity.
- Generate canonical supporting views.
- Represent zones, lighting, weather, and persistent props structurally.
- Reuse the same variant/refinement system as Character Studio.

---

## 3. Non-goals

- Full spatial 3D reconstruction.
- Procedural world simulation.
- Hidden environment injection outside workspace scope.

---

## 4. Routes / entry points

- `/environments` preferred UI route/label
- legacy `/locations` may redirect or remain internal
- `/environments/new`
- `/environments/[id]`

---

## 5. Primary UI/UX flow

```text
Describe Environment
  ↓
Generate 3–4 plates
  ↓
Compare + Select
  ↓
Refine lighting/layout/mood/props
  ↓
Approve Main Canon
  ↓
Generate optional derived views
  ↓
Review / re-roll individual views
  ↓
Lock supporting set
  ↓
Add to Workspace
```

---

## 6. Primary screen format

```text
┌───────────────────────────────┬──────────────────────┐
│ Dragon Cave                   │ Refine               │
│ [Main approved preview]       │ [Lighting] [Weather] │
│                               │ [Time] [Props]       │
│ Views                         │ [Layout] [Mood]       │
│ [Wide] [Entrance] [Detail]    │                      │
│ [Day] [Sunset] [Night]        │ Change something...  │
├───────────────────────────────┴──────────────────────┤
│ Zones: Entrance · Chamber · Tunnel       [Approve]   │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Environment Canon may include:
- main reference
- derived views
- zones
- lighting states
- time-of-day states
- weather states
- palette
- persistent props
- layout notes

Scene-specific values use `EnvironmentState`.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Main plate can be approved before all derived views finish.
- Derived view failures do not invalidate approved main canon.
- Each supporting view is independently retryable.
- Structured state controls must be available even when prompt text exists.
- Old `Places` records migrate without losing uploaded reference plates.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- generate plate variants
- identity-aware refine
- generate supporting views
- approve environment canon
- migrate legacy LocationRow
- resolve environment state for scene composer

---

## 10. Acceptance tests

1. Main approved plate remains stable while generating day/night variants.
2. Re-rolling a single supporting view does not regenerate other views.
3. Lighting/weather are stored as structured attributes.
4. Legacy uploaded environment plate remains usable after relabel/migration.
5. Workspace isolation applies identically to characters and environments.

---

## 11. Parallel subagent plan

**Agent A — Environment screens**
- list/create/profile
- variant selection
- structured fields

**Agent B — Derived views**
- gallery
- per-view re-roll
- state/lock UI

**Agent C — Legacy migration**
- Places → Environments
- LocationRow conversion
- route compatibility

**Agent D — Generation adapter**
- reuse generic refine engine
- environment ref composition

**Integrator**
- ensures shared variant components are not forked from Character implementation

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Shared Canon + Workspace contracts.
Generic variant/refine primitives should be extracted before both Character and Environment feature branches diverge.

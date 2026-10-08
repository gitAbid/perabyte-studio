# Character Studio

**Requirement family:** FR-22 + Character State improvements  
**Creator Alpha:** Required

---

## 1. Purpose

Create reusable character canon through a visual, identity-preserving workflow instead of prompt management.

---

## 2. Goals

- Generate 3–4 character-sheet variants.
- Compare/select/refine a chosen identity.
- Preserve face/body identity through edits.
- Maintain immutable versions.
- Bind optional voice canon.
- Define structured appearance defaults.
- Support workspace-local forks.

---

## 3. Non-goals

- Full 3D rigging.
- Lip sync.
- Freeform model configuration in primary UI.
- Silent mutation of approved canon.

---

## 4. Routes / entry points

- `/character`
- `/character/new`
- `/character/[id]`
- `/character/[id]/edit`

---

## 5. Primary UI/UX flow

```text
Describe Character
  ↓
Generate 3–4 full-sheet variants
  ↓
Compare
  ↓
Use This Character
  ↓
Refine selected identity
  ↓
Generate supporting views / expressions
  ↓
Approve Canon
  ↓
Optional voice binding
  ↓
Use globally or add to Workspace
```

---

## 6. Primary screen format

```text
┌───────────────────────────────┬──────────────────────┐
│ Character Preview             │ Refine               │
│                               │ [Outfit] [Hair]       │
│  front / side / back          │ [Color] [Expression] │
│  face + eye panels            │ [Accessory] [Age]    │
│                               │                      │
│ V1  V2  V3                    │ Change something...  │
│                               │ [Generate Change]    │
├───────────────────────────────┴──────────────────────┤
│ [More Like This] [Compare]              [Approve]    │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Character canon attributes should include structured fields for:
- identity references
- body proportions
- hair
- eye color
- default outfit
- accessories
- age presentation
- personality tags
- voice binding

Temporary production appearance belongs to `CharacterState`, not Canon mutation.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Variant generation may fail independently; successful variants remain selectable.
- Refinement always shows the source version.
- If an edit model cannot support required refs, UI explains degraded identity confidence before spend.
- Approval creates a new immutable Canon revision.
- Restore never destroys newer revisions.
- `Identity details` stays collapsed by default.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- generate character variants
- identity-aware refine
- supporting-view generation
- version list
- approve canon revision
- workspace-local fork
- voice binding

Generation composer must place identity front reference first and trim remaining refs to provider limits.

---

## 10. Acceptance tests

1. Jacket-only refinement preserves approved face identity in request references.
2. Approving V3 leaves V1/V2 addressable.
3. `More Like This` uses selected image as lead reference.
4. `Try Again` reuses exact params.
5. Global character is not automatically available inside an unrelated workspace.
6. Primary UI contains no model/seed/provider terminology.
7. Character state changes in a production do not mutate character canon.

---

## 11. Parallel subagent plan

**Agent A — Variant UX**
- create flow
- candidate grid
- compare/favorite/select

**Agent B — Refine UX**
- quick-change chips
- natural-language delta
- lock controls

**Agent C — Canon/version service**
- immutable revision handling
- approval
- lineage
- restore

**Agent D — Identity generation adapter**
- reference ordering
- provider-cap trimming
- provenance

**Integrator**
- owns Character DTO and approved-canon route
- runs identity/refinement integration tests

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires shared Canon contract and generation job contract.

Can be developed in parallel with Environment Studio because both should consume the same generic variant/refine primitives rather than duplicate them.

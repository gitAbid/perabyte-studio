# Library, Canon Lineage & Retention

**Requirement family:** FR-33 + FR-37  
**Creator Alpha:** Basic discovery required; advanced retention later

---

## 1. Purpose

Make reusable creative objects easy to discover while keeping generated media separate conceptually and preserving lineage/reproducibility.

---

## 2. Goals

- Separate Creative Library and Media Library in UI.
- Show Canon badges and lineage.
- Support favorites/tags/search.
- Keep thumbnails lightweight.
- Provide safe retention/pruning.
- Never make library presence equivalent to generation scope.

---

## 3. Non-goals

- Automatically adding assets to active workspace.
- Loading originals in gallery grids.
- Destructive pruning of pinned production dependencies.

---

## 4. Routes / entry points

- `/library`
- `/character`
- `/environments`
- `/images`
- `/videos`
- `/audio`
- `/stories`
- `/productions`

---

## 5. Primary UI/UX flow

```text
Open Library
  ↓
Choose Creative or Media
  ↓
Filter/search
  ↓
Open asset
  ↓
See lineage / usages
  ↓
Add explicitly to Workspace OR reuse
  ↓
Optional storage management
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Library                                              │
│ [Creative] [Media]                                   │
├──────────────────────────────────────────────────────┤
│ Creative                                             │
│ Characters · Environments · Voices · Styles          │
│ [Milo ✓ Canon] [Luna ✓ Canon] [Dragon Cave ✓ Canon] │
├──────────────────────────────────────────────────────┤
│ Media                                                │
│ Images · Videos · Audio · Exports                    │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- Asset
- CanonRevision
- generation lineage
- production snapshot pins

Retention default:
- selected/approved Take retained
- last 3 recent Takes retained
- pinned dependencies never pruned silently

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Prune action shows reclaimable size and protected items.
- Missing thumbnail regenerates without touching original.
- Asset used in production displays usage count.
- Global asset requires explicit `Add to Workspace`.
- Storage failure does not mutate canon metadata.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- asset indexing
- thumbnail generation
- lineage queries
- usage queries
- safe prune planner/executor
- library search/filter

---

## 10. Acceptance tests

1. Global library asset never enters generation context solely because it exists.
2. Approved canon displays lineage and immutable revision.
3. Pruner cannot remove a production-pinned asset.
4. Galleries use thumbnails.
5. User can trace generated output back to canon revisions.

---

## 11. Parallel subagent plan

**Agent A — Library UX**
- navigation
- filters
- cards

**Agent B — lineage/usage**
- queries
- detail panels

**Agent C — thumbnails**
- ingest
- cache
- repair

**Agent D — retention/storage**
- size report
- prune planner
- protection rules

**Integrator**
- verifies library selection and workspace membership remain distinct APIs

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Consumes Workspace membership but must not own it.

Can run mostly in parallel with other feature development after Asset/Canon read models are stable.

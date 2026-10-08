# Storyboard & Shots

**Requirement family:** FR-24  
**Creator Alpha:** Required

---

## 1. Purpose

Make the storyboard the primary visual planning surface for a production while keeping professional shot control progressively disclosed.

---

## 2. Goals

- Ordered visual Scene cards.
- Scene action/dialogue/camera/duration editing.
- Explicit Scene → Shot hierarchy.
- Anchor-first workflow.
- Drag reorder through a new plan revision.
- Stale dependency indicators.
- Optional continuation from previous scene.

---

## 3. Non-goals

- Traditional freeform NLE.
- Mandatory shot-level editing for beginners.
- Silent chaining of scenes by previous video frame.

---

## 4. Routes / entry points

- `/production/[projectId]/storyboard`
- scene detail drawer/modal
- optional expanded shot list

---

## 5. Primary UI/UX flow

```text
Approved Story
  ↓
Generate Shot Plan
  ↓
Generate Storyboard Anchors
  ↓
Review Scene cards
  ↓
Edit / reorder / regenerate
  ↓
Approve anchors
  ↓
Generate Takes / Animate
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Storyboard                           [Generate Missing]│
├──────────────────────────────────────────────────────┤
│ [Scene 01 image]  Forest Picnic         ✓ Approved   │
│ Milo · Luna · Forest · 7s                           │
│ Shots (2) ▾                                         │
├──────────────────────────────────────────────────────┤
│ [Scene 02 image]  Strange Footprints    ⚠ Stale      │
│ Milo · Luna · Riverbank · 8s                        │
│ [Re-anchor]                                          │
├──────────────────────────────────────────────────────┤
│ Batch estimate: $1.40–$1.90       [Animate Approved] │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- `Scene`
- `Shot`
- `AnimaticRevision`
- `AnchorCandidate`
- approval state
- dependency issue projection

Shot creation belongs to shot-plan/domain services, not a local UI-only model.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Story change → affected cards `Stale — re-anchor`.
- Anchor failure keeps previous approved anchor.
- Reorder creates new plan revision and invalidates only affected dependent approvals.
- `Continue movement from previous` is OFF by default.
- Scenes without video remain valid storyboard entries.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- create/update shot plan
- create animatic timings
- generate anchor candidate
- approve anchor
- reorder scene plan
- report dependency issues
- estimate anchor batch cost

---

## 10. Acceptance tests

1. Scene reorder produces a new plan revision.
2. `Continue movement` pins predecessor end frame only when explicitly enabled.
3. Storyboard remains navigable with partial anchor failures.
4. Stale scenes identify dependency reason but primary UI shows one calm badge.
5. Batch generation cannot start without cost estimate when quote data is available.
6. Beginner can complete storyboard without expanding Shots.

---

## 11. Parallel subagent plan

**Agent A — Board UI**
- scene cards
- reorder
- responsive board

**Agent B — Scene inspector**
- story/action/dialogue/camera/duration
- shot disclosure

**Agent C — Anchors**
- candidate UI
- approval
- batch generation

**Agent D — dependency/stale projection**
- read model
- invalidation badges
- re-anchor action

**Integrator**
- owns plan-revision mutation boundary and drag/drop persistence

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires approved StoryRevision and shared production scheduler.

Can proceed in parallel with Takes UI after Shot/Anchor API shapes are frozen.

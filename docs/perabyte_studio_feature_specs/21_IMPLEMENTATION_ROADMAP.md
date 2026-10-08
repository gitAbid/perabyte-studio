# Implementation Roadmap

This roadmap preserves the underlying technical dependency order while optimizing for a usable vertical product as early as possible.

---

## Milestone 0 — Shared Foundation

### Deliverables

- Shared domain contracts
- Workspace isolation resolver
- Canon revision service
- unified job scheduler interface
- approval model
- generic generation UI primitives
- budget estimate envelope
- manifest mutation interface
- design-system primitives

### Exit criteria

- Contract tests pass.
- Two independent mock feature clients can consume shared interfaces.
- No feature-specific provider logic leaks into shared DTOs.

---

## Milestone 1 — CREATE

### Parallel lanes

- Studio Home
- Workspace
- Character Studio
- Environment Studio
- Library base
- Story Studio

### Integration sequence

```text
Workspace
  ├─ Character membership
  ├─ Environment membership
  └─ World Bible
        ↓
     Production
        ↓
      Story
```

### Exit criteria

A creator can:

1. Create Workspace.
2. Create/select Character.
3. Create/select Environment.
4. Create Production.
5. Generate/revise/approve Story.

---

## Milestone 2 — STORYBOARD

### Parallel lanes

- Shot plan service
- Storyboard UI
- Anchor generation
- structured continuity
- cost preflight UI

### Exit criteria

A creator can:

1. Turn approved Story into Storyboard.
2. Review/edit/reorder Scenes.
3. Generate/approve Anchors.
4. See stale dependency signals.
5. Avoid manually composing prompts.

---

## Milestone 3 — CREATOR ALPHA / PRODUCE

### Parallel lanes

- Takes
- assembly worker
- First Cut
- audio import
- basic export
- failure isolation

### Exit criteria

Golden path produces a **60–180 second MP4**.

```text
Workspace
→ Canon
→ Story
→ Storyboard
→ Anchors
→ Takes
→ First Cut
→ MP4
```

Additional gates:

- unrelated workspace assets never leak into jobs
- failed scene can degrade without blocking full cut
- no auto-approvals
- retry semantics are deterministic
- cost is visible before batch generation

---

## Milestone 4 — Production Quality

### Parallel lanes

- continuity report
- character state propagation
- environment state refinement
- audio mix
- advanced manifest view
- export package
- product metrics

### Exit criteria

Repeat productions show measurable improvement in:

- identity acceptance
- environment acceptance
- generation waste
- cost/minute
- review time

---

## Milestone 5 — AUTOMATE

### Parallel lanes

- Auto Draft
- run monitoring/recovery
- guided review queue
- TTS adapter
- generated audio adapter when available
- publish metadata

### Exit criteria

One-sentence production flow reaches First Cut with no manual generation prompt writing.

---

## Milestone 6 — PUBLISH / EXPAND

### Parallel lanes

- YouTube OAuth
- derivative outputs
- advanced export presets
- Music Video Mode
- additional providers
- hosted/SaaS boundary exploration

### Exit criteria

Only promote platform/API integrations after core production completion is reliable.

---

## Parallel dependency map

```text
                    ┌─ Character ─┐
Shared Contracts ───┼─ Environment├──→ Workspace Snapshot
                    └─ Workspace ─┘          │
                                             ▼
                                         Story Studio
                                             │
                                             ▼
                                         Storyboard
                                        ┌────┴─────┐
                                        ▼          ▼
                                   Continuity     Cost
                                        │          │
                                        └────┬─────┘
                                             ▼
                                            Takes
                                        ┌────┴─────┐
                                        ▼          ▼
                                      Audio     Assembly
                                        └────┬─────┘
                                             ▼
                                         First Cut
                                        ┌────┴─────┐
                                        ▼          ▼
                                      Export     Auto Mode
```

---

## Rule for reducing dev time safely

**Parallelize implementation, serialize contracts.**

The contract must exist before dependent agents start, but UI, adapter, QA, and feature-local implementation can proceed in parallel against that frozen interface.

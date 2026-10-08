# Scene Generation & Takes

**Requirement family:** FR-25  
**Creator Alpha:** Required

---

## 1. Purpose

Animate approved shots through recoverable generated Takes while keeping prompt composition invisible to the creator.

---

## 2. Goals

- Canon-aware generation composition.
- Take history per Shot.
- Recommended take + user selection.
- Exact retry semantics.
- Natural-language direction notes.
- Batch animation with cost preflight.
- Partial-cut degradation when video is missing.

---

## 3. Non-goals

- User-written provider prompts in normal flow.
- Deleting previous takes on regeneration.
- Silent randomization on retry.

---

## 4. Routes / entry points

- embedded in Storyboard scene/shot inspector
- `/production/[projectId]/first-cut` may deep-link to a Shot's Takes

---

## 5. Primary UI/UX flow

```text
Approved Anchor
  ↓
Generate Take
  ↓
Take strip shows progress/result
  ↓
AI may Recommend
  ↓
User selects / approves
  ↓
Need change?
 ├─ Try Again
 ├─ Different Take
 └─ Change Something
  ↓
First Cut uses selected approved Take
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Shot 03B — Luna close-up                             │
│ [selected video preview]                             │
├──────────────────────────────────────────────────────┤
│ Take 1   Take 2   Take 3 ★ Recommended              │
│                    [Use This Take]                   │
├──────────────────────────────────────────────────────┤
│ Ask for a change:                                   │
│ "Make Luna step closer and look nervous."           │
│ [Apply as New Take]                                 │
├──────────────────────────────────────────────────────┤
│ [Try Again] [Different Take]                        │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- Shot
- approved Anchor
- CharacterState
- EnvironmentState
- production style/world rules
- generation job
- Take

Generated params hash must record direction note and resolved reference IDs.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Failed Take never removes selected Take.
- If no Take succeeds, First Cut uses approved anchor still + audio slug.
- Retry must link to previous job and reuse exact params.
- Different Take creates new randomness explicitly.
- Direction note creates new Take without rewriting Shot canon/Story.
- Provider resolution/duration incompatibility is surfaced before launch when knowable.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- compose generation request
- create take job
- retry same take
- generate different take
- generate retake with direction note
- recommend take
- select take
- approve take
- estimate animation batch

---

## 10. Acceptance tests

1. Exact retry produces same params hash.
2. Different Take produces distinct randomness marker.
3. Natural-language correction does not mutate Story/Shot unless explicitly requested.
4. Failed Take leaves selected Take untouched.
5. First Cut can compile with approved anchor when Take is absent.
6. Resolved references satisfy Workspace isolation invariant.

---

## 11. Parallel subagent plan

**Agent A — Takes UI**
- strip
- preview
- select/recommend/approve

**Agent B — generation composer**
- story + canon + state + camera composition
- provider capability routing

**Agent C — retry/direction service**
- params hashing
- retry lineage
- direction notes

**Agent D — batch animation**
- selection
- estimate/confirm
- progress aggregation

**Integrator**
- verifies scheduler is singular and legacy console cannot double-run jobs

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires approved Anchors, scheduler, budget estimate interface.

Can be built in parallel with Storyboard UI after Shot identity and Take API are frozen.

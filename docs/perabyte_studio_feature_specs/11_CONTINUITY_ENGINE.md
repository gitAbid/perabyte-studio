# Continuity Engine

**Requirement family:** FR-26  
**Creator Alpha:** Partial: core checks required, full report later

---

## 1. Purpose

Validate continuity without overwhelming creators with AI diagnostics or pretending unsupported checks are reliable.

---

## 2. Goals

- Check identity, outfit, environment, lighting first.
- Support CharacterState and EnvironmentState comparisons.
- Provide calm per-scene quality signals.
- Provide targeted `Re-roll with guidance`.
- Offer production-level report before export.
- Clearly mark best-effort/not-checked dimensions.

---

## 3. Non-goals

- Silent automatic approval.
- Claiming reliable object chronology detection before it exists.
- Blocking every generation on advisory scores.

---

## 4. Routes / entry points

- chips embedded in Storyboard
- `/production/[projectId]/continuity` report

---

## 5. Primary UI/UX flow

```text
Anchor/Take ready
  ↓
Continuity assessment
  ↓
Pass / Warn / Fail / Not checked
  ↓
Storyboard shows compact badge
  ↓
User can open details
  ↓
Re-roll with guidance
  ↓
Pre-export continuity report
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Continuity Report                                    │
├────────────┬──────────┬────────┬───────────┬──────────┤
│ Scene      │ Identity │ Outfit │ Location  │ Lighting │
│ Scene 01   │ ✓        │ ✓      │ ✓         │ ✓        │
│ Scene 02   │ ✓        │ ⚠      │ ✓         │ ✓        │
│ Scene 03   │ ✓        │ —      │ ⚠         │ ✓        │
├────────────┴──────────┴────────┴───────────┴──────────┤
│ Scene 02: Luna jacket differs. [Re-roll with guidance]│
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- canon bindings
- CharacterState
- EnvironmentState
- AnchorCandidate/Take
- vision assessment

Check status:
`pass | warn | fail | not_checked`

A score is implementation detail; creator UI should prefer human labels.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Advisory failure does not auto-reject an anchor.
- `Re-roll with guidance` creates a new candidate/Take.
- Unsupported dimensions display `Not checked`, not green.
- Changing state rules re-evaluates only affected checks.
- Continuity service failure cannot erase generated media.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- assess anchor
- assess selected take
- compare structured state
- produce report projection
- generate targeted repair guidance

---

## 10. Acceptance tests

1. Outfit mismatch is detected from structured state, not prompt substring parsing.
2. Unsupported chronology check is `not_checked`.
3. Failed score never creates Approved/Rejected automatically.
4. Repair creates a new generation attempt.
5. Report links to exact offending scene/shot/take.

---

## 11. Parallel subagent plan

**Agent A — continuity projection/UI**
- badges
- report
- details

**Agent B — structured comparison**
- CharacterState
- EnvironmentState
- deterministic checks

**Agent C — vision assessment adapter**
- image evaluation
- normalized dimensions

**Agent D — repair action**
- failing-dimension guidance
- reroll integration

**Integrator**
- defines normalized continuity result schema before agents B/C start

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires CharacterState/EnvironmentState and generated anchors.

The report can be deferred from Creator Alpha, but identity/location checks should ship with it.

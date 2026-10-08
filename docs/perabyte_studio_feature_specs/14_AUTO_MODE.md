# Auto Mode

**Requirement family:** FR-29  
**Creator Alpha:** Auto Draft later in Alpha/Beta; Full Auto post-Alpha

---

## 1. Purpose

Turn Auto Mode into orchestration over trusted feature pipelines, not a special bypass path.

---

## 2. Goals

- Offer early Auto Draft before the full vision is complete.
- Run durable background jobs.
- Preserve approval semantics.
- Show cost/length preflight.
- Continue through partial failures.
- Produce a reviewable first cut.

---

## 3. Non-goals

- Silent approvals.
- Hidden spend.
- Separate generation logic from manual mode.
- Failure of one scene blocking the entire production.

---

## 4. Routes / entry points

- Workspace `Create Episode ✨`
- `/production/[projectId]/auto-run`
- review queue embedded in First Cut / Storyboard

---

## 5. Primary UI/UX flow

```text
Idea + duration + quality
  ↓
Preflight estimate
  ↓
Confirm
  ↓
Story proposal
  ↓
Storyboard / anchors
  ↓
Video Takes
  ↓
Audio if available
  ↓
Assembly
  ↓
First Cut Ready
  ↓
Guided Review Queue
  ↓
User Approval
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Create Episode ✨                                    │
│ "Milo and Luna wake a sleeping dragon..."            │
│ Duration [~2 min ▾]   Quality [Balanced ▾]           │
├──────────────────────────────────────────────────────┤
│ Estimated                                             │
│ 12 storyboard images · 10 clips · 26 voice lines     │
│ $3.20–$4.90                                          │
├──────────────────────────────────────────────────────┤
│ [Create First Draft]                                 │
└──────────────────────────────────────────────────────┘

After completion:
Your first cut is ready
[Watch] [Review 5 items] [Make Changes]
```

---

## 7. Data / shared contracts consumed

Auto Mode owns no unique creative entities.
It orchestrates:
- Story proposals
- Shot plans
- Anchors
- Takes
- Audio
- Manifest assembly
- approval review queue

Auto Mode status should reference child job IDs for traceability.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Scene failures degrade to anchor/slug + audio where possible.
- Run survives closed tab/app restart.
- All generated candidates remain Draft/Recommended.
- Hard budget threshold requires explicit confirmation.
- Cancel stops future queued work but preserves completed artifacts.
- Rerun reuses existing approved/recommended results when safe.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- preflight planner
- orchestration DAG/state machine
- child-job aggregation
- failure isolation
- notification on first-cut-ready
- review-queue projection

Phase split:
- **Auto Draft:** Story → Storyboard → Anchors → Takes → rough First Cut.
- **Full Auto:** adds voice/music/SFX/captions/derivatives.

---

## 10. Acceptance tests

1. Auto run produces zero `approved` records without user actions.
2. Child failure does not automatically fail unrelated scenes.
3. Cost estimate appears before spend and budget kernel still enforces backend limits.
4. Closing/reopening app preserves run state.
5. Auto Draft uses the same services as manual feature flows.
6. Review queue links directly to the item needing approval.

---

## 11. Parallel subagent plan

**Agent A — Preflight UI/planner**
- duration/quality
- estimated work/cost
- confirmation

**Agent B — orchestration engine**
- DAG/state
- child jobs
- resume/recovery

**Agent C — run status UI**
- stages
- per-scene failures
- completion summary

**Agent D — review queue**
- recommended items
- deep links
- approval actions

**Integrator**
- verifies Auto Mode calls feature-owned APIs and contains no duplicated generation logic

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Depends on working Story, Storyboard, Takes, assembly, scheduler, and cost interfaces.

Auto Draft should be introduced earlier than Full Auto to validate the flagship promise.

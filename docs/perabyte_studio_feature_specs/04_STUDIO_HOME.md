# Studio Home & Navigation

**Requirement family:** FR-38  
**Creator Alpha:** Required

---

## 1. Purpose

The studio home should help a creator either continue meaningful work or begin a new creative flow. It is not an analytics dashboard.

---

## 2. Goals

- Make `Continue Working` the first returning-user affordance.
- Make Workspace the dominant organizing concept.
- Expose Create Character, Create Environment, and Create Production.
- Keep marketing `/` separate from `/studio`.
- Teach next actions through empty states.

---

## 3. Non-goals

- Analytics dashboards.
- Provider/model selection.
- Production editing.
- Global search beyond navigation/library discovery.

---

## 4. Routes / entry points

- `/` — marketing only
- `/studio` — studio home
- `/workspaces`
- global navigation shared across studio routes

---

## 5. Primary UI/UX flow

```text
Open /studio
  ↓
If first run → guided onboarding
  ↓
Create/select Workspace
  ↓
Show Continue Working + Create Next Episode
  ↓
Enter selected feature with Workspace context chip
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ PeraByte Studio                         Settings      │
│ Workspace context: none                               │
├──────────────────────────────────────────────────────┤
│ Continue working                                     │
│ [Dragon Trouble — First Cut Ready — Review Episode]  │
├──────────────────────────────────────────────────────┤
│ Workspaces                                           │
│ [Milo & Luna] [Forest Tales] [+ New Workspace]       │
├──────────────────────────────────────────────────────┤
│ Create                                               │
│ [Character] [Environment] [Production ✨]            │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- `Workspace`
- production lifecycle summary
- recent-production projection
- global navigation vocabulary

Studio Home must not infer generation scope itself; it only routes into a selected workspace.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- First run: onboarding card.
- No workspaces: explain why Workspace matters.
- Workspace exists but no productions: emphasize Create First Episode.
- First cut ready: `Review Episode` outranks generic Resume.
- Failed jobs: show one calm status badge and route to the affected production.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Read models:
- list workspaces
- list recent productions
- summarize production lifecycle state
- create workspace shortcut

No provider calls occur from Studio Home.

---

## 10. Acceptance tests

1. First-time user can reach Workspace creation without encountering provider/model terminology.
2. Returning user with a first cut ready sees `Review Episode` above generic creation actions.
3. Every generation route entered from a workspace displays its workspace context.
4. Empty states have a single next-step CTA.
5. Navigation uses frozen product vocabulary.

---

## 11. Parallel subagent plan

**Agent A — Home shell**
- `/studio`
- continue-working cards
- creation CTAs
- responsive layout

**Agent B — Navigation**
- nav labels
- route group structure
- workspace context chip
- accessibility

**Agent C — Onboarding**
- first-run state
- guided steps
- empty states
- skip/resume behavior

**Integrator**
- connects read models
- resolves route ownership
- runs vocabulary/a11y regression

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires:
- Workspace list/read APIs
- production lifecycle projection
- shared UX vocabulary

Can be developed in parallel with Character and Environment studios once routing conventions are frozen.

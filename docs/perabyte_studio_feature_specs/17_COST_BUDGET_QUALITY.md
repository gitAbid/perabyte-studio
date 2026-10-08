# Cost, Budget & Quality Strategy

**Requirement family:** FR-17 + FR-35 + product improvement  
**Creator Alpha:** Estimate can start coarse; visible preflight required before blind batch spend

---

## 1. Purpose

Make provider spend understandable to creators without forcing them to learn provider pricing or model names.

---

## 2. Goals

- Estimate before every batch/spend.
- Record actual after completion.
- Provide Economy / Balanced / Best Quality strategies.
- Enforce workspace budget policies.
- Keep provider details under Advanced.
- Measure cost per finished minute.

---

## 3. Non-goals

- Treating costTier badge as sufficient long term.
- Exposing raw provider routing as primary UX.
- Letting UI estimates replace backend authorization.

---

## 4. Routes / entry points

- Workspace recipe/budget settings
- preflight cards on batch generation
- cost detail drawer
- production summary

---

## 5. Primary UI/UX flow

```text
Choose Quality Strategy
  ↓
Planner resolves likely models/retries/candidates
  ↓
Estimate range
  ↓
Budget check
  ↓
Confirm if required
  ↓
Reserve
  ↓
Generate
  ↓
Reconcile actual
  ↓
Show estimate vs actual
```

---

## 6. Primary screen format

```text
Generation Quality
( ) Economy
(•) Balanced
( ) Best Quality

Estimated:
18 images · 14 clips · 30 voice lines
$4.20 – $6.80

Workspace limit: $10.00 per production

[Generate]
```

---

## 7. Data / shared contracts consumed

Consumes backend budget kernel:
- quote
- authorization
- reservation
- proof
- reconciliation

Quality Strategy is a policy input, not a fixed provider mapping.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Quote unavailable: show `Cost unavailable` and obey entitlement policy.
- Over hard limit: block and explain.
- Above confirm threshold: require explicit confirmation.
- Provider overrun is reconciled and surfaced.
- Retry estimate distinguishes no-cost cached reuse vs new provider call where known.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- quality policy resolver
- quote aggregator
- budget policy
- reservation/reconciliation
- cost ledger projection

---

## 10. Acceptance tests

1. Batch animation surfaces estimate before launch.
2. Backend still blocks unauthorized spend even if UI is bypassed.
3. Quality strategy can change provider choice without changing creator workflow.
4. Actual cost is recorded after completion.
5. Cost-per-finished-minute can be calculated per production.

---

## 11. Parallel subagent plan

**Agent A — quality strategy**
- policy config
- workspace recipe integration

**Agent B — cost UI**
- estimates
- confirmation
- actuals

**Agent C — quote feeds**
- provider adapter normalization

**Agent D — ledger/reporting**
- reconciliation
- production totals
- metric projection

**Integrator**
- freezes Money/Quote schema and avoids provider-specific fields leaking into feature APIs

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Budget kernel already provides conceptual authority; live quote feeds may arrive incrementally.

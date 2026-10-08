# Shared Contracts — Cross-Feature Authority

**Purpose:** Prevent parallel feature agents from inventing incompatible data models, job behavior, approval semantics, or scope rules.

A feature spec may **consume** these contracts. It must not redefine them.

---

## 1. Canon contract

Canon is an approved reusable creative identity.

```ts
type CanonKind = "character" | "environment" | "prop" | "style";

interface CanonRevision {
  id: string;
  canonId: string;
  kind: CanonKind;
  parentId?: string;
  createdAt: string;
  approvedAt?: string;
  attributes: Record<string, unknown>;
  assetRefs: string[];
  provenance: {
    provider?: string;
    modelId?: string;
    seed?: string;
    sourceRefs: string[];
  };
}
```

Rules:

- Approved revisions are immutable.
- Refinement creates a child revision.
- Restoring an older version creates/selects a revision; it does not mutate history.
- Generated outputs may reference canon revisions but may not alter canon without approval.

---

## 2. Workspace contract

```ts
interface Workspace {
  id: string;
  name: string;
  characterCanonIds: string[];
  environmentCanonIds: string[];
  styleBlock?: object;
  worldBible: WorldBible;
  productionRecipe: ProductionRecipe;
  rating: "General" | "Mature" | "Adult";
  budgetPolicy?: BudgetPolicy;
}
```

### Isolation invariant

For every generation job:

```text
resolvedReferences ⊆
workspaceSelection
∪ productionSnapshot
∪ explicitUserPicks
```

A globally available asset is not implicitly available to generation.

---

## 3. Production snapshot contract

A production pins the workspace state used at creation.

```ts
interface ProductionSnapshot {
  workspaceId: string;
  characterRevisionIds: string[];
  environmentRevisionIds: string[];
  styleRevisionIds: string[];
  recipeVersion: string;
  worldBibleVersion: string;
}
```

Workspace changes affect new productions, not historical ones.

---

## 4. Character state contract

Permanent identity belongs to canon. Temporary appearance belongs to production/scene state.

```ts
interface CharacterState {
  characterCanonRevisionId: string;
  outfit?: string;
  hairState?: string;
  accessories?: string[];
  carriedObjects?: string[];
  condition?: string[];
  agePresentation?: string;
  notes?: string;
}
```

State inheritance:

```text
Canon defaults
   ↓
Production state
   ↓
Scene state
   ↓
Shot override
```

Most specific layer wins.

---

## 5. Environment state contract

```ts
interface EnvironmentState {
  environmentCanonRevisionId: string;
  zone?: string;
  lighting?: string;
  timeOfDay?: string;
  weather?: string;
  persistentProps?: string[];
}
```

Lighting/time/weather are structured values, not prompt-only prose.

---

## 6. Story / Scene / Shot / Take contract

```ts
interface Scene {
  id: string;
  title: string;
  action: string;
  dialogue: DialogueLine[];
  durationTargetMs?: number;
  characterStates: CharacterState[];
  environmentState?: EnvironmentState;
  shotIds: string[];
}

interface Shot {
  id: string;
  sceneId: string;
  framing: string;
  cameraMotion?: string;
  durationTargetMs: number;
  anchorCandidateIds: string[];
  selectedAnchorId?: string;
  takeIds: string[];
  selectedTakeId?: string;
}

interface Take {
  id: string;
  shotId: string;
  paramsHash: string;
  directionNote?: string;
  assetRef?: string;
  state: "queued" | "running" | "failed" | "ready";
  recommendation?: "none" | "recommended";
}
```

---

## 7. Approval contract

```ts
type ApprovalState = "draft" | "recommended" | "approved";
```

Rules:

- AI may set `recommended`.
- Only explicit user action may set `approved`.
- Viewing a first cut does not approve its dependencies.
- Reordering or dependency replacement may invalidate approval downstream.

---

## 8. Job contract

All production generation uses one durable scheduler/outbox.

```ts
interface GenerationJob {
  id: string;
  type: string;
  scope: {
    workspaceId: string;
    productionId?: string;
    sceneId?: string;
    shotId?: string;
  };
  paramsHash: string;
  resolvedReferenceIds: string[];
  estimatedCost?: MoneyRange;
  state: "queued" | "running" | "failed" | "completed";
  retryOf?: string;
}
```

### Retry rules

- **Try Again:** reuse exact params and references.
- **Different Take:** deliberate new randomness.
- **Change Something:** same selected source plus structured delta.

---

## 9. Cost contract

Every batch/spend action must support:

```text
Estimate → Authorization → Reservation → Provider Proof → Reconciliation
```

The UI can simplify this, but backend state must remain auditable.

---

## 10. Manifest contract

The editor modifies a deterministic production manifest.

Allowed operations:

- reorder
- trim in/out
- retime
- transition
- disable
- duplicate
- replace selected take
- edit audio cue bounds
- edit captions

Do not build arbitrary frame-level NLE behavior into feature-local code.

---

## 11. Dependency invalidation

Downstream artifacts become stale when pinned dependencies change.

Standard UI state:

```text
Stale — re-anchor
```

Supported machine reasons:

- `DEPENDENCY_REPLACED`
- `STORY_CHANGED`
- `DEPENDENCY_MISSING`

---

## 12. Contract-change protocol

If a feature agent needs a shared-contract change:

1. Create a short RFC.
2. Name all affected feature specs.
3. Update contract tests first.
4. Merge shared change.
5. Rebase feature work.
6. Update integration tests.

Never let two agents independently add competing versions of the same shared entity.

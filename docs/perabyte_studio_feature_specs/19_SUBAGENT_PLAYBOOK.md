# Parallel Subagent Implementation Playbook

**Objective:** Minimize elapsed development time without trading away architectural consistency, test quality, or UX coherence.

---

## 1. Parallelization model

Do not parallelize by “everyone edits whatever they need.”

Parallelize by **ownership boundary**:

```text
SHARED AUTHORITY
├── Domain contracts
├── Scheduler / jobs
├── Budget
├── Manifest
└── UI primitives

FEATURE LANES
├── Workspace
├── Character
├── Environment
├── Story
├── Storyboard
├── Takes
├── Audio
├── First Cut
└── Publish
```

Feature agents consume shared contracts.

They do not fork them.

---

## 2. Required setup before feature agents start

The Lead/Integrator freezes:

1. Route naming
2. Shared TypeScript/domain DTOs
3. Approval states
4. Scene → Shot → Take hierarchy
5. Job state model
6. Workspace isolation resolver
7. Canon revision API
8. Manifest mutation API
9. Cost estimate envelope
10. Base UI primitives

“Freeze” does not mean never change. It means changes require an explicit integration decision.

---

## 3. Branch/worktree policy

Recommended:

```text
main
├── feat/shared-contracts
├── feat/workspaces
├── feat/character-studio
├── feat/environment-studio
├── feat/story-studio
├── feat/storyboard
├── feat/takes
├── feat/audio
├── feat/first-cut
└── feat/publish
```

One agent per branch/worktree.

Agents should not share a mutable working tree.

---

## 4. Ownership declaration

Every agent starts by writing:

```yaml
feature: character-studio
owns:
  routes:
    - /character/**
  components:
    - features/character/**
  tests:
    - tests/character/**
consumes:
  - CanonRevision
  - WorkspaceRefResolver
  - GenerationJob
must_not_modify:
  - production/manifest/**
  - production/budget/**
  - shared/contracts/**
integration_contact: lead
```

If ownership overlaps, resolve it before code is written.

---

## 5. Shared-component rule

If two feature agents need the same component or service:

```text
Need appears once  → feature-local is fine
Need appears twice → promote to shared primitive
```

Examples to promote early:

- VariantGrid
- CompareModal
- GenerationStatus
- ApprovalBadge
- WorkspaceContextChip
- CostEstimateCard
- NaturalLanguageChangeBox
- VersionStrip
- EmptyState
- JobProgress
- MediaPreview

Character and Environment agents should never independently build incompatible Variant grids.

---

## 6. Contract-first workflow

For each feature:

### Step A — contract check

Agent reads:

- `02_SHARED_CONTRACTS.md`
- relevant service interfaces
- related feature specs

### Step B — write/confirm public interface

Examples:

```ts
interface CharacterService {
  createDraft(input: CharacterDraftInput): Promise<CharacterDraft>;
  generateVariants(id: string): Promise<JobRef>;
  refine(input: CharacterRefineInput): Promise<JobRef>;
  approveRevision(revisionId: string): Promise<CanonRevision>;
}
```

### Step C — contract tests

Write mocks/contract tests before UI and provider details.

### Step D — implementation

Feature-local implementation.

### Step E — integration tests

Test against real shared services.

---

## 7. Dependency waves

### Wave 0 — shared foundation

Run in parallel:

- Shared contracts/schema
- UI primitives/design system
- scheduler read/write adapters
- budget envelope
- manifest API

Gate: contracts compiled + contract tests passing.

### Wave 1 — world building

Run in parallel:

- Workspace
- Character Studio
- Environment Studio
- Studio Home shell
- Library base

Gate:
- workspace isolation test
- canon approval/version tests
- common Variant UX unified

### Wave 2 — planning

Run in parallel:

- Story Studio
- Storyboard UI
- continuity structured checks
- cost UI

Gate:
- StoryRevision → ShotPlan transition
- dependency invalidation tests
- anchor approval path

### Wave 3 — production

Run in parallel:

- Takes
- audio import/mix
- First Cut shell
- assembly worker

Gate:
- approved anchor → take → manifest → playable First Cut

### Wave 4 — automation/output

Run in parallel:

- Auto Draft
- Publish/export
- advanced manifest editor
- continuity report
- TTS adapter

Gate:
- full Creator Alpha regression

---

## 8. Integration checkpoints

Do not wait until the end.

Integrate at these vertical checkpoints:

### Checkpoint 1
Workspace → Character/Environment membership.

### Checkpoint 2
Workspace → Story generation context.

### Checkpoint 3
Story → Storyboard → Anchor.

### Checkpoint 4
Anchor → Take → selected media.

### Checkpoint 5
Take → Manifest → First Cut.

### Checkpoint 6
First Cut → Export Package.

At every checkpoint, run the full isolation and approval suites.

---

## 9. Merge gate checklist

A feature branch cannot merge unless:

- [ ] No duplicate shared contract introduced.
- [ ] No primary UI jargon violations.
- [ ] `Draft → Recommended → Approved` semantics preserved.
- [ ] Workspace isolation tests pass where generation occurs.
- [ ] Retry behavior preserves exact params.
- [ ] Failure preserves previous approved/selected output.
- [ ] Long actions expose explicit job state.
- [ ] Cost preflight exists for batch spend where supported.
- [ ] Mobile/basic accessibility reviewed.
- [ ] Feature acceptance tests pass.
- [ ] Cross-feature integration tests updated.

---

## 10. Conflict prevention

### Do not let feature agents independently modify

- database migrations touching the same table
- shared revision types
- scheduler state enum
- approval enum
- manifest schema
- budget objects
- generation reference resolver

Assign these to one Integration/Platform agent.

---

## 11. Agent handoff format

Every subagent returns:

```markdown
# Handoff

## Implemented
- ...

## Public interfaces added/changed
- ...

## Migrations
- ...

## Tests
- ...

## Known gaps
- ...

## Risks
- ...

## Integration steps
1. ...
2. ...

## Files changed
- ...
```

No “done” handoff without tests and integration notes.

---

## 12. Recommended specialized agents

### Lead / Integrator
Owns contracts, migrations, cross-feature decisions, merge order.

### UX Systems Agent
Owns common UI primitives, design language, accessibility, jargon audit.

### Domain Agent
Owns revisions, workspace snapshots, invalidation, state machines.

### Generation Agent
Owns provider adapters and normalized generation request/response behavior.

### Media Pipeline Agent
Owns vault, thumbnails, FFmpeg, assembly, export.

### QA Agent
Works continuously, not only at the end:
- contract tests
- E2E golden path
- failure injection
- race/retry tests
- accessibility
- regression

---

## 13. Golden-path E2E test

Every integration wave should preserve:

```text
Create Workspace
→ Create Character
→ Approve Character Canon
→ Create Environment
→ Approve Environment Canon
→ Create Production
→ Generate Story
→ Approve Story
→ Generate Storyboard Anchor
→ Approve Anchor
→ Generate Take
→ Select Take
→ Build First Cut
→ Export MP4
```

This test is more important than any individual feature demo.

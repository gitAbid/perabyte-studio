# Story Studio

**Requirement family:** FR-28  
**Creator Alpha:** Required

---

## 1. Purpose

Turn a simple idea into a structured, editable story and allow conversational revisions without destroying previous versions.

---

## 2. Goals

- Idea → title/synopsis/beats/scenes/dialogue/ending.
- Multi-turn revision chat.
- Visible proposal diff.
- Stable beat/scene identity across revisions where possible.
- Workspace-aware cast/world rules.
- Script moderation pre-check for General/kids content.

---

## 3. Non-goals

- Final video editing.
- Direct take generation.
- Rewriting approved history in place.
- Prompt-engineering controls.

---

## 4. Routes / entry points

- `/production/[projectId]/story`
- legacy writer route may import into a Production

---

## 5. Primary UI/UX flow

```text
Enter one-sentence idea
  ↓
Generate Story Draft
  ↓
Review scenes
  ↓
Ask for changes conversationally
  ↓
Receive Proposal + visible diff
  ↓
Accept / reject proposal
  ↓
Approve Story Revision
  ↓
Generate Storyboard
```

---

## 6. Primary screen format

```text
┌────────────────────────────────┬─────────────────────┐
│ Story                          │ Ask for a change    │
│                                │                     │
│ 1. The Picnic                  │ "Make the ending    │
│ 2. Strange Footprints          │ funnier..."         │
│ 3. Sleeping Dragon             │                     │
│ 4. Escape                      │ [Apply]             │
│                                │                     │
│ [Scene details...]             │ Proposed changes    │
│                                │ + Scene 3 dialogue  │
│                                │ ~ Ending revised    │
├────────────────────────────────┴─────────────────────┤
│ [Approve Story]                         [Storyboard] │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- production snapshot
- World Bible
- selected cast/environment canon
- proposal/revision contract

Dialogue/narration text should remain verbatim after explicit user edits unless a user asks to rewrite it.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Each revision request creates a proposal, never direct mutation.
- Failed generation leaves current story intact.
- Structural changes re-evaluate numbering and downstream storyboard staleness.
- General/kids workspace script pre-check blocks or highlights unsafe content before visual generation.
- Diff should be human-readable, not raw JSON.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- create story proposal
- revise via instruction
- diff revisions
- approve StoryRevision
- mark dependent shot plan stale
- script moderation pre-check

---

## 10. Acceptance tests

1. `Add a chase before Scene 6` creates a proposal with stable unchanged scenes.
2. Rejecting a proposal restores no state because current revision was never mutated.
3. Approving a revised story marks affected storyboard dependencies stale.
4. User-edited dialogue remains verbatim.
5. World Bible rules are present in story-generation context.
6. General workspace moderation runs before storyboard generation.

---

## 11. Parallel subagent plan

**Agent A — Story editor**
- structured scene list
- detail editor
- approval

**Agent B — Revision chat**
- command box
- proposal lifecycle
- diff renderer

**Agent C — Story service**
- proposal API
- stable IDs
- revision persistence

**Agent D — moderation integration**
- script pre-check
- safe failure UX

**Integrator**
- owns StoryRevision-to-Storyboard invalidation contract

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires Workspace snapshot and proposal infrastructure.

Can run in parallel with Character/Environment UI once World Bible resolver is stable.

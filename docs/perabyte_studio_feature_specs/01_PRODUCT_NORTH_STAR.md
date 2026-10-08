# Product North Star

## 1. Product definition

PeraByte is an **AI production studio / showrunner**, not a collection of generation tools.

The creator expresses intent, selects preferred results, makes corrections, and approves. The platform handles the production machinery underneath.

---

## 2. Non-negotiable principles

1. **Selection over configuration**  
   Generate options, choose one, refine it. Technical model controls stay under Advanced.

2. **Canon before prompts**  
   Characters and environments are reusable identities. A creator should not repeatedly rewrite their visual description.

3. **Workspace isolation**  
   Only assets selected into the active workspace may enter normal generation context.

4. **Progressive complexity**  
   Beginner path first. Shots, model settings, audio tracks, lineage, and manifests stay available without becoming mandatory.

5. **AI drafts; humans approve**  
   AI can recommend. It never silently creates final approval.

6. **Cost is visible**  
   Estimate before spend, actual after spend.

7. **Failure does not destroy the production**  
   Partial first cuts are valid. Missing video can degrade to approved anchor + audio.

8. **Reproducibility matters**  
   Approved canon and production snapshots are immutable references, not mutable global state.

---

## 3. Core UX vocabulary

Use:

- Character
- Environment
- Workspace
- Production
- Story
- Storyboard
- Scene
- Shot
- Take
- Canon
- First Cut
- Approve
- Publish

Do not show in primary UI:

- seed
- CFG
- sampler
- inference
- context strength
- reference weight
- negative prompt
- provider-specific jargon

These may appear only under Advanced / Settings.

---

## 4. Scene hierarchy

```text
Production
└── Scene        narrative unit
    └── Shot     camera/composition unit
        └── Take generated attempt
```

A beginner may see shots collapsed, but implementation and terminology must preserve this hierarchy.

---

## 5. Approval model

```text
Draft
  ↓
Recommended
  ↓
Approved
```

### Draft
Generated, imported, or edited but not reviewed.

### Recommended
AI/quality systems consider it the strongest candidate.

### Approved
Explicit creator action. No automation may synthesize this state.

---

## 6. Product releases

### Release 1 — CREATE

Goal: idea → approved visual storyboard.

Includes:

- Workspace
- Character Studio
- Environment Studio
- World Bible
- Story Studio
- Storyboard
- Anchors
- Basic continuity

### Release 2 — PRODUCE

Goal: storyboard → playable export.

Includes:

- Shots
- Takes
- Video generation
- Character state
- Imported voice/music
- Audio mix
- First Cut
- MP4 export

### Release 3 — AUTOMATE

Goal: creator becomes supervisor instead of operator.

Includes:

- Full Auto Mode
- TTS
- generated music/SFX
- natural-language production edits
- advanced continuity
- publishing integrations
- derivatives
- music video specialization

---

## 7. Primary success metric

> A returning creator opens a workspace, writes one sentence describing the next episode, chooses duration and quality, confirms estimated cost, and receives a coherent first cut using the correct characters, environments, style, voices, and continuity without manually composing generation prompts.

Supporting metrics:

- Time to first storyboard
- Time to first playable cut
- Manual generation prompt count
- Character identity acceptance rate
- Environment consistency acceptance rate
- Storyboard acceptance rate
- Generated/selected asset ratio
- Cost per finished minute

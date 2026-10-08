# PeraByte Studio — Modular Feature Specification Pack

**Status:** Implementation-oriented decomposition of the Production Studio PRD v2.0  
**Goal:** Make major product areas independently understandable and safely parallelizable without fragmenting product behavior or shared contracts.

---

## 1. How to use this pack

This folder is intentionally split into **feature-owned specs** and **shared authority specs**.

### Read these before implementing any feature

1. `01_PRODUCT_NORTH_STAR.md`
2. `02_SHARED_CONTRACTS.md`
3. `03_UX_DESIGN_SYSTEM.md`
4. The relevant feature spec
5. `19_SUBAGENT_PLAYBOOK.md`

A feature agent must not redefine concepts already owned by the shared specs.

---

## 2. Product hierarchy

```text
PeraByte Studio
│
├── Studio Home
├── Creative Library
│   ├── Characters
│   ├── Environments
│   ├── Voices
│   └── Styles
├── Media Library
│   ├── Images
│   ├── Videos
│   ├── Audio
│   └── Exports
│
└── Workspaces
    ├── World Bible
    ├── Cast
    ├── Environments
    ├── Production Recipe
    └── Productions
        └── Production
            ├── Story
            ├── Storyboard
            ├── First Cut
            └── Publish
```

---

## 3. Core creator loop

```text
Create Workspace
      ↓
Create / Select Characters
      ↓
Create / Select Environments
      ↓
Enter Story Idea
      ↓
Generate Story
      ↓
Generate Storyboard
      ↓
Approve Anchors
      ↓
Generate Video Takes
      ↓
Assemble First Cut
      ↓
Review
      ↓
Export / Publish
```

Everything in this pack must either support this loop or be explicitly marked as an extension.

---

## 4. Shared UX interaction model

Every generative feature should reuse:

```text
Generate
   ↓
Compare
   ↓
Select
   ↓
Refine
   ↓
Approve
```

Every regenerated result should expose only these creator-facing concepts:

- **Try Again** — same intent and parameters.
- **More Like This** — selected result becomes lead reference.
- **Change Something** — preserve selected result and apply a delta.

Approval states are universally:

```text
Draft → Recommended → Approved
```

Only a user action can create the `Approved` state.

---

## 5. Feature specs

| File | Owner area |
|---|---|
| `04_STUDIO_HOME.md` | Studio entry, onboarding, continue-working |
| `05_WORKSPACES.md` | Isolation, World Bible, production recipes |
| `06_CHARACTER_STUDIO.md` | Character canon creation and refinement |
| `07_ENVIRONMENT_STUDIO.md` | Environment canon and derived views |
| `08_STORY_STUDIO.md` | Conversational story writing and revisions |
| `09_STORYBOARD_SHOTS.md` | Main visual planning surface |
| `10_SCENE_GENERATION_TAKES.md` | Anchors, video generation, takes |
| `11_CONTINUITY_ENGINE.md` | Identity/state/location continuity |
| `12_VOICE_AUDIO_STUDIO.md` | Voice, narration, ambience, music, SFX |
| `13_PRODUCTION_EDITOR.md` | First cut, NL changes, manifest editor |
| `14_AUTO_MODE.md` | Auto Draft and Full Auto orchestration |
| `15_PUBLISH_EXPORT.md` | Export packages and platform publishing |
| `16_LIBRARY_VERSIONING.md` | Creative/media discovery, lineage, retention |
| `17_COST_BUDGET_QUALITY.md` | Estimates, budgets, quality strategy |
| `18_MUSIC_VIDEO_MODE.md` | Song-driven production mode |

Shared implementation files:

| File | Authority |
|---|---|
| `01_PRODUCT_NORTH_STAR.md` | Product behavior and milestone scope |
| `02_SHARED_CONTRACTS.md` | Data/state/domain rules |
| `03_UX_DESIGN_SYSTEM.md` | UI language, screen states, accessibility |
| `19_SUBAGENT_PLAYBOOK.md` | Parallel implementation protocol |
| `20_FEATURE_SPEC_TEMPLATE.md` | Template for future feature specs |
| `21_IMPLEMENTATION_ROADMAP.md` | Integration order and release gates |

---

## 6. Parallel-build safety rule

A subagent may modify only:

1. Its declared feature-owned routes/components/tests.
2. New files under its feature boundary.
3. Shared contracts only through an explicitly reviewed contract change.

Shared contracts are **not** feature-local implementation details.

If two feature specs need the same primitive, it belongs in the shared layer.

---

## 7. Creator Alpha

The first product milestone is not “all features done.”

### Success definition

A creator can make a **60–180 second consistent story video** with reusable characters and environments without manually writing image/video prompts.

### Required

- Workspace
- Character Studio
- Environment Studio
- Story Studio
- Storyboard
- Anchors
- Takes
- Basic continuity
- Basic assembly
- MP4 export

### Deferred from Creator Alpha

- Generated TTS
- Generated music/SFX
- Social publishing integrations
- Full Auto Mode
- Music Video Mode
- Advanced manifest editing
- SaaS/multi-user support

# Music Video Mode

**Requirement family:** FR-30  
**Creator Alpha:** Deferred

---

## 1. Purpose

Reuse the same production pipeline for song-driven visual storytelling where music timing replaces narration timing.

---

## 2. Goals

- Upload/choose song with rights attestation.
- Analyze sections/lyrics where available.
- Propose visual concept and storyboard.
- Drive scene timing from music.
- Reuse canon, shots, takes, manifest, export.
- Add beat synchronization later.

---

## 3. Non-goals

- Separate renderer.
- Separate timeline implementation.
- Claim beat-perfect sync before detection is implemented.

---

## 4. Routes / entry points

- Workspace Create Production → Music Video
- `/production/[projectId]/story` adapts to music sections
- shared storyboard/first-cut routes

---

## 5. Primary UI/UX flow

```text
Upload Song
  ↓
Rights attestation
  ↓
Optional visual direction
  ↓
Analyze sections / lyrics
  ↓
Propose visual concept
  ↓
Storyboard
  ↓
Generate anchors / takes
  ↓
Assemble to song timing
  ↓
Review / Export
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Create Music Video                                   │
│ [Upload / Choose Song]                               │
│ Visual direction: "dreamy neon city..."              │
│                                                      │
│ Timing: Music-driven                                 │
│ Beat sync: Later feature                             │
│ [Create Concept]                                     │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes the same:
- Production
- Scene/Shot/Take
- Manifest
- AudioCue
- Export

Music sections may act as narrative beats, but should not introduce a separate Story data model.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Unsupported audio format gives actionable conversion guidance.
- Song analysis failure still permits manual section markers.
- Beat sync UI hidden/marked later until reliable.
- Visual generation failures use normal partial-cut rules.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- song ingest
- rights attestation record
- section analysis
- optional lyric/beat proposal
- music-driven timing adapter
- shared production orchestration

---

## 10. Acceptance tests

1. Music Video compiles through normal manifest.
2. Narration-driven timing is disabled.
3. No separate media-generation stack exists.
4. Beat-perfect claims are absent until detector ships.
5. Manual section markers can replace failed analysis.

---

## 11. Parallel subagent plan

**Agent A — mode setup**
- ingest
- rights
- concept

**Agent B — section/timing analysis**
- sections
- later beat detector spike

**Agent C — Storyboard adaptation**
- music sections as beats
- visual concepts

**Integrator**
- ensures shared Storyboard/Takes/Manifest remain the only render path

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Depends on stable production pipeline. Appropriate after core episode workflow proves reliable.

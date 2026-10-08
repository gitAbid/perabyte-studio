# Voice & Audio Studio

**Requirement family:** FR-27 + FR-14  
**Creator Alpha:** Import-first only

---

## 1. Purpose

Give characters stable voices and productions an understandable audio layer while supporting an import-first path before generative audio is available.

---

## 2. Goals

- Global voice library with per-character locked binding.
- Workspace-local recast.
- Per-line delivery controls.
- Imported narration bridge.
- Scene audio plan: dialogue, ambience, SFX, music.
- Manifest-based mix.
- Later TTS/generative audio adapters.

---

## 3. Non-goals

- Lip sync until supported.
- Fake generated-audio controls before providers exist.
- Complex DAW-style mixing in primary UI.

---

## 4. Routes / entry points

- `/voices`
- `/production/[projectId]/audio`
- character profile voice binding

---

## 5. Primary UI/UX flow

```text
Character binds Voice
  ↓
Production script creates speech segments
  ↓
Import audio OR generate TTS when available
  ↓
Auto delivery or simple preset
  ↓
Scene audio plan proposes ambience/SFX/music
  ↓
User accepts/imports assets
  ↓
Mix preview
  ↓
Approve Audio Mix
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Audio — Scene 04                                     │
├──────────────────────────────────────────────────────┤
│ Luna: "Did you hear that?"                           │
│ Voice: Luna Canon Voice   Delivery: [Auto ▾]         │
│ [Import] [Generate when available] [Regenerate]      │
├──────────────────────────────────────────────────────┤
│ Ambience: cave wind                 [Choose Audio]    │
│ SFX: pebble fall                    [Choose Audio]    │
│ Music: quiet suspense               [Choose Track]    │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- character voice binding
- SpeechSegment
- AudioCue
- AudioMixRevision

Voice hierarchy:
`Global Voice → Character Canon Binding → Workspace-local Recast`

Delivery presets:
`Auto | Calm | Excited | Scared | Angry | Whisper | Shout`

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Missing TTS provider shows Import, not disabled fake generation.
- Imported audio retains voice-lock bookkeeping.
- Audio-generation failure does not block visual review.
- Rights attestation required for uploaded music where applicable.
- Mix retains source stems.
- Target loudness follows product mix contract.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- voice library
- character voice binding
- workspace recast
- speech segment import/render
- delivery inference
- audio plan proposal
- cue/mix revision
- loudness/ducking processing

---

## 10. Acceptance tests

1. Recasting a voice locally does not mutate global Character canon.
2. Imported narration produces the same segment bookkeeping as generated narration.
3. UI never claims TTS availability when no adapter is active.
4. Delivery change creates/re-renders only affected speech line.
5. Music replacement does not regenerate video.

---

## 11. Parallel subagent plan

**Agent A — Voice library/binding**
- voice CRUD
- character binding
- workspace recast

**Agent B — speech segments**
- import
- future provider adapter interface
- delivery presets

**Agent C — audio plan/mix UI**
- scene plan
- cue selection
- stem visualization

**Agent D — processing**
- ducking
- loudness
- mix worker

**Integrator**
- freezes AudioCue/SpeechSegment adapter boundaries before provider-specific work

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Import path depends on audio domain C09/C10-equivalent functionality.
TTS provider choice remains swappable behind adapter interface.

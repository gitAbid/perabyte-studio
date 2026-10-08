# First Cut & Production Editor

**Requirement family:** FR-31  
**Creator Alpha:** Basic First Cut required

---

## 1. Purpose

Provide a simple First Cut review experience and an advanced manifest editor without becoming a traditional nonlinear video editor.

---

## 2. Goals

- Play assembled First Cut.
- Let users jump from playback to Scene/Shot.
- Persistent `Ask for a change`.
- Deterministic manifest edits.
- Track-style advanced visualization.
- Reassemble only affected output after changes.

---

## 3. Non-goals

- Arbitrary frame-level clip manipulation.
- Editing rendered pixels directly.
- Competing timeline state separate from the manifest.

---

## 4. Routes / entry points

- `/production/[projectId]/first-cut`
- `/production/[projectId]/edit` advanced view

---

## 5. Primary UI/UX flow

```text
Selected Takes + Audio
  ↓
Compile Manifest
  ↓
Assemble First Cut
  ↓
Watch
  ↓
Ask for change OR open Scene
  ↓
Translate supported command
  ↓
Apply manifest / retake / audio operation
  ↓
Reassemble affected master
  ↓
Review
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ First Cut                                 [Export]    │
│ [                   VIDEO PLAYER                   ]  │
├──────────────────────────────────────────────────────┤
│ Ask for a change                                     │
│ "Trim 2 seconds off scene 5"             [Apply]     │
├──────────────────────────────────────────────────────┤
│ Scenes  01  02  03  04  05                           │
│ [Advanced Edit]                                      │
└──────────────────────────────────────────────────────┘

Advanced:
VIDEO    [S1][S2][S3][S4]
VOICE    ──████──██████──
MUSIC    ████████████████
SFX      ──★────★──★─────
CAPTIONS ─████─████─████──
```

---

## 7. Data / shared contracts consumed

Consumes:
- production manifest
- selected takes
- audio mix
- captions
- QC result

No feature-local timeline model is permitted.

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Unsupported NL command routes user to matching panel with explanation.
- Manifest command must preview intended operation before destructive changes.
- Reassembly failure leaves prior playable master intact.
- Missing Take is represented by anchor/slug fallback.
- Single-shot change should not regenerate unrelated scenes.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- manifest read/update
- NL intent → known operation translator
- assembly worker
- QC worker
- playback timeline mapping
- export handoff

---

## 10. Acceptance tests

1. `swap scenes 3 and 4` creates manifest/plan revision without regenerating media.
2. `make scene 2 more dramatic` routes to a retake direction note.
3. `Luna sounds scared here` routes to affected speech delivery.
4. Failed reassembly preserves previous master.
5. Timeline state is fully reconstructable from manifest.

---

## 11. Parallel subagent plan

**Agent A — First Cut UI**
- player
- scene navigation
- review state

**Agent B — NL command router**
- supported intents
- previews
- graceful fallback

**Agent C — Advanced manifest view**
- tracks
- trim/reorder/disable/duplicate

**Agent D — assembly/QC**
- incremental build
- master versioning
- diagnostics

**Integrator**
- is sole owner of manifest mutation API to prevent divergent editing models

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires assembly/export worker and selected media.

First Cut can initially ship with only playback + scene links; Advanced Edit may follow.

# Publish & Export Studio

**Requirement family:** FR-32  
**Creator Alpha:** MP4/manual package required; direct publishing later

---

## 1. Purpose

Turn an approved production into dependable files and publishing metadata, prioritizing excellent export before platform integrations.

---

## 2. Goals

- Export master and aspect derivatives.
- Generate manual publication package.
- Show explicit checklist.
- Enforce rating/policy gates.
- Later add YouTube OAuth.
- Keep unsupported platforms visibly unavailable rather than fake-enabled.

---

## 3. Non-goals

- Building every social API before creators reliably finish videos.
- Publishing Adult workspaces to unsupported platforms.
- Hidden upload actions.

---

## 4. Routes / entry points

- `/production/[projectId]/publish`
- export dialog
- connected-channel settings later

---

## 5. Primary UI/UX flow

```text
Approved First Cut
  ↓
QC checklist
  ↓
Choose aspect + quality
  ↓
Compile/export
  ↓
Prepare package:
 video + thumbnail + captions + metadata
  ↓
Download
  ↓
Optional connected-platform publish
  ↓
Explicit final confirmation
```

---

## 6. Primary screen format

```text
┌──────────────────────────────────────────────────────┐
│ Ready to Publish                                     │
│ [Final video preview]                                │
├──────────────────────────────────────────────────────┤
│ ✓ Video   ✓ Voice   ✓ Music   ✓ Captions            │
│ Title      [generated / editable]                    │
│ Description[generated / editable]                    │
│ Thumbnail  [A] [B] [C]                              │
├──────────────────────────────────────────────────────┤
│ Export: 16:9 · High                                  │
│ [Download Package]        [Publish to YouTube*]      │
└──────────────────────────────────────────────────────┘
```

---

## 7. Data / shared contracts consumed

Consumes:
- ExportRecord
- PublicationPackage
- rating
- QC
- captions
- thumbnail assets
- metadata proposal

Manual package recommended:
```text
video.mp4
thumbnail.png
captions.srt
title.txt
description.txt
hashtags.txt
chapters.txt
production.json
```

Do not redefine shared types locally. See `02_SHARED_CONTRACTS.md`.

---

## 8. States and failure behavior

- Export failure preserves previous valid export.
- Adult workspace shows Export Only with clear explanation.
- Mature publishing defaults to age-restriction where relevant.
- Platform disconnected state says Connect, not Publish.
- OAuth failure never marks publication complete.
- Publish action is explicit and auditable.

All long actions must follow the common queued/running/completed/failed UX in `03_UX_DESIGN_SYSTEM.md`.

---

## 9. Service/API responsibilities

Services:
- compile master
- derivative exporter
- package builder
- metadata proposal
- QC gate
- later YouTube OAuth/upload adapter

---

## 10. Acceptance tests

1. Manual package is complete without any platform connection.
2. Adult workspace cannot invoke unsupported publish action.
3. Export variants derive from same manifest.
4. A successful platform upload creates an auditable job record.
5. Failed upload leaves export package available.
6. Metadata remains editable before publishing.

---

## 11. Parallel subagent plan

**Agent A — Publish UI/checklist**
- readiness
- metadata
- thumbnails

**Agent B — export worker**
- aspects
- quality presets
- package

**Agent C — policy/rating**
- gates
- disclosure defaults
- compliance copy

**Agent D — platform adapter (later)**
- OAuth
- channel defaults
- upload status

**Integrator**
- keeps manual package path independent from external API availability

### Integration rule

Each agent may work in parallel after the listed shared contracts are frozen. One designated integrator owns route wiring, schema migrations, and cross-feature tests.

---

## 12. Dependencies

Requires assembly/QC.

YouTube integration should not block Creator Alpha or initial production-quality validation.

# Hosted / SaaS boundary (M6-4, spec 18/15 exploration)

**Status: written boundary, deliberately not built.** The roadmap's own gate applies: platform/API
integrations are promoted only after core production completion is reliable. This document is the
design boundary that keeps that later move cheap; it is not a feature.

## What the studio is today (single-machine, single-creator)

- **Storage**: SQLite store + content-addressed local media vault under one data dir (`.studio`),
  0700/0600 file modes. Every artifact (canon revisions, takes, exports, packages, upload records,
  voice store) is content-hash-pinned and reproducible from the vault + event records.
- **Trust**: one local creator (`local_creator`/`local-creator` actor). Same-origin mutation checks
  exist because the studio serves a browser, not because there are untrusted users.
- **Spend**: the budget kernel (quotes → authorization → reservation → provider proof →
  reconciliation) is already auditable and per-account — it is the one subsystem designed
  multi-tenant from the start.
- **Platform adapters** (YouTube M6-1): OAuth tokens sit in a 0600 JSON file next to the store;
  acceptable locally, unacceptable for a hosted service.

## The boundary line

Anything that must NOT change when the studio goes hosted is a **contract** (frozen zod schemas,
pure domain modules, CAS stores). Anything that assumes one machine is an **edge**:

| Edge (machine-local)                | Contract (survives hosting)                     |
| ----------------------------------- | ----------------------------------------------- |
| `.studio` file layout, vault paths  | content hashes, revision chains, CAS semantics  |
| process-resident job worker         | job/lease/outbox record shapes                  |
| in-file OAuth tokens (M6-1)         | auditable `PlatformUploadRecord` + explicit confirm |
| `resolveProductionDataDir()`        | every store port interface                      |
| local ffmpeg spawn (assembly)       | manifest + package schemas, QC gates            |

## What hosting would require (in order)

1. **Data dir → storage service**: swap `LocalMediaVault` and the SQLite store for S3/Postgres
   implementations behind the SAME ports. No domain module changes (this was the point of C5/C13).
2. **Worker → queue service**: the production worker already leases via records; move the lease
   owner to a multi-instance queue with the same record shapes.
3. **AuthN/AuthZ**: real actors replace `local_creator`; approvals already record `actorId` — the
   "only a human approves" invariant becomes per-account instead of per-machine.
4. **Secrets**: OAuth refresh tokens and provider keys move to a secrets manager; the adapters'
   injected-transport seams (YouTubeTransport, TTS adapter, provider transports) are where the
   hosted variants slot in without UI changes.
5. **Billing**: the budget kernel becomes the metering surface (it already reconciles provider
   proof per job).

## Explicit non-goals until core is reliable

Multi-tenant workspaces, concurrent-editor conflict UX beyond today's CAS, hosted render farms,
platform publishing beyond one adapter, and any feature that would couple a domain module to a
cloud SDK.

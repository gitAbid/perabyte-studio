# Production core agent protocol

This protocol applies to any model, coding agent, or human worker assigned a registered Cxx/Ixx packet. Model choice is an execution preference, never a change to the task contract. A worker may use any capable model; packets are self-contained and reviewed from evidence. The requested GPT-6.1 Sol orchestrator/reviewer and GPT-6 Luna worker arrangement is a preference, not a prerequisite.

## Usage stop and ownership transfer

Follow AGENTS.md and HANDOVER.md. User override2026-10-04: Before dispatch/resume inspect all windows; stop only when weekly<=1%remaining OR five-hour<=2%remaining, or required data unknown. Old5%dispatchreserve and minimum2% rules in historical packets are superseded. Remaining=100-usedPercent; never interpret usedPercent asremaining. Checkpoints must include partial/dirty work and exact failed/unrun checks, not just accepted commits. Each worker owns at most one active packet; do not assign a second until the first is handed off. Take over only after the prior writer is idle/stopped and ownership is transferred; never reset/clean its worktree. Update SESSION_STATE.json after each accepted packet and before stopping.

## Before starting

1. Read `docs/production/ARCHITECTURE.md`, `docs/production/task-registry.json`, the assigned section in `docs/production/TASK_PACKETS.md`, and relevant masterplan sections. If a required shared contract or registry entry is missing, do not guess: report that exact missing input.
2. Confirm the integrator assigned the packet (status `planned` or owned `active`), dependencies are integrated, and the assigned base SHA matches the integration announcement. Create/use a dedicated worktree and branch for this packet. Never work on the user's original checkout or another packet's tree.
3. Read repository `AGENTS.md` and local instructions. Inspect only relevant code and tests before editing. Check `git status --short`; preserve all pre-existing changes.
4. Send the orchestrator the packet ID, base SHA, worktree/branch, owned files, and any contract ambiguity. Do not begin a parallel-wave packet if its owned-file list overlaps another active packet.

## Boundary preflight before implementation

Before writing implementation, send the integrator a small concrete boundary map: packet/base/owned paths; existing DTO and port names being consumed; composition/factory entry points; persisted database/vault paths; transaction versus network/filesystem steps; required shared amendments. Cite exact existing modules. The integrator checks this map before implementation; this is internal review, not a new user permission step. Missing modules may be scaffolded for behavioral RED, but do not invent alternate job/asset/approval DTOs, duplicate production databases or global setter composition. C04 uses accepted ProductionJob/ProductionStore/ProviderPort records and the production.sqlite outbox; no separate worker-state universe. A wrapper path is not permission to create a second source of truth.

```json
{
  "task_id": "C04",
  "base_sha": "actual git rev-parse HEAD",
  "consumes": [{"module":"lib/repositories/production/ports.ts","symbols":["ProductionStore","ProviderPort"]}],
  "composition": ["explicit lazy factory with injected ports"],
  "persistence": ["configured .studio/production.sqlite", "configured owned media vault"],
  "effects": [{"transaction":"persist submitting intent and lease","outside_transaction":"provider submit","transaction_after":"persist durable provider reference/receipt"}],
  "shared_amendments": []
}
```

Review draft boundaries early, before a large diff, and verify key regressions through accepted real-store fixtures. A provider-submit crash between acceptance and acknowledgment must retain submitting/unknown intent; never restart as a new queued submission. Only durable media plus persisted receipt/result rows permits completed status.

## While implementing

- Work only inside the packet's explicit owned-file list. Do not change shared contracts, package manifests, lockfiles, environment secrets, architecture, registry, or another packet's files without integrator assignment.
- Keep the patch narrow, typed and compatible with existing behavior. The server owns identity, revisions, fingerprints, capability checks, approvals, job IDs and manifest truth. A browser value may request an operation but cannot authorize it.
- Save RED evidence, then GREEN evidence, using the exact commands and cases from the packet. Cases are observable behaviors, not a requirement to implement any particular internal structure unless C00 specifies it.
- Do not add mirrored tests or bulk unrelated tests. Test the behavior and its failure boundaries: no writes, no provider submission, no path exposure, no duplicate work, or no stale approval as relevant.
- Do not publish/deploy, send external messages, alter unrelated user data, or delete/migrate source JSON. Paid provider calls are forbidden for development/unit/fixture packets. They are allowed only for C13/C14 real-film pilots and C16 adapter smoke when covered by an existing authorized project/experiment scope and cap; reuse that authorization without asking again while within its scope and cap. If absent, ambiguous or exceeded, stop paid work and report the blocker. Never increase scope or cap yourself.
- If code or tests reveal a needed cross-packet change, stop at the interface seam and send a proposal. Continue independent work in owned files only where it remains correct without the change.
- Run formatting/typecheck/focused tests required by the packet and `git diff --check`. Review your full diff for ownership, secrets, generated artifacts, accidental fixture data and unrelated changes. Do not claim completion while commands are still running or failures remain unexplained.

## Evidence capture without overwrite

Use a new timestamp/nonce log path for every command attempt, including retries. Enable shell `set -C` (noclobber) before `>` redirection, or open logs in exclusive-create mode. If a log already exists, choose a fresh path before executing. Preserve failed output independently from later GREEN output. If an earlier raw log was overwritten, disclose that loss and label tool-captured excerpts as excerpts; never reconstruct or claim original raw RED evidence.

## Commit and handoff

Commit only the packet-owned files, with a message starting `<packet-id>: `. Provide the commit SHA and exact base SHA. Do not cherry-pick or merge your own change; the integrator reviews and integrates sequentially. Do not update packet status or `TASKS.md`; only the integrator updates the machine registry and progress log after independent review.

Attach a completion report using the JSON shape below. Include one evidence entry per required test case and command, including RED and GREEN. For each command provide exact argv, exit code, raw output path or concise output excerpt, and SHA-256 of saved raw output. `changed_files` must exactly match the commit's changed files. `review.findings` lists issues found/fixed and any unresolved item; empty array means none found. `unverified` explicitly names anything not checked. `paid_calls` must be empty except in C13/C14/C16 under the authorization rule below.

```json
{
  "task_id": "C01",
  "status": "implemented",
  "base_sha": "40-hex-character commit",
  "head_sha": "40-hex-character commit",
  "commit_sha": "40-hex-character commit",
  "worktree": "/absolute/path/to/packet-worktree",
  "changed_files": ["lib/repositories/production/sqlite.ts"],
  "testcases": [
    {
      "id": "T01-01",
      "result": "pass",
      "command": ["npm", "test", "--", "lib/repositories/production/sqlite.test.ts"],
      "exit_code": 0,
      "output_file": "evidence/C01/T01-01-green.txt",
      "output_sha256": "64-hex-character SHA-256",
      "assertion": "fresh database enables WAL and foreign keys"
    }
  ],
  "evidence": [
    {
      "kind": "red|green|typecheck|build|diff-check|manual|integrity|hash",
      "command": ["npm", "test", "--", "..."],
      "exit_code": 0,
      "output_file": "evidence/C01/green.txt",
      "output_sha256": "64-hex-character SHA-256"
    }
  ],
  "review": {
    "findings": [],
    "ownership_check": "pass",
    "diff_check": "pass"
  },
  "unverified": [],
  "paid_calls": [],
  "authorization": {
    "reference": null,
    "scope": null,
    "cap": null,
    "currency": null
  },
  "spend": {
    "actual": null,
    "currency": null,
    "status": "none|known|unknown",
    "receipt_refs": []
  }
}
```

For I00/I01, C00–C12, C15 and C17, `paid_calls` must be empty and spend status must be `none`. For C13/C14/C16, every actual or uncertain provider submission appears in `paid_calls` as `{provider,model,job_ref,receipt_ref,authorization_ref,actual_spend,currency,cap_remaining}`; `actual_spend` is a number or the literal `unknown`. Report authorization scope/cap and receipt references. Do not fabricate authorization, hashes, output files, or spend. This is a report shape, not permission to mark `status` implemented when any acceptance remains. `status` may be `blocked` or `incomplete`; include the exact blocker and completed subset. Generate hashes and Git SHAs directly with tools/scripts when writing the report; do not reconstruct or transcribe them from memory. The integrator recomputes hashes from saved bytes. Do not fabricate hashes/output files. A reviewer must be able to reproduce each result from the stated base and command.

## Integrator review and merge

The integrator checks base/head ancestry and changed-file ownership; reads the full diff; reproduces the focused green command; inspects red evidence and required cases; checks that no cloud dependency, unauthorized/unreported paid call, silent fallback, destructive import, or status inflation slipped in; and runs integrated `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` at the appropriate milestone. A worker report is evidence to inspect, not approval. The integrator records the reviewed commit and evidence in the registry and `TASKS.md`, then announces the new shared base SHA before dependent packets start.

If a report is incomplete or an independent review finds an issue, return a concrete finding with file/line, trigger, expected behavior and required evidence. Worker fixes stay in its packet branch/worktree. Never paper over a failed test by deleting, weakening, skipping or re-labeling it. Re-review the corrected commit before integration.

## Completion report checks

- `task_id` is a known ID and matches assigned scope; all dependencies are integrated.
- `base_sha`, `head_sha`, `commit_sha`, exact `changed_files`, and dedicated worktree are present and valid.
- Each required `Txx-yy` and applicable `A-xx` is accounted for with an explicit pass/fail and reproducible evidence. Expected failures from the RED step are reported as red evidence, not as acceptance failures.
- Every command has its true exit code and hashed output. Manual evidence identifies browser/runtime, fixture, observed behavior and screenshot path. Hashes use SHA-256 over the saved raw output bytes.
- Review findings, unverified behavior and paid calls are explicit. Any non-empty `paid_calls` for a packet without paid-call authorization, any unrecorded/unknown spend on an allowed pilot, unresolved finding, missing acceptance case, unowned diff, or unstated limitation prevents the integrator from marking the task done.
- Worker never changes shared task status. Only the integrator marks `done`, `blocked`, or `planned` in the registry after review.

Continuous delivery (user2026-10-04): Immediately integrate independently reviewed/verified completed slices into codex/production-core, preserve evidence and archive the idle worktree, then advance. Never integrate unaccepted drafts.

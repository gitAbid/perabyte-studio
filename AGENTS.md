# Production development rules

Read docs/production/README.md, ARCHITECTURE.md, QUALITY_GATES.md, AGENT_PROTOCOL.md and HANDOVER.md before production work. User instructions override this file. Current priority is core functionality; defer UI redesign until the core is usable. When UI work resumes, keep it professional and genre-neutral and follow DESIGN.md. Do not modify the user's original checkout.

## Usage guard and resumability

User override2026-10-04: Continue until **weekly remaining <=1% OR five-hour remaining <=2%**. These separate per-window stops override the older minimum2% and5% dispatch reserve in historical packets/checkpoints. Compute remaining =100-usedPercent, inspect every available bucket, identify windows by windowDurationMins (weekly10080, five-hour300), and stop on unknown/unavailable required data. Other reported windows must remain known; report additional limits rather than assume unlimited. Check at start, before dispatch, after review/integration and at least10min. No5% stop/reserve applies now. Workers obey root's latest live observation and checkpoint immediately when either threshold is reached.

At either stop, cease source changes/new implementation/tests/review dispatch, let already-running verification settle safely, preserve work and update handover/state/evidence. No new paid generation is authorized by this development usage policy.
Record the latest observation, each worktree/branch/base/head, dirty paths, active task/owner, exact completed acceptance and test commands, unresolved findings, unverified work, paid submission references and the next command in docs/production/SESSION_STATE.json and HANDOVER.md. Update at every accepted packet and before ending a session, even above the threshold. Agents never mark another worker's task done without review and evidence.

## Safe takeover

One active writer per packet/worktree. Before taking over, confirm the previous worker is idle/stopped, inspect status/diff/history and read its report; ask the orchestrator when ownership is unclear. Reuse the existing worktree without reset/clean, preserve all dirty changes, and record ownership transfer. Continue from the actual SHA, rerun relevant checks, and review against the same acceptance IDs. Do not overwrite an active agent or unrelated changes. Merge/cherry-pick only through the integrator in dependency order. An incomplete checkpoint is not an accepted implementation.

After a user asks to resume (or a session has already authorized continuation), check account limits again and read current handover before any implementation. If weekly<=1% or five-hour<=2%, or required data unknown, stay stopped. A reset alone does not authorize scheduled/background execution. Future orchestration may use another approved agent/model with the same packets, ownership and evidence rules.

## Feature-first delivery — user steering 2026-10-04

Prioritize finishing usable core functionality. For now use the smallest meaningful functional checks and typecheck for the changed boundary; defer comprehensive coverage, repeated full suites/builds, mutation campaigns and optional fault matrices until the feature flow is implemented. Preserve existing tests and evidence. Paid submission still requires exact approved provenance, authorized budget and atomic reservation; minimal verification must establish those boundaries when changed. Record deferred test IDs explicitly rather than claiming full coverage or film release. Independent review remains narrow and focused on material behavior.

Maintain codex/production-core as the separate integration/root branch. Integrate reviewed completed source slices there once, excluding already-integrated prerequisites. Archive idle completed worker worktrees with the app archive tool after preserving evidence and required ignored data; never reset/clean the original checkout, archive an active worker, or merge a controlled proof mutant. PROGRESS.md is the concise current feature view; SESSION_STATE and HANDOVER retain exact resume evidence.

## Continuous delivery — user2026-10-04
Immediately integrate each completed slice after focused verification and independent acceptance into codex/production-core; preserve exact evidence, archive the idle completed worktree, then continue the next dependency-ready packet. Do not wait for the whole feature to deliver accepted slices. Draft/unaccepted changes stay isolated.

User2026-10-04 branch cleanup override: after accepted integration and preserved evidence/recovery, delete completed unused local branches. Retain root, active writer, primary and original dirty-checkout branches. Record exactSHA/equivalence/deletion/recovery in branch-cleanup report. Historical no-branch-deletion rules are superseded only for completed unused branches.

For production-core review, remediation, or release closure, read docs/production/reviews/2026-10-07-core/REMEDIATION.md and ISSUES.json before dispatch or status changes; apply their issue-specific evidence and independent-review closure gates.

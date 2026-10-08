# Production studio execution kit

This is the implementation specification for a beautiful, dependable local studio that turns an approved story into a reviewed, upload-ready film. It enriches the original roadmap. These documents and the clickable prototype are complete planning artifacts; the new persistence, human approval, audio and export features are still implementation work.

## Current review and remediation

Before reviewing, fixing, or closing production-core release gates, read [the 2026-10-07 review](reviews/2026-10-07-core/REVIEW.md), [remediation acceptance cases](reviews/2026-10-07-core/REMEDIATION.md), and [issue status](reviews/2026-10-07-core/ISSUES.json). The [agent handoff prompt](reviews/2026-10-07-core/AGENT_PROMPT.md) dispatches the work. This package records open findings; historical implementation/pilot statuses below do not close them.

## Start here

1. [Research](RESEARCH.md): primary sources, evidence limits, what to adopt and avoid.
2. [Architecture](ARCHITECTURE.md): authoritative deployment, domain, persistence, provider, worker, audio and export contracts.
3. [Interface specification](UX_SPEC.md): routes, screens, copy, state handling, accessibility and browser acceptance.
4. [Clickable design preview](preview.html): professional, genre-neutral warm-paper/evergreen visual direction and guided project → story → shots → review → finish flow. Illustrations and save states are simulated; it does not generate films.
5. [Quality gates](QUALITY_GATES.md): explicit G00–G10 checks, human review, technical blockers, recovery and real-film release criteria.
6. [Task packets](TASK_PACKETS.md), [machine registry](task-registry.json), [agent protocol](AGENT_PROTOCOL.md): exact scope, parallel waves, dependencies, acceptance evidence and review handoffs.
7. [Pilot fixtures](fixtures/pilots.json): six-shot 48-second portrait story and thirty-shot four-minute landscape story, pinned cast/world/prop IDs and exact narration. Planning data, not finished media.

If older roadmap wording conflicts with this kit, ARCHITECTURE.md governs technical contracts, QUALITY_GATES.md governs acceptance, and UX_SPEC.md governs presentation. Resolve a material conflict in an ADR before implementation rather than inventing a second contract.

## Delivery order

First freeze C00 typed schemas, API DTOs, repository/provider ports and executable fixtures. Then run C01 persistence, C03 capabilities and C05 planner in parallel. Advance by the registry's dependency waves, integrating reviewed commits before starting dependent workers. C02 immutable canon and C04 worker/vault unlock approval, take history and UI work. Imported audio enables the first export without waiting for new voice/music models. C13/C14 must produce actual reviewed short and long films; C15 tests recovery and release installation. C16/C17 are deferred extensions.

Use GPT-6.1 Sol for orchestration, architecture, design and independent review; use GPT-6 Luna for bounded implementation and data gathering. Any capable agent can execute a packet with the same evidence contract. Every worker uses a separate `codex/` branch/worktree; only the integrator changes shared contracts, dependencies, global navigation and task status.

## Validate this planning kit

From repository root:

```sh
python3 scripts/verify-production-plan.py
node scripts/verify-production-plan-preview.mjs
```

The first checks registry/dependency/ownership/fixture structure. The second opens the standalone prototype with Playwright at 375, 768, 1280 and 1440 pixels, checks overflow, stage navigation, save-error approval blocking and export blocking, and writes screenshots/report to `/tmp/perabyte-production-design`. These checks validate planning artifacts only. They do not establish that the app or generated films pass release gates.

## Current boundary

The earlier consistency foundation passed 835 tests, typecheck and build, recorded in TASKS.md. The production scheduler's explicit human approval, SQLite persistence, audio and final export are not implemented by this kit. No provider generations or paid renders were performed while preparing it. Model reference conditioning improves control but cannot guarantee identity or narrative fidelity; creator review remains required.

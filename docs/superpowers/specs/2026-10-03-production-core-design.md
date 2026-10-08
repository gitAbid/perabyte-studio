# Production studio core design

## Goal and priority
Build a solo creator's script-to-video studio with reusable cast and worlds. Kids content is the first pilot; mythology, documentary and promotional formats follow through profiles, not separate pipelines. Preserve approved story meaning, character identity, wardrobe, environment and spatial continuity. Short and long form share the same shot pipeline. Thumbnail, description, derivative reels and publishing follow the production core.

## Chosen approach
Use an anchor-first, reviewable pipeline built on existing services/repositories/provider adapters. Prompt-only orchestration is cheap but cannot enforce asset use. Training a bespoke character model is expensive and unnecessary before measuring reference workflows. The recommended middle path pins canonical references, approves shot stills, animates only those stills, and accepts takes through explicit QC.

User authorized research, planning and starting implementation without another approval round. This document records that starting design; it does not claim that a generative model can guarantee pixel-perfect identity.

## Architecture
Keep the current Next.js/TypeScript UI and thin API routes. Introduce focused domain modules for canon validation, immutable shot inputs, approval, capability policy, manifests and QC. Application services coordinate these through repository and provider ports. Providers implement only their supported image/video/speech/music capabilities. A separate durable worker executes long jobs and FFmpeg assembly; HTTP handlers submit/query commands. Avoid a generic framework or broad unrelated rewrite.

Flow: script revision -> approved story/cast/world -> ordered shots -> reference-conditioned stills -> human approved keyframe -> capability-checked animation -> accepted takes -> voice/music/SFX bindings -> manifest -> mastered video + QC report. Changes to a script, entity reference or shot invalidate dependent approvals. Retakes preserve siblings and take history. Camera cuts re-anchor; continuous movement uses an explicit continuation choice.

## First build boundary
1. Add explicit strict reference policy at the shared generation preflight. Strict rejects malformed/over-limit references, unsupported start/end/context inputs and unavailable cache images before any provider submission. Capability substitution is allowed only if it preserves all requested inputs. Legacy requests retain current permissive behavior.
2. Validate explicit story and scene character/location IDs before rendering; an unknown ID is an actionable error, never a silent drop. Resolve location descriptions from the same rows used for visual references, including scene updates.
3. Test both through public service/runner boundaries with no paid provider calls.

This first build is a consistency foundation, not complete production approval or mastering. Strict policy can be requested by solo or story clients through the existing generation/job request boundary; production workflow wiring follows in the next increment.

## Verification and error behavior
Run baseline suite, failing regression tests, worker focused suites, integrated suite, typecheck and production build. Failures must identify the field or scene and precede provider calls. Persisted legacy jobs lacking a policy remain compatible. No automatic fallback may silently weaken a strict request. Missing canonical IDs fail before run state mutation at start; validate again when advancing resumed runs.

## Execution isolation
Orchestrator/architect/reviewer: GPT 6.1 Sol as requested; research and implementation workers: GPT 6 Luna. Integration branch codex/production-core starts at existing HEAD (79a8c89). Separate worker worktrees and commits are cherry-picked after review. Original worktree, dirty text-engine-chain.ts and untracked requirements/IDE files remain untouched. Reference the user's untracked requirements draft as input; do not commit it implicitly.

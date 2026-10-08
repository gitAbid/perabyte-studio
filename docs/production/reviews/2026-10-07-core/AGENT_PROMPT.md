# Agent handoff prompt

Copy the following into the agent/orchestrator chat:

```text
Review and remediate the production-core findings in:
/Users/abid/Projects/perabyte-studio/.worktrees/zcode-production-core/docs/production/reviews/2026-10-07-core/

Read REVIEW.md, EVIDENCE.md, REMEDIATION.md and ISSUES.json, then AGENTS.md and the current production architecture/quality gates/protocol/state. REMEDIATION.md is the acceptance contract. Baseline reviewed SHA is 7570fd7d44075dc50a0ebefb72886bc341bfd762; inspect actual HEAD, dirty files and active owners before starting. Preserve the original checkout and all pre-existing changes, including dirty PROGRESS.md.

Act as orchestrator/integrator. Assign bounded implementation agents in isolated worktrees plus independent reviewers who did not author their reviewed changes. Record exact ownership/base/dependencies and freeze shared contract/migration amendments first. Follow the lane map: serialize R01→R04→R07 assembly edits and R05→R08→R06 QC edits; R03 and disjoint R02 work can proceed concurrently. Resolve any overlap before dispatch. Integrate accepted slices sequentially; do not let builders self-accept or update completion status.

Revalidate every finding, preserve behavioral RED evidence, make the smallest correct fix, and run every issue-specific closure case. Use temporary real SQLite stores, subprocess restart/lease tests, actual FFmpeg fixtures and browser tests where specified. Keep provider calls mocked/offline; no new paid generation, deployment or external publishing is authorized. Preserve budgets, approval provenance, uncertain-submission safety, media/history and old-data compatibility. Do not weaken gates or remove tests to obtain GREEN.

Fix R01 export lease fencing, R02 backup QC evidence, R03 loopback startup, R04 automatic export recovery, R05 complete narration/dialogue coverage, R06 interval-specific acknowledgments, R07 ducking/two-pass mastering, R08 independent format QC, then reconcile R09 status documentation. Obtain an independent exact-SHA acceptance report for each slice before integration and rerun affected checks afterward.

Close an issue only when all numbered REMEDIATION.md cases pass on integrated code and its evidence is complete. Record exact commands/exits/log hashes, source and integrated SHAs, reviewer identity/verdict, compatibility checks and remaining limitations in reports and ISSUES.json. Preserve failed logs. If a finding is already fixed or disproven, require independent current counterevidence rather than silently skipping it.

On the final integrated SHA run the full tests, typecheck, production build, diff check and combined localhost/restart/backup/audio/QC/browser scenarios. Gate B may close only when all nine issues satisfy their gates. Report Gate C separately: the exact short/long film bytes still need actual creator G09 review plus G10 recovery/installation evidence. Never invent human approvals or transfer approvals to changed encodes.

Continue the authorized review/fix/verification work until Gate B is achieved or a concrete blocker prevents further progress. At a blocker preserve a precise checkpoint and next command. Final report: each issue's status, integrated SHA, acceptance case IDs, evidence and independent review links, remaining issues, and separate Gate A/B/C decisions. Production-ready is permitted only after Gate C actually passes.
```

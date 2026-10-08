# Quality and release gates — v1

Normative product acceptance policy. All thresholds below are chosen product targets, not measured model performance or universal industry standards. Record actual evidence before marking a gate passed. Vision similarity numbers, test suite success and an MP4 container alone do not mean a production-ready film.

## Gate record and outcomes

Each gate record: `gateId,targetId,targetHash,outcome:pass|fail|pending|waived,kind:automated|human|advisory,checks[],actorOrTool,toolVersion,recordedAt,evidenceRefs[]`. Checks include ID, expected, actual, pass boolean and evidence ref. An automated hard blocker cannot be waived to claim upload-ready. Advisory warnings can be acknowledged with a reason tied to exact frame/time; human approvals require all mandatory checks true. No blank checklist, auto-checked defaults or invented scores.

| Gate | Stage | Required acceptance | Failure/recovery | Owner |
| --- | --- | --- | --- | --- |
| G00 | Plan/task readiness | Architecture contracts frozen; task dependencies accepted; branch/base/owned files recorded; commands and fixture IDs known | Correct packet/ADR before implementation | Integrator |
| G01 | Canon | Entity revision exists; selected reference files readable/checksum-matching; identity/wardrobe/style/location descriptions explicit; creator approves exact revision; source rights recorded | Repair/upload/create reference; new revision invalidates affected approvals | Creator + canon service |
| G02 | Story/shot plan | Every approved beat covered; no unknown cast/place/prop IDs; exact narration preserved; durations/format valid; no critical plot contradiction; human story+animatic approval | Edit/replan affected shots; keep original script and unaffected shots | Creator + planner |
| G03 | Anchor | All required refs transported by supported adapter; still locally durable; exact shot/hash valid; human face/wardrobe/location/props/framing checks all true | Retake still/change refs/compatible model; vision failure routes review | Creator + approval service |
| G04 | Submission | Anchor/animatic approval current; quote/scope/cap authorized; required refs within capacity; idempotency stable; worker lease valid | Block before spend with specific fix; uncertain submission reconciles | Job service/worker |
| G05 | Take | Locally durable decodable video; expected frames/dimensions/audio policy; no explicit dropped conditioning; creator accepts identity, wardrobe, setting, intended action, motion/camera, and artifacts | Reject take and retake selected shot; no automatic billed retries | Creator + take service |
| G06 | Audio | All intended spoken lines present and intelligible; pinned voice consistent; cue duration/samples valid; music/SFX rights attested; no abrupt/truncated words; human mix approval | Edit/regenerate/import only affected line/cue, revise timing | Creator + audio service |
| G07 | Manifest | Only accepted matching take revisions; legal trims/crops/transitions; stable order; no missing sources; deterministic hash; total timeline and audio exact | Resolve stale/missing asset or invalid cue; no silent placeholders | Manifest service |
| G08 | Technical export | Full decode exit0; specified dimensions/fps/codecs/pixel/sample/color format; expected duration within1frame; audio end within1frame; measured full mix loudness-14LUFS±1 and truepeak≤-1dBTP; checksum verified | Stage-specific error with affected shot/cue; reassemble after fix | FFmpeg/QC worker |
| G09 | Final film review | Creator watches exact downloadable bytes end-to-end; narrative/visual/audio/caption check all true; every advisory warning reviewed; final approval binds file checksum | Reject export, identify shots/cues, preserve rejected export/history | Creator |
| G10 | Release/recovery | Real short and long pilots passG01–G09; reopen/restart/reconcile/backup/restore tests pass; clean install and run instructions work; offline/retry UX verified; no secrets in logs | Remain release candidate with evidence of blockers | Integrator + independent reviewer |

## Human review rubric

Story: compare generated shot list/takes to the approved beat. Required: protagonist goal preserved; cause/consequence/order make sense; resolution is earned; no invented character/setting/action changes the plot; all exact spoken lines accounted for. Do not allow aggregate scores to hide a contradiction. Age/language intent must be checked on the actual film, not just a safe-mode toggle.

Canon/anchor/take: display canonical character and location thumbnails alongside candidate at usable size. Reviewer marks each required dimension pass/fail with a retake reason. Identity includes shape/face/fur pattern; wardrobe includes colors/items; place includes distinctive structures/layout; props includes ownership and count; motion includes unwanted body/face deformation, teleporting, continuity and camera intent. Optional1–5 quality rating supports comparisons; required checks remain binary. A normal hard cut need not match spatial camera positions frame-for-frame; explicit continuous motion must match its approved start/end intent.

Audio: listen on headphones and laptop/phone speakers. Exact intended transcript is available beside playback. Verify names, pronunciation, pauses, ending words, consistent narrator voice, no unwanted speech, music below speech and sensible SFX. Native generated audio never passes by default. For narration-led v1 mute provider audio unless specifically reviewed/bound as an accepted cue; avoid doubling narration with native dialogue.

Final film: play every frame range once at normal speed; inspect all cuts, beginning/end, titles/captions and audio transitions. Download and reopen the same file in an independent player. Mark final checklist on this checksum, not an earlier browser preview or a different encode.

## Automated QC and advisory separation

Automated blockers: decoder failure, incorrect profile/codecs, missing required audio/video streams, nonfinite probe values, invalid trim/cue, checksum failure, orphaned references, outdated required approval, audio hard clipping/truepeak violation, output exceeding approved duration tolerance, or required spoken segment omitted from declared cues. No waiver can make these pass.

Advisory detection: black/freeze ranges, silent gaps, face/reference similarity, ASR text mismatch, caption timing, potential visual artifacts. Detection is evidence to inspect, not autonomous acceptance. Default flag: black range≥6frames outside approved fades; freeze≥48frames unless planned static shot; unexplained silence≥24000samples inside spoken cue. An intentional fade/static frame/pause has a manifest annotation and a human-reviewed interval; it does not count as a defect. Incorrect ASR is not proof script was changed; compare to source text and listen. Log thresholds and detector versions.

For the explicitly silent draft profile, G08 applies video/checksum/duration checks and skips absent audio-stream/loudness checks; this does not pass the narrative-film release profile. Empty/non-narrated experimental solo clip can exist as a draft; the film pilot still requires narration, music and at least one deliberate SFX cue. Technical and human gates are separate. A user may download a clearly labeled **Draft / QC failed** artifact through an explicit draft action, but it must not receive **Ready to upload**, a final approval or the release-success badge. Public release defaults to the gated final download path.

## Required fault-injection matrix

| Case | Exact expected behavior/evidence |
| --- | --- |
| Double-click generation | Same idempotency key yields one job/provider submission; UI immediately locks action and shows existing job |
| Same key, different request |409 and original job unchanged |
| Two tabs edit same draft |409 on stale version; typed local text preserved; explicit merge/save-as-new action |
| Edit canon after anchor approval | Affected active anchors/takes show stale reason; animation call makes zero provider submissions |
| Unavailable/exhausted vision | Pending human review; no auto video job |
| Required refs overflow/missing | Field/shot-specific error before submit; no truncation or T2V fallback |
| Stop app/browser during render | Worker continues; reopening app attaches existing job and same revision |
| Worker crash before provider call | Expired intent reclaimed once with same snapshot/key |
| Crash after provider accept before ref persisted | submission_unknown; no automatic resubmit; reconciliation evidence required |
| Worker crash after provider ref persisted | Poll/reconcile same ref; no extra submission |
| Vault write fails / disk full | Job not complete; reference retained for recovery; UI points to storage action |
| Cancel render/poll/export | Confirm saved artifacts retained; no more scheduled submissions; partial export excluded; provider late result marked canceled/historical |
| FFmpeg child fails | Error includes stage/shot and redacted stderr; retry only assembly, no image/video regeneration |
| Narration missing/too short | Cue/manifest validation blocks or creator retimes; no silent filler or chopped words |
| Provider native speech differs | Creator rejects/mutes track; scripted narration can be imported without video retake |
| Backup with active writes | Consistent SQLite online backup plus immutable asset inventory/checksums; restore verifies every referenced asset |
| Unknown subscription coverage | Display unknown; block paid submission until quote/entitlement/cap established |

## Upload-ready outputs

Profiles are fixed in ARCHITECTURE.md. Manual YouTube upload checklist references current official policy: choose title/description/thumbnail, audience designation, applicable altered/synthetic disclosure and visibility; wait for processed output and inspect it. Creator determines content-specific audience/disclosure. Export approval is not proof that YouTube accepted/processed the file. Keep OAuth/publishing out of v1. [Encoding](https://support.google.com/youtube/answer/1722171?hl=en), [made for kids](https://support.google.com/youtube/answer/9528076?hl=en), [altered content](https://support.google.com/youtube/answer/14328491?hl=en).

## Pilot and benchmark protocol

Smoke first: one approved anchor and one5–8second clip within an authorized cap; compare actual inputs/receipt and creator assessment. Then short pilot: fixture Milo/Pip six-shot48second story with approved narrator/music/SFX. Then long:30distinct8second shots,240seconds; no looped short film. Freeze references, version/seed/model/settings and actual quote before each pilot. At least two completed end-to-end films plus restart/restore tests are required for initial release; expensive54-take comparison is an optional later optimization study, not a release prerequisite.

For pilot acceptance every selected anchor/take passes mandatory human checks; failed candidates remain recorded with reasons and actual/unknown cost. Measure first-pass acceptance, retake rate, latency, final cost per accepted minute and defect categories. Do not fabricate target90% first-pass performance or postpone delivery until an arbitrary sample passes it. Final selected film must contain zero unreviewed/stale approvals, missing required story beats or critical story/identity/location failures. Independent reviewer checks evidence and watches both exported pilots.

## Definition of task done and release done

Task done: owned diff meets all packet acceptance IDs, necessary regression/contract tests observed fail then pass, mandatory commands exit as expected, evidence files exist, completion report conforms to AGENT_PROTOCOL, reviewer accepts spec and code quality, changes integrated and integration tests pass. A worker self-report alone is not done.

Release done: C13,C14,C15 evidence accepted; actual export files and checksums accessible; user can repeat the run from documented commands, reopen the project and retake a shot without breaking siblings; storage restore is demonstrated. Automated suite pass counts cannot substitute for these film artifacts. Until then use **implemented module**, **prototype**, or **release candidate** with precise limitations.

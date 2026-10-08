"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui";
import { NaturalLanguageChangeBox } from "@/components/production/primitives/change";
import type { ErrorEnvelopeView } from "@/components/production/project-canon";
import type { StoryRevision } from "@/lib/production/contracts";
import { deriveStoryDiff, splitRevisionInstruction } from "@/lib/production/story-view-model";
import { requestStoryRevise } from "@/components/production/story/client";
import { ErrorAlert } from "@/components/production/story/shared";

/* ------------------------------------------------------------------ */
/* RevisionDiffPanel — ask for a change, see it land as a revision     */
/* ------------------------------------------------------------------ */
/* The conversational revision rail (spec 08 §6 right column). The     */
/* instruction is submitted through the deterministic story revise     */
/* endpoint, which applies it as a NEW child story revision in the     */
/* content-hash chain (provenance: the parent link plus the instruction*/
/* carried behind the visible [revision request] marker). No AI engine */
/* is involved yet — the provider pass arrives later via the proposals */
/* route — so the request needs no engine pick. The response reports   */
/* which pinned scenes the instruction references, and the panel keeps */
/* the human-readable diff between this session's base and the active  */
/* revision so the creator sees what moved. Manual editing is separate */
/* and untouched.                                                      */

export interface RevisionDiffPanelProps {
  projectId: string;
  /** The currently active story revision (reloads flow in as props change). */
  story: StoryRevision;
  /** The revision captured when the studio loaded this session — the diff "before". */
  baseRevision: StoryRevision;
  canonRevisionIds: readonly string[];
  /** Called after a revise was applied (or replayed) so the studio can reload the active revision. */
  onApplied?: () => void;
}

type RevisionOutcome =
  | { state: "applied"; revisionId: string; changedSceneIds: string[] }
  | { state: "replayed"; revisionId: string; changedSceneIds: string[] }
  | { state: "error"; envelope: ErrorEnvelopeView };

type RevisionRequestView = {
  key: string;
  instruction: string;
  submittedAt: number;
  outcome: RevisionOutcome | null;
  pending: boolean;
};

const INSTRUCTION_MAX_CHARS = 2_000;

export function RevisionDiffPanel({ projectId, story, baseRevision, onApplied }: RevisionDiffPanelProps) {
  const [requests, setRequests] = useState<RevisionRequestView[]>([]);

  const diff = useMemo(() => deriveStoryDiff(baseRevision, story), [baseRevision, story]);

  // The composed instruction the base revision carries (if this session created it).
  const lastComposed = useMemo(() => splitRevisionInstruction(story.scriptText), [story.scriptText]);

  async function handleRevise(instruction: string) {
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setRequests((previous) => [{ key, instruction, submittedAt: Date.now(), outcome: null, pending: true }, ...previous]);
    const call = await requestStoryRevise({
      projectId,
      baseStoryRevisionId: story.id,
      expectedBaseContentHash: story.contentHash,
      instruction,
    });
    setRequests((previous) => previous.map((item) => (item.key === key ? { ...item, pending: false, outcome: call.outcome } : item)));
    if (call.outcome.state !== "error") onApplied?.();
  }

  return (
    <aside aria-label="Ask for a change" data-testid="story.revise.panel" className="space-y-4">
      <header>
        <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Ask for a change</h2>
        <p className="mt-1 text-[13px] text-muted">
          Say what to change in your own words. PeraByte records it as a new story revision — the earlier revision stays in the chain, and quoted lines show which scenes are affected.
        </p>
      </header>

      <div className="rounded-[12px] border border-border bg-raised p-4">
        <NaturalLanguageChangeBox
          label="What should change?"
          placeholder="For example: “Add a chase before the picnic” or quote the line to change…"
          submitLabel="Request change"
          maxChars={INSTRUCTION_MAX_CHARS}
          busy={requests.some((item) => item.pending)}
          onSubmit={(instruction) => void handleRevise(instruction)}
          testIdBase="story.revise"
        />
      </div>

      {/* Human-readable diff between this session's base and the active revision. */}
      <section aria-label="Proposed changes" data-testid="story.diff" className="rounded-[12px] border border-border bg-raised p-4">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">What changed</h3>
        {!diff.hasChanges ? (
          <p role="status" data-testid="story.diff.summary" className="mt-2 text-[13px] text-muted">
            {story.id === baseRevision.id
              ? "Nothing yet — the story matches where you started."
              : "The story text matches where you started; the revision was re-saved without changes."}
          </p>
        ) : (
          <>
            <p data-testid="story.diff.summary" className="mt-2 text-[13px] font-semibold text-ink">
              {diff.entries.length} change{diff.entries.length === 1 ? "" : "s"} since you started
              {diff.unchangedCount > 0 ? ` · ${diff.unchangedCount} beat${diff.unchangedCount === 1 ? "" : "s"} untouched` : ""}
            </p>
            <ul className="mt-2 space-y-2">
              {diff.entries.map((entry) => (
                <li key={`${entry.kind}-${entry.beatId}`} data-testid="story.diff.entry" className="rounded-[8px] border border-border bg-surface px-3 py-2">
                  <p className="flex items-start gap-2 text-[13px] font-semibold text-ink">
                    <span aria-hidden="true" className={entry.kind === "added" ? "text-success" : entry.kind === "removed" ? "text-danger" : "text-warning"}>
                      {entry.kind === "added" ? "+" : entry.kind === "removed" ? "−" : "~"}
                    </span>
                    <span>
                      {entry.kind === "added" ? <>Added {entry.label}</> : entry.kind === "removed" ? <>Removed {entry.label}</> : <>Changed {entry.label} ({entry.changedFields.map(fieldDisplayName).join(" and ")})</>}
                    </span>
                  </p>
                  {entry.kind === "changed" ? (
                    <dl className="mt-1.5 space-y-1 text-[12.5px] leading-snug">
                      {entry.changedFields.map((field) => (
                        <div key={field}>
                          <dt className="font-semibold text-ink-soft">{fieldDisplayName(field)}</dt>
                          <dd className="mt-0.5">
                            {fieldText(entry.before, field) !== null ? (
                              <span className="mr-1 rounded-[4px] bg-danger-soft/60 px-1.5 py-0.5 text-ink line-through">{fieldText(entry.before, field)}</span>
                            ) : null}
                            <span className="rounded-[4px] bg-success-soft/60 px-1.5 py-0.5 text-ink">{fieldText(entry.after, field)}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {entry.kind === "added" ? (
                    <p className="mt-1 text-[12.5px] leading-snug text-ink-soft">{plainBeatText(entry.after)}</p>
                  ) : null}
                  {entry.kind === "removed" ? (
                    <p className="mt-1 text-[12.5px] leading-snug text-muted line-through">{plainBeatText(entry.before)}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
        {lastComposed.instruction ? (
          <p className="mt-3 border-t border-border pt-2 text-[12px] text-muted">
            Last instruction carried with the current revision: “{lastComposed.instruction}”
          </p>
        ) : null}
      </section>

      {/* Revision requests log — each ask and the exact server decision. */}
      {requests.length > 0 ? (
        <section aria-label="Your change requests" data-testid="story.requests" className="space-y-2">
          <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">Your change requests</h3>
          <ul className="space-y-2">
            {requests.map((item) => (
              <li key={item.key} data-testid="story.request.item" className="rounded-[8px] border border-border bg-raised px-3 py-2.5">
                <p className="text-[13px] font-semibold text-ink">“{item.instruction}”</p>
                {item.pending ? (
                  <p role="status" className="mt-1 text-[12.5px] text-muted">Applying to the story chain…</p>
                ) : item.outcome?.state === "applied" ? (
                  <p role="status" data-testid={`story.request.${item.key}.applied`} className="mt-1 text-[12.5px] text-ink">
                    <Badge tone="success">Revision applied</Badge>{" "}
                    <span className="font-mono text-[11.5px]">{item.outcome.revisionId}</span>
                    {item.outcome.changedSceneIds.length > 0
                      ? ` — ${item.outcome.changedSceneIds.length} scene${item.outcome.changedSceneIds.length === 1 ? "" : "s"} mention this change and may need a look.`
                      : " — no saved scenes mention this change."}
                  </p>
                ) : item.outcome?.state === "replayed" ? (
                  <p role="status" className="mt-1 text-[12.5px] text-ink">
                    Already applied — <span className="font-mono text-[11.5px]">{item.outcome.revisionId}</span> is still the current revision.
                  </p>
                ) : item.outcome ? (
                  <div className="mt-1.5">
                    <ErrorAlert view={item.outcome.envelope} lead="The change didn’t go through." testId={`story.request.${item.key}.status`} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

/** Before/after cell for one changed field (null renders only the "after" chip). */
function fieldText(summary: { action: string; narration: string; dialogue: string[] }, field: "action" | "narration" | "dialogue"): string | null {
  if (field === "action") return summary.action.length > 0 ? clip(summary.action) : null;
  if (field === "narration") return summary.narration.length > 0 ? clip(summary.narration) : null;
  return summary.dialogue.length > 0 ? clip(summary.dialogue.join(" · ")) : null;
}

const FIELD_NAMES: Record<"action" | "narration" | "dialogue", string> = {
  action: "what happens",
  narration: "narration",
  dialogue: "dialogue",
};

function fieldDisplayName(field: "action" | "narration" | "dialogue"): string {
  return FIELD_NAMES[field];
}

function plainBeatText(summary: { action: string; narration: string; dialogue: string[] }): string {
  const parts = [summary.action, summary.narration, ...summary.dialogue].filter((part) => part.trim().length > 0);
  return clip(parts.join(" — "));
}

function clip(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

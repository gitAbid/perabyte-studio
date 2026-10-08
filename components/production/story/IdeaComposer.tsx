"use client";

import { useState } from "react";
import { NaturalLanguageChangeBox } from "@/components/production/primitives/change";
import {
  ErrorAlert,
  NotEntitledNotice,
  TextEnginePicker,
  useEngineSelection,
} from "@/components/production/story/shared";
import {
  requestStoryProposal,
  useTextEngineCatalog,
  type StoryProposalCall,
} from "@/components/production/story/client";
import type { ErrorEnvelopeView, ProposalOutcome } from "@/components/production/project-canon";

/* ------------------------------------------------------------------ */
/* IdeaComposer — one-sentence idea → story draft proposal (spec 08 §5)*/
/* ------------------------------------------------------------------ */
/* The first step of the story flow: the creator types the idea, picks */
/* a writing engine, and the request goes through the EXISTING story   */
/* proposal API (kind "story", idea carried in scriptText, base        */
/* revision null). The outcome is reported exactly as the server       */
/* returns it — today that is the by-design 403 BUDGET_BLOCKED state.  */

export interface IdeaComposerProps {
  projectId: string;
  /** Active canon pins carried as expectedCanonRevisionIds. */
  canonRevisionIds: readonly string[];
}

const IDEA_MAX_CHARS = 2_000;

export function IdeaComposer({ projectId, canonRevisionIds }: IdeaComposerProps) {
  const catalog = useTextEngineCatalog(true);
  const [providerId, setProviderId] = useState("unconfigured");
  const [modelId, setModelId] = useState("unconfigured");
  useEngineSelection(catalog, providerId, modelId, setProviderId, setModelId);

  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ProposalOutcome | null>(null);
  const [invalidReason, setInvalidReason] = useState<string | null>(null);

  const enginesReady = !catalog.loading && catalog.engines.length > 0 && providerId !== "unconfigured" && modelId !== "unconfigured";

  async function handleSubmit(idea: string) {
    if (pending) return;
    setOutcome(null);
    setInvalidReason(null);
    if (!enginesReady) {
      setInvalidReason("Pick a writing engine first — configure one in Settings if the list is empty.");
      return;
    }
    setPending(true);
    try {
      const call: StoryProposalCall = await requestStoryProposal({
        projectId,
        providerId,
        modelId,
        scriptText: idea,
        expectedCanonRevisionIds: canonRevisionIds,
        expectedStoryRevisionId: null,
      });
      if (call.state === "invalid_command") {
        setInvalidReason(call.reason);
        return;
      }
      setOutcome(call.outcome);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Start your story" data-testid="story.idea" className="space-y-4">
      <header>
        <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Start your story</h2>
        <p className="mt-1 text-[13px] text-muted">
          Write your idea in one or two sentences. PeraByte drafts a full story from it — you review and approve before anything moves on.
        </p>
      </header>

      <div className="rounded-[12px] border border-border bg-raised p-5">
        <NaturalLanguageChangeBox
          label="Your story idea"
          placeholder="For example: “A shy harbor cat discovers a sleeping dragon under the pier…”"
          submitLabel="Generate story draft"
          maxChars={IDEA_MAX_CHARS}
          busy={pending}
          error={invalidReason ?? undefined}
          onSubmit={(idea) => void handleSubmit(idea)}
          testIdBase="story.idea.change"
        />
        <div className="mt-4">
          <TextEnginePicker
            loading={catalog.loading}
            engines={catalog.engines}
            providerId={providerId}
            modelId={modelId}
            onProviderChange={(next) => setProviderId(next)}
            onModelChange={(next) => setModelId(next)}
            testIdPrefix="story.engine"
            idPrefix="story-engine"
          />
        </div>
      </div>

      {outcome?.state === "saved" ? (
        <div role="status" data-testid="story.idea.status" className="rounded-[8px] border border-success/30 bg-success-soft/60 px-3.5 py-3 text-[13px] text-ink">
          Draft request accepted — proposal <span className="font-mono text-[12px]">{outcome.proposalId}</span>. Review it here before anything is applied; proposals never auto-apply.
        </div>
      ) : null}
      {outcome?.state === "not_entitled" ? <NotEntitledNotice testId="story.idea.status" /> : null}
      {outcome?.state === "invalid_success" ? (
        <div role="alert" data-testid="story.idea.status" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3 text-[13px] text-ink">
          The draft request returned an unexpected confirmation without a proposal ID (status {outcome.status ?? "unknown"}). Nothing was created.
        </div>
      ) : null}
      {outcome?.state === "failed" || outcome?.state === "network" ? (
        <ErrorAlert view={outcome.envelope as ErrorEnvelopeView} lead="The draft request didn’t go through." testId="story.idea.status" />
      ) : null}

      <p className="text-[12px] text-muted" data-testid="story.idea.entitled-note">
        {pending
          ? "Sending your idea…"
          : enginesReady
            ? "Your idea is sent as a story proposal — it never changes the story on its own."
            : "Choose a writing engine to enable the draft request."}
      </p>
    </section>
  );
}

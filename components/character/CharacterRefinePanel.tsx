"use client";

import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";
import { ApprovalBadge } from "@/components/production/primitives/approval";
import { NaturalLanguageChangeBox } from "@/components/production/primitives/change";
import { MediaPreview, type MediaPreviewState } from "@/components/production/primitives/media";
import type { ApprovalState } from "@/lib/production/approval-state";

/* ------------------------------------------------------------------ */
/* CharacterRefinePanel — spec 06 §5/§6, UX spec §7/§8                 */
/* ------------------------------------------------------------------ */
/* The universal refine block under the character sheet: who stays     */
/* locked (identity), what can change (the CharacterState concepts),   */
/* and the three universal re-generation actions in plain language —   */
/* "Try Again" (same setup), "More Like This" (this image leads the    */
/* next one), "Change Something" (describe the delta). Approval is     */
/* explicit: the badge shows the canon state, only the button sets it. */

/** The one image every refine action starts from (the selected identity). */
export interface RefineTarget {
  id: string;
  /** Human label of the source image, e.g. "Variant 2". */
  label: string;
  preview: MediaPreviewState;
}

/** Which refine action is currently running, if any. */
export type RefineAction = "try-again" | "more-like-this" | "change";

export interface CharacterApproval {
  /** Frozen approval vocabulary (CONTRACTS-FROZEN C8). */
  state: ApprovalState;
  /** Explicit user action only — omit while there is nothing to approve. */
  onApprove?: () => void;
  approveBusy?: boolean;
}

export interface CharacterRefinePanelProps {
  target: RefineTarget | null;
  busy: RefineAction | null;
  /** Plain-language failure from the last refine attempt. */
  error?: string | null;
  onTryAgain: () => void;
  onMoreLikeThis: () => void;
  /** Called with the trimmed instruction from the change box. */
  onChangeSubmit: (instruction: string) => void;
  approval?: CharacterApproval | null;
  testIdBase?: string;
  className?: string;
}

/**
 * What a refinement may touch, named after the shared CharacterState fields
 * (CONTRACTS-FROZEN C6): outfit, hair, expression, accessories, props,
 * condition, age presentation. Identity itself is never in the list — the
 * selected image anchors the face, so a jacket-only change cannot become a
 * different person.
 */
const CHANGEABLE_ASPECTS = [
  "Outfit",
  "Hair",
  "Expression",
  "Accessories",
  "Props",
  "Condition",
  "Age presentation",
] as const;

export function CharacterRefinePanel({
  target,
  busy,
  error,
  onTryAgain,
  onMoreLikeThis,
  onChangeSubmit,
  approval,
  testIdBase = "character.refine",
  className = "",
}: CharacterRefinePanelProps) {
  if (!target) return null;
  const locked = busy !== null;

  return (
    <section
      aria-label="Refine this character"
      data-testid={testIdBase}
      className={`flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-3 ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
          <Icon name="pen" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-bold text-ink">Refine this character</p>
          <p className="text-[11.5px] leading-tight text-muted">
            Every refinement starts from the selected image and keeps its own
            version — nothing is overwritten.
          </p>
        </div>
        {/* The source image every action below starts from. */}
        <div className="w-16 shrink-0">
          <MediaPreview
            state={target.preview}
            ratio="4 / 5"
            fit="cover"
            rounded="md"
            testId={`${testIdBase}.source`}
          />
        </div>
      </div>

      {/* Identity guard: what stays locked vs what a change may touch. */}
      <div className="rounded-[10px] border border-border bg-raised px-2.5 py-2">
        <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-soft">
          <Icon name="lock" size={13} className="mt-0.5 shrink-0 text-primary" />
          <span>
            <span className="font-bold text-ink">Stays the same:</span> the face
            and body — the selected image anchors who this is.
          </span>
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11.5px] leading-snug text-muted">
          <span className="font-semibold text-ink-soft">Can change:</span>
          {CHANGEABLE_ASPECTS.map((aspect) => (
            <span
              key={aspect}
              className="rounded-full border border-border bg-surface px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-soft"
            >
              {aspect}
            </span>
          ))}
        </p>
      </div>

      {/* Universal refine actions (spec 06 §5; retry rules in spec 02 §8). */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="secondary"
          icon="refresh"
          disabled={locked}
          onClick={onTryAgain}
          data-testid={`${testIdBase}.try-again`}
        >
          Try Again
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon="sparkle"
          disabled={locked}
          onClick={onMoreLikeThis}
          data-testid={`${testIdBase}.more-like-this`}
        >
          More Like This
        </Button>
      </div>
      <p className="-mt-1 text-[11px] leading-snug text-muted">
        <span className="font-semibold text-ink-soft">Try Again</span> re-renders
        with the exact same setup.{" "}
        <span className="font-semibold text-ink-soft">More Like This</span>{" "}
        follows the selected image closely.
      </p>

      <NaturalLanguageChangeBox
        label="Change Something"
        placeholder="Describe the change — for example, “swap the jacket for a red leather one”. Everything else stays as-is."
        submitLabel="Generate change"
        busy={busy === "change"}
        error={error ?? undefined}
        onSubmit={onChangeSubmit}
        testIdBase={`${testIdBase}.change`}
      />

      {/* Canon approval — C8: only this explicit button ever approves. */}
      {approval && (
        <div
          data-testid={`${testIdBase}.approval`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-border bg-raised px-2.5 py-2"
        >
          <ApprovalBadge state={approval.state} testId="character.approval" />
          {approval.state === "approved" ? (
            <p className="flex items-center gap-1 text-[11.5px] font-semibold text-success">
              <Icon name="check" size={13} />
              Locked in as the character's look.
            </p>
          ) : (
            approval.onApprove && (
              <Button
                size="sm"
                icon="check"
                loading={approval.approveBusy}
                onClick={approval.onApprove}
                data-testid="character.approve"
              >
                Approve
              </Button>
            )
          )}
        </div>
      )}
    </section>
  );
}

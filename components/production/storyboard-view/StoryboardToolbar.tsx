"use client";

/**
 * StoryboardToolbar — the board header (spec 09 §6): title, stale summary, the
 * "Continue movement" preference (OFF by default per spec §8), reload and navigation
 * including the Wave-3 placeholder link to /first-cut.
 */

import { Badge, Button, LinkButton, Toggle } from "@/components/ui";

export interface StoryboardToolbarProps {
  projectId: string;
  projectName: string;
  staleCount: number;
  continueMovement: boolean;
  onContinueMovementChange: (next: boolean) => void;
  onReload: () => void;
  reloading: boolean;
}

const CONTINUE_MOVEMENT_NOTE =
  "New shots try to start from the previous scene’s final frame instead of a fresh image.";

export function StoryboardToolbar({
  projectId,
  projectName,
  staleCount,
  continueMovement,
  onContinueMovementChange,
  onReload,
  reloading,
}: StoryboardToolbarProps) {
  return (
    <header className="border-b border-border pb-4" data-testid="storyboard.toolbar">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
            Studio / Production / {projectName} / Storyboard
          </p>
          <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Storyboard</h1>
          <p className="mt-1 text-[12px] text-muted">
            Plan the film scene by scene. Review each scene’s shots, anchor them so faces and places stay consistent, then approve.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon="refresh" loading={reloading} onClick={onReload} data-testid="storyboard.reload">
            Reload
          </Button>
          <LinkButton href={`/production/${projectId}`} size="sm" variant="secondary" icon="arrow-left" data-testid="storyboard.overview-link">
            Overview
          </LinkButton>
          <LinkButton href={`/production/${projectId}/story`} size="sm" variant="ghost" icon="story" data-testid="storyboard.story-link">
            Story
          </LinkButton>
          <LinkButton href="/first-cut" size="sm" variant="secondary" icon="play" data-testid="storyboard.continue-first-cut">
            Continue to first cut
          </LinkButton>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div data-testid="storyboard.stale-summary" data-count={staleCount} role={staleCount > 0 ? "status" : undefined}>
          {staleCount > 0 ? (
            <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
              <Badge tone="warning">{staleCount} shot{staleCount === 1 ? "" : "s"} stale</Badge>
              <span className="text-ink-soft">
                The story changed since these were planned. Re-anchor them so they match the current story.
              </span>
            </p>
          ) : (
            <p className="text-[13px] text-ink-soft">Everything matches the current story — nothing is stale.</p>
          )}
        </div>
        <div
          className="w-full max-w-md rounded-[10px] border border-border bg-surface px-3.5 py-3"
          data-testid="storyboard.continue-movement"
          title={CONTINUE_MOVEMENT_NOTE}
        >
          <Toggle
            label="Continue movement from previous scene"
            description={CONTINUE_MOVEMENT_NOTE}
            checked={continueMovement}
            onChange={onContinueMovementChange}
          />
        </div>
      </div>
    </header>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { estimateAutoRunCost } from "@/lib/production/auto-run-estimate";
import type { AutoRun, AutoRunStage } from "@/lib/production/contracts";

/**
 * Auto Draft panel (spec 14 §6): idea + duration + quality + an honest
 * preflight estimate → explicit confirm → live stage status with deep links
 * to whatever needs a human. Nothing here auto-approves: stages that need the
 * creator park at `awaiting_review` and the buttons take them there.
 */

const PRIMARY = "inline-flex items-center justify-center gap-1.5 rounded-[8px] px-3.5 py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 bg-primary-strong text-white hover:bg-primary-dark";
const SECONDARY = "inline-flex items-center justify-center gap-1.5 rounded-[8px] border border-border-strong bg-raised px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-surface disabled:opacity-50";
const BADGE = "inline-flex items-center rounded-[5px] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]";

const STAGE_LABELS: Record<AutoRunStage["kind"], string> = {
  story: "Story draft",
  storyboard: "Storyboard",
  anchors: "Anchors (you approve)",
  takes: "Takes (you select)",
  audio: "Audio",
  assembly: "First cut",
};

const STATE_STYLES: Record<AutoRunStage["state"], string> = {
  pending: "bg-ink/5 text-ink-soft",
  queued: "bg-accent-soft text-accent",
  running: "bg-primary-soft text-primary",
  completed: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
  canceled: "bg-ink/5 text-muted",
  skipped: "bg-ink/5 text-muted",
};

const STAGE_LINKS: Partial<Record<AutoRunStage["kind"], string>> = {
  anchors: "storyboard",
  takes: "storyboard",
  assembly: "first-cut",
};

function microsToUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

export function AutoRunPanel({ projectId, initialRuns }: { projectId: string; initialRuns: AutoRun[] }) {
  const router = useRouter();
  const [runs, setRuns] = useState<AutoRun[]>(initialRuns);
  const [idea, setIdea] = useState("");
  const [duration, setDuration] = useState(120_000);
  const [quality, setQuality] = useState<"economy" | "balanced" | "best">("balanced");
  const [phase, setPhase] = useState<"idle" | "creating" | "working">("idle");
  const [error, setError] = useState<string | null>(null);
  const estimate = useMemo(() => estimateAutoRunCost({ durationTargetMs: duration, qualityStrategy: quality }), [duration, quality]);
  const active = useMemo(() => runs.find((run) => run.state === "running" || run.state === "awaiting_review" || run.state === "awaiting_confirmation") ?? null, [runs]);

  async function call(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(path, { cache: "no-store", ...init });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
      throw new Error(typeof message === "string" ? message : `The request failed (${response.status}).`);
    }
    return payload;
  }

  async function createRun() {
    if (idea.trim().length === 0) return;
    setPhase("creating");
    setError(null);
    try {
      const payload = (await call(`/api/production/projects/${projectId}/auto-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, idea: idea.trim(), durationTargetMs: duration, qualityStrategy: quality }),
      })) as { run?: AutoRun };
      if (payload.run) setRuns((previous) => [payload.run!, ...previous]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The run could not be created.");
    } finally {
      setPhase("idle");
    }
  }

  async function act(run: AutoRun, action: "confirm" | "advance" | "cancel") {
    setPhase("working");
    setError(null);
    try {
      const payload = (await call(`/api/production/auto-runs/${run.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      })) as { run?: AutoRun };
      if (payload.run) setRuns((previous) => previous.map((entry) => (entry.id === payload.run!.id ? payload.run! : entry)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setPhase("idle");
    }
  }

  const durationOptions = [
    { label: "~1 min", value: 60_000 },
    { label: "~2 min", value: 120_000 },
    { label: "~4 min", value: 240_000 },
  ];

  return (
    <div className="mt-5 flex flex-col gap-5">
      {!active && (
        <section className="rounded-[12px] border border-border bg-surface p-5" data-testid="auto-run.preflight">
          <h2 className="text-[13px] font-bold text-ink">Start a draft</h2>
          <label className="mt-3 block text-[12px] font-semibold text-muted" htmlFor="auto-run-idea">
            Your idea — one sentence is enough
          </label>
          <textarea
            id="auto-run-idea"
            className="mt-1.5 w-full rounded-[8px] border border-border-strong bg-raised px-3 py-2.5 text-[13.5px] leading-relaxed text-ink focus:border-primary focus:outline-none"
            rows={3}
            maxLength={5000}
            placeholder="A lighthouse keeper befriends a storm that keeps stealing the light."
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            data-testid="auto-run.idea"
          />
          <div className="mt-3 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-[12px] font-semibold text-muted" htmlFor="auto-run-duration">
              Duration
              <select id="auto-run-duration" className="rounded-[7px] border border-border bg-raised px-2 py-1.5 text-[12.5px] text-ink" value={duration}
                onChange={(event) => setDuration(Number(event.target.value))} data-testid="auto-run.duration">
                {durationOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-[12px] font-semibold text-muted" htmlFor="auto-run-quality">
              Quality
              <select id="auto-run-quality" className="rounded-[7px] border border-border bg-raised px-2 py-1.5 text-[12.5px] text-ink" value={quality}
                onChange={(event) => setQuality(event.target.value as typeof quality)} data-testid="auto-run.quality">
                <option value="economy">Economy</option>
                <option value="balanced">Balanced</option>
                <option value="best">Best</option>
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-border bg-raised px-3 py-2.5" data-testid="auto-run.estimate">
            <p className="text-[12px] text-muted">
              Estimated spend (coarse, confirmed per step): <span className="font-semibold text-ink">{microsToUsd(estimate.minMicros)}–{microsToUsd(estimate.maxMicros)}</span> for a {duration / 60_000}-minute {quality} run — visuals are the cost; every paid step still asks the budget gate first.
            </p>
            <button type="button" className={PRIMARY} disabled={idea.trim().length === 0 || phase !== "idle"} onClick={() => void createRun()} data-testid="auto-run.create">
              {phase === "creating" ? "Creating…" : "Create draft run"}
            </button>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-[8px] border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger" data-testid="auto-run.error">
          {error}
        </p>
      )}

      {runs.map((run) => (
        <section key={run.id} className="rounded-[12px] border border-border bg-surface p-5" data-testid="auto-run.run" data-state={run.state}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-[14px] font-bold text-ink">“{run.idea.length > 80 ? `${run.idea.slice(0, 80)}…` : run.idea}”</p>
              <p className="mt-0.5 text-[12px] text-muted">
                {run.durationTargetMs / 1000}s · {run.qualityStrategy} · estimated {run.estimatedCost ? `${microsToUsd(run.estimatedCost.minMicros)}–${microsToUsd(run.estimatedCost.maxMicros)}` : "—"}
              </p>
            </div>
            <span className={`${BADGE} ${run.state === "completed" ? "bg-success-soft text-success" : run.state === "failed" || run.state === "canceled" ? "bg-ink/5 text-muted" : "bg-accent-soft text-accent"}`} data-testid="auto-run.state">
              {run.state.replace(/_/g, " ")}
            </span>
          </div>

          <ol className="mt-4 flex flex-col gap-2">
            {run.stages.map((stage) => {
              const link = STAGE_LINKS[stage.kind];
              return (
                <li key={stage.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-border bg-raised px-3 py-2" data-testid="auto-run.stage" data-kind={stage.kind} data-state={stage.state}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={`${BADGE} ${STATE_STYLES[stage.state]}`}>{stage.state}</span>
                    <span className="text-[13px] font-semibold text-ink">{STAGE_LABELS[stage.kind]}</span>
                    {stage.error ? <span className="truncate text-[12px] text-muted">{stage.error}</span> : null}
                  </div>
                  {link && (stage.state === "running" || stage.state === "queued") ? (
                    <Link href={link === "first-cut" ? "/first-cut" : `/production/${projectId}/${link}`} className="text-[12px] font-semibold text-primary hover:underline">
                      Open {STAGE_LABELS[stage.kind].split(" (")[0].toLowerCase()} →
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="mt-4 flex flex-wrap gap-2">
            {run.state === "awaiting_confirmation" && (
              <button type="button" className={PRIMARY} disabled={phase !== "idle"} onClick={() => void act(run, "confirm")} data-testid="auto-run.confirm">
                {phase === "working" ? "Starting…" : "Confirm and start"}
              </button>
            )}
            {run.state === "running" && (
              <button type="button" className={SECONDARY} disabled={phase !== "idle"} onClick={() => void act(run, "advance")} data-testid="auto-run.advance">
                {phase === "working" ? "Checking…" : "Continue run"}
              </button>
            )}
            {run.state === "awaiting_review" && (
              <>
                <button type="button" className={PRIMARY} disabled={phase !== "idle"} onClick={() => void act(run, "advance")} data-testid="auto-run.advance">
                  {phase === "working" ? "Checking…" : "I've reviewed — continue"}
                </button>
                <button type="button" className={SECONDARY} onClick={() => router.push(`/production/${projectId}/story`)} data-testid="auto-run.review-link">
                  Review what needs you
                </button>
              </>
            )}
            {run.state !== "completed" && run.state !== "canceled" && (
              <button type="button" className={SECONDARY} disabled={phase !== "idle"} onClick={() => void act(run, "cancel")} data-testid="auto-run.cancel">
                Cancel run
              </button>
            )}
          </div>
        </section>
      ))}

      {runs.length === 0 && !active && (
        <p className="text-[12.5px] text-muted" data-testid="auto-run.empty">
          No runs yet. Write your idea above — the draft stays free (built-in engines), and nothing is spent until you confirm the estimate.
        </p>
      )}
    </div>
  );
}

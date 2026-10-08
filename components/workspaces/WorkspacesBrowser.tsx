"use client";

/**
 * /workspaces — workspace list (feature spec 05, route table).
 * Client component: fetches GET /api/workspaces, handles loading, error and
 * teaching empty states (UX spec §5), and renders one card per workspace.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, LinkButton, formatDate, formatTime } from "@/components/ui";
import { EmptyState as TeachingEmptyState } from "@/components/production/primitives/empty-state";
import { formatFailure, loadWorkspaces, type RequestFailure } from "./api";
import type { Workspace } from "@/lib/production/contracts";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; failure: RequestFailure }
  | { kind: "ready"; workspaces: Workspace[] };

export function WorkspacesBrowser() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let stopped = false;
    setPhase({ kind: "loading" });
    void loadWorkspaces().then((result) => {
      if (stopped) return;
      if (result.ok) setPhase({ kind: "ready", workspaces: result.workspaces });
      else setPhase({ kind: "error", failure: result.failure });
    });
    return () => {
      stopped = true;
    };
  }, [reloadToken]);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="workspaces.list.page">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Studio / Workspaces</p>
          <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">Workspaces</h1>
          <p className="mt-1 max-w-xl text-[12.5px] text-muted">
            A workspace is one show&apos;s home: its characters, its places, its rules, and the recipe every
            episode follows. Everything you make inside stays consistent.
          </p>
        </div>
        {(phase.kind !== "ready" || phase.workspaces.length > 0) && (
          <LinkButton href="/workspaces/new" size="sm" icon="plus" data-testid="workspaces.workspace.new">
            New workspace
          </LinkButton>
        )}
      </header>

      {phase.kind === "loading" ? (
        <div role="status" data-testid="workspaces.list.loading" className="mt-6 rounded-[12px] border border-border bg-raised px-6 py-14 text-center text-sm text-muted">
          Loading workspaces…
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className="mt-6 space-y-4" data-testid="workspaces.list.error">
          <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
            <p className="text-[13px] font-bold text-ink">The workspace list could not be loaded.</p>
            <p className="mt-1 text-[13px] leading-snug text-ink">{formatFailure(phase.failure)}</p>
            <p className="mt-1 text-[12px] text-muted">Nothing was changed — you can retry.</p>
          </div>
          <Button variant="secondary" size="sm" icon="refresh" onClick={reload} data-testid="workspaces.list.retry">
            Retry
          </Button>
        </div>
      ) : null}

      {phase.kind === "ready" && phase.workspaces.length === 0 ? (
        <div className="mt-6" data-testid="workspaces.list.empty">
          <TeachingEmptyState
            icon="layers"
            title="No workspaces yet"
            body="A workspace keeps one show's characters, places, and world rules together, so every episode looks and feels the same. Start with one show — you can add more anytime."
            action={
              <LinkButton href="/workspaces/new" icon="plus" data-testid="workspaces.workspace.new.empty">
                Create your first workspace
              </LinkButton>
            }
            testId="workspaces.list.empty.state"
          />
        </div>
      ) : null}

      {phase.kind === "ready" && phase.workspaces.length > 0 ? (
        <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="workspaces.list.cards">
          {phase.workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link
                href={`/workspaces/${workspace.id}`}
                data-testid="workspaces.workspace.open"
                className="flex h-full flex-col gap-2.5 rounded-[12px] border border-border bg-raised p-5 shadow-card transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                <span className="flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-bold text-ink">{workspace.name}</span>
                    <span className="mt-0.5 block text-[11.5px] text-muted">
                      Updated {formatDate(workspace.updatedAt)} {formatTime(workspace.updatedAt)}
                    </span>
                  </span>
                  <Badge tone={workspace.rating === "General" ? "success" : workspace.rating === "Mature" ? "warning" : "danger"}>
                    {workspace.rating}
                  </Badge>
                </span>
                <span className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
                  <span>{workspace.characterCanonIds.length} character{workspace.characterCanonIds.length === 1 ? "" : "s"}</span>
                  <span>{workspace.environmentCanonIds.length} environment{workspace.environmentCanonIds.length === 1 ? "" : "s"}</span>
                  <span>{workspace.worldBible.entries.length} world rule{workspace.worldBible.entries.length === 1 ? "" : "s"}</span>
                </span>
                <span className="mt-auto flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <span className="rounded-[5px] bg-surface-2 px-2 py-0.5 font-semibold text-ink-soft">
                    {workspace.productionRecipe.aspectRatio}
                  </span>
                  <span className="rounded-[5px] bg-surface-2 px-2 py-0.5 font-semibold text-ink-soft">
                    {QUALITY_LABELS[workspace.productionRecipe.qualityStrategy]}
                  </span>
                  <span>{workspace.productionRecipe.language}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const QUALITY_LABELS = { economy: "Economy", balanced: "Balanced", best: "Best" } as const;

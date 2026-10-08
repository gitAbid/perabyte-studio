"use client";

/**
 * Canon membership picker (feature spec 05 §5 "Select Characters/Environments").
 * Reuses the production canon read APIs read-only (see ./api.ts) and manages a
 * DRAFT membership set; the parent builds the PATCH command from it. Fully
 * keyboard-accessible: every membership change is a real button with
 * aria-pressed, so no hover-only actions (UX spec §9).
 */

import { useMemo, useState } from "react";
import { Button, LinkButton } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { formatFailure, type CanonEntityOption, type RequestFailure } from "./api";

export type CanonMembershipPickerProps = {
  /** Already filtered to this picker's canon kind. */
  options: CanonEntityOption[];
  selectedIds: string[];
  onToggle: (entityId: string) => void;
  loading: boolean;
  failure: RequestFailure | null;
  incomplete: boolean;
  onRetryOptions: () => void;
  entityNoun: string;
  entityNounPlural: string;
  createHref: string;
  createLabel: string;
  emptyBody: string;
  testPrefix: string;
};

export function CanonMembershipPicker({
  options,
  selectedIds,
  onToggle,
  loading,
  failure,
  incomplete,
  onRetryOptions,
  entityNoun,
  entityNounPlural,
  createHref,
  createLabel,
  emptyBody,
  testPrefix,
}: CanonMembershipPickerProps) {
  const [filter, setFilter] = useState("");
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter(
      (option) => option.description.toLowerCase().includes(needle) || option.entityId.toLowerCase().includes(needle),
    );
  }, [filter, options]);

  const resolvedById = useMemo(() => new Map(options.map((option) => [option.entityId, option])), [options]);

  if (loading) {
    return (
      <div role="status" data-testid={`${testPrefix}.loading`} className="rounded-[8px] border border-border bg-surface px-3.5 py-6 text-center text-sm text-muted">
        Loading your {entityNounPlural}…
      </div>
    );
  }

  if (failure) {
    return (
      <div className="space-y-3" data-testid={`${testPrefix}.error`}>
        <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
          <p className="text-[13px] font-bold text-ink">Your {entityNounPlural} could not be loaded.</p>
          <p className="mt-1 text-[13px] leading-snug text-ink">{formatFailure(failure)}</p>
        </div>
        <Button variant="secondary" size="sm" icon="refresh" onClick={onRetryOptions} data-testid={`${testPrefix}.retry`}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {selectedIds.length > 0 ? (
        <div>
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
            In this workspace ({selectedIds.length})
          </p>
          <ul className="mt-2 flex flex-wrap gap-2" data-testid={`${testPrefix}.members`}>
            {selectedIds.map((entityId) => {
              const resolved = resolvedById.get(entityId);
              return (
                <li key={entityId}>
                  <button
                    type="button"
                    onClick={() => onToggle(entityId)}
                    aria-pressed={true}
                    title={`Remove ${resolved?.description ?? entityId} from this workspace`}
                    className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/40 bg-primary-soft px-3 py-1.5 text-[12.5px] font-semibold text-primary transition-colors hover:border-primary"
                    data-testid={`${testPrefix}.member.remove`}
                  >
                    <span className="max-w-[220px] truncate">{resolved?.description ?? entityId}</span>
                    {!resolved ? <span className="text-[10px] uppercase tracking-[0.08em]">(reference not found)</span> : null}
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p role="status" data-testid={`${testPrefix}.members.empty`} className="text-[13px] text-muted">
          No {entityNounPlural} in this workspace yet — pick from your library below or create one.
        </p>
      )}

      {options.length === 0 && selectedIds.length === 0 ? (
        <EmptyState
          icon={entityNoun === "character" ? "character" : "image"}
          title={`No ${entityNounPlural} yet`}
          body={emptyBody}
          action={
            <LinkButton href={createHref} variant="secondary" size="sm" icon="plus" data-testid={`${testPrefix}.create`}>
              {createLabel}
            </LinkButton>
          }
          testId={`${testPrefix}.empty`}
        />
      ) : options.length === 0 ? (
        <p role="note" className="text-[12.5px] text-muted">
          The saved {entityNoun} references above still work. Their library details could not be read right now,
          so they cannot be edited from this page.
        </p>
      ) : (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
              Your library — click to add or remove
            </p>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Filter ${entityNounPlural}…`}
              aria-label={`Filter ${entityNounPlural}`}
              className="h-9 w-48 rounded-[8px] border border-border-strong bg-raised px-3 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none"
              data-testid={`${testPrefix}.filter`}
            />
          </div>
          {visible.length === 0 ? (
            <p role="status" className="mt-2 text-[13px] text-muted">
              No {entityNounPlural} match “{filter.trim()}”.
            </p>
          ) : (
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid={`${testPrefix}.options`}>
              {visible.map((option) => {
                const active = selected.has(option.entityId);
                return (
                  <li key={option.entityId}>
                    <button
                      type="button"
                      onClick={() => onToggle(option.entityId)}
                      aria-pressed={active}
                      className={`flex h-full w-full flex-col items-start gap-1 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
                        active ? "border-primary bg-primary-soft/60" : "border-border bg-raised hover:border-border-strong"
                      }`}
                      data-testid={`${testPrefix}.toggle`}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{option.description}</span>
                        <span
                          aria-hidden="true"
                          className={`shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${
                            active ? "bg-primary-strong text-white" : "bg-surface-2 text-ink-soft"
                          }`}
                        >
                          {active ? "In" : "Add"}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[12px] leading-snug text-muted">{option.entityId}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {incomplete ? (
        <p role="note" className="text-[12px] text-muted" data-testid={`${testPrefix}.incomplete`}>
          Some productions could not be read, so this list may be missing entries. Saved references below still
          work — reload later to see the full library.
        </p>
      ) : null}
    </div>
  );
}

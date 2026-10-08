"use client";

/**
 * World Bible entry editor (feature spec 05 / CONTRACTS-FROZEN C3).
 * Controlled form for ONE world-bible entry (title, body, tags). The parent
 * owns the entry list and the save command; this component validates a single
 * entry against the shared bounds and reports it back via onSave/onRemove.
 */

import { useId, useState } from "react";
import { Button, FieldShell } from "@/components/ui";
import {
  WORLD_BIBLE_BODY_MAX,
  WORLD_BIBLE_TAGS_MAX,
  WORLD_BIBLE_TITLE_MAX,
} from "./api";
import type { WorldBibleEntry } from "@/lib/production/contracts";

/** Editor draft for one entry; tags stay comma-separated text while typing. */
export type WorldBibleEntryDraft = {
  /** Present for existing entries; "" for a brand-new one (assigned on save). */
  id: string;
  title: string;
  body: string;
  tagsText: string;
};

/** Pure: build an editor draft from a contract entry. */
export function draftFromEntry(entry: WorldBibleEntry): WorldBibleEntryDraft {
  return { id: entry.id, title: entry.title, body: entry.body, tagsText: entry.tags.join(", ") };
}

/** Pure: draft -> contract-shaped entry, or null when required text is blank. */
export function entryFromDraft(draft: WorldBibleEntryDraft): WorldBibleEntry | null {
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (title.length < 1 || title.length > WORLD_BIBLE_TITLE_MAX) return null;
  if (body.length < 1 || body.length > WORLD_BIBLE_BODY_MAX) return null;
  const tags = parseTags(draft.tagsText);
  if (tags === null) return null;
  return { id: draft.id.length > 0 ? draft.id : newEntryId(), title, body, tags };
}

/** Pure: comma-separated tag text -> tags array (max 20), or null when over the bound. */
export function parseTags(tagsText: string): string[] | null {
  const tags = tagsText.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return tags.length > WORLD_BIBLE_TAGS_MAX ? null : tags;
}

/** A fresh, contract-valid entry id (IdSchema allows UUID shapes). */
export function newEntryId(): string {
  return crypto.randomUUID();
}

/** Pure validation for the save button state and inline messages. */
export function entryDraftIssues(draft: WorldBibleEntryDraft): string[] {
  const issues: string[] = [];
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (title.length < 1) issues.push("Give the rule a short title.");
  else if (title.length > WORLD_BIBLE_TITLE_MAX) issues.push(`Keep the title under ${WORLD_BIBLE_TITLE_MAX} characters.`);
  if (body.length < 1) issues.push("Describe the rule.");
  else if (body.length > WORLD_BIBLE_BODY_MAX) issues.push(`Keep the rule under ${WORLD_BIBLE_BODY_MAX} characters.`);
  if (parseTags(draft.tagsText) === null) issues.push(`Use at most ${WORLD_BIBLE_TAGS_MAX} tags.`);
  return issues;
}

export function WorldBibleEntryEditor({
  heading,
  draft,
  onSave,
  onCancel,
  onRemove,
  testPrefix,
}: {
  heading: string;
  draft: WorldBibleEntryDraft;
  onSave: (entry: WorldBibleEntry) => void;
  onCancel: () => void;
  /** Present only when editing an existing entry. */
  onRemove?: () => void;
  testPrefix: string;
}) {
  const [current, setCurrent] = useState<WorldBibleEntryDraft>(draft);
  const titleId = useId();
  const bodyId = useId();
  const tagsId = useId();
  const issues = entryDraftIssues(current);
  const valid = issues.length === 0;

  function save() {
    const entry = entryFromDraft(current);
    if (entry) onSave(entry);
  }

  return (
    <div className="space-y-4 rounded-[10px] border border-border-strong bg-surface p-4" data-testid={`${testPrefix}.editor`}>
      <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">{heading}</p>

      <FieldShell
        label="Title"
        htmlFor={titleId}
        hint={`A short name for this rule, up to ${WORLD_BIBLE_TITLE_MAX} characters.`}
        counter={`${current.title.trim().length}/${WORLD_BIBLE_TITLE_MAX}`}
      >
        <input
          id={titleId}
          value={current.title}
          maxLength={WORLD_BIBLE_TITLE_MAX}
          onChange={(event) => setCurrent({ ...current, title: event.target.value })}
          className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          data-testid={`${testPrefix}.title`}
        />
      </FieldShell>

      <FieldShell
        label="The rule"
        htmlFor={bodyId}
        hint="What must stay true in every episode — look, behavior, place, or tone."
        counter={`${current.body.trim().length}/${WORLD_BIBLE_BODY_MAX}`}
      >
        <textarea
          id={bodyId}
          rows={4}
          value={current.body}
          maxLength={WORLD_BIBLE_BODY_MAX}
          onChange={(event) => setCurrent({ ...current, body: event.target.value })}
          className="w-full resize-y rounded-[8px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm leading-relaxed text-ink focus:border-primary focus:outline-none"
          data-testid={`${testPrefix}.body`}
        />
      </FieldShell>

      <FieldShell
        label="Tags"
        htmlFor={tagsId}
        hint={`Optional, comma-separated labels, up to ${WORLD_BIBLE_TAGS_MAX}.`}
        error={parseTags(current.tagsText) === null ? `Use at most ${WORLD_BIBLE_TAGS_MAX} tags.` : undefined}
      >
        <input
          id={tagsId}
          value={current.tagsText}
          onChange={(event) => setCurrent({ ...current, tagsText: event.target.value })}
          className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
          data-testid={`${testPrefix}.tags`}
        />
      </FieldShell>

      {issues.length > 0 ? (
        <ul role="alert" className="space-y-1 text-[12.5px] text-danger" data-testid={`${testPrefix}.issues`}>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="check" disabled={!valid} onClick={save} data-testid={`${testPrefix}.confirm`}>
          {draft.id.length > 0 ? "Update rule" : "Add rule to list"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {onRemove ? (
          <Button size="sm" variant="danger" icon="trash" onClick={onRemove} data-testid={`${testPrefix}.remove`}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

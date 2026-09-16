"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui";

/**
 * Tag editor for one library item: edit a chip list, save the whole array
 * back. Used by all three libraries (characters store top-level tags,
 * images/stories store `meta.tags` — pages translate before/after).
 */
export function TagEditorDialog({
  open,
  title,
  initial = [],
  onSave,
  onCancel,
}: {
  open: boolean;
  title: string;
  initial?: string[];
  onSave(tags: string[]): void;
  onCancel(): void;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (open) {
      setTags(initial);
      setDraft("");
    }
  }, [open, initial]);

  function addDraft() {
    const tag = draft.trim().toLowerCase();
    if (!tag) return;
    if (!tags.includes(tag)) setTags([...tags, tag]);
    setDraft("");
  }

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-[20px] border border-border bg-raised p-6 shadow-lift">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTags(tags.filter((t) => t !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
              >
                {tag}
                <Icon name="close" size={11} />
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={draft}
          autoFocus
          placeholder="Add a tag and press Enter"
          aria-label="New tag"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
            if (e.key === "Escape") onCancel();
          }}
          className="mt-3 h-11 w-full rounded-[12px] border border-border-strong bg-surface px-3 text-sm font-medium text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(tags)}>
            Save tags
          </Button>
        </div>
      </div>
    </div>
  );
}

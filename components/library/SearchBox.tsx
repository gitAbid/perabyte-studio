"use client";

import { Icon } from "@/components/Icon";

/**
 * The one library search box (spec 16 §5 "Filter/search"). Controlled input:
 * the explorer owns the query and filters the already-loaded set client-side
 * (Alpha-basic search). A clear affordance appears only while there is text,
 * and the whole box is keyboard-reachable.
 */
export function SearchBox({
  value,
  onChange,
  placeholder = "Search everything…",
  testId = "library.search",
}: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  testId?: string;
}) {
  const hasText = value.trim().length > 0;
  return (
    <div data-testid={testId} className="relative w-full lg:max-w-[420px]">
      <Icon
        name="search"
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="Search the library"
        data-testid={`${testId}.input`}
        className="h-11 w-full rounded-[5px] border border-border bg-raised pl-10 pr-9 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
      />
      {hasText && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          data-testid={`${testId}.clear`}
          className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { Icon } from "./Icon";
import { useActiveJobs } from "@/lib/job-store";

/**
 * Live renders badge in the sidebar (Phase B). Shows while server jobs are
 * in flight, wherever you are in the studio — renders survive navigation,
 * and this is how you find your way back. Clicking jumps to the origin
 * page of the oldest active job.
 */
export function RendersTray({ collapsed = false }: { collapsed?: boolean }) {
  const { items } = useActiveJobs();
  if (!items.length) return null;

  const first = items[0];
  const running = items.filter((job) => job.status === "running").length;
  const percent = first.percent;
  const label =
    items.length === 1
      ? running
        ? (first.message ?? "Rendering…")
        : "Queued…"
      : `${items.length} renders in queue`;

  if (collapsed) {
    return (
      <Link
        href={first.href}
        aria-label={`${items.length} active render${items.length === 1 ? "" : "s"}`}
        title={label}
        className="relative grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary transition-colors hover:bg-primary hover:text-white"
      >
        <Icon name="sparkle" size={18} className="animate-pulse" />
        <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-primary text-[9.5px] font-bold text-white">
          {items.length}
        </span>
      </Link>
    );
  }

  return (
    <Link
      href={first.href}
      className="flex w-full items-center gap-2.5 rounded-[12px] border border-border bg-surface px-3 py-2 transition-colors hover:border-primary"
    >
      <Icon name="sparkle" size={16} className="shrink-0 animate-pulse text-primary" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12px] font-semibold text-ink">
          {label}
        </span>
        {typeof percent === "number" ? (
          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-700"
              style={{ width: `${Math.max(4, Math.min(100, percent))}%` }}
            />
          </span>
        ) : (
          <span className="block text-[10.5px] text-muted">
            {running > 0 ? "Rendering on the server" : "Waiting in queue"}
          </span>
        )}
      </span>
    </Link>
  );
}

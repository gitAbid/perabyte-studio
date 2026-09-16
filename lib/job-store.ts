"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Live view of the server's active render jobs (Phase B). One poller per
 * tab regardless of which page is open — this is what makes renders visible
 * everywhere and lets the RendersTray survive navigation. Polling starts on
 * first subscriber and stops when the last one leaves.
 */

export interface ActiveJobItem {
  id: string;
  kind: "image" | "video";
  status: "queued" | "running";
  /** Latest provider tick, when the job has one. */
  message?: string;
  percent?: number;
  /** Where the render came from — the tray links back there. */
  href: string;
}

interface JobStoreState {
  items: ActiveJobItem[];
  loaded: boolean;
}

const EMPTY: JobStoreState = { items: [], loaded: false };

let cache: JobStoreState | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function hrefFor(job: { kind: "image" | "video"; clientTag?: string }): string {
  const tag = job.clientTag ?? "";
  const storyMatch = tag.match(/^(s_[^:]+):/);
  if (storyMatch) return `/story?id=${storyMatch[1]}`;
  return job.kind === "video" ? "/generate/video" : "/generate/image";
}

async function poll() {
  try {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as {
      jobs?: {
        id: string;
        kind: "image" | "video";
        status: "queued" | "running";
        progress?: { message?: string; percent?: number };
        clientTag?: string;
      }[];
    };
    const items: ActiveJobItem[] = (data.jobs ?? []).map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      ...(job.progress?.message ? { message: job.progress.message } : {}),
      ...(typeof job.progress?.percent === "number" ? { percent: job.progress.percent } : {}),
      href: hrefFor(job),
    }));
    cache = { items, loaded: true };
    emit();
  } catch {
    // Server unreachable — keep the last known state; the next tick retries.
  }
}

function ensurePolling() {
  if (pollTimer) return;
  void poll();
  pollTimer = setInterval(() => void poll(), 4_000);
}

function stopPolling() {
  if (pollTimer && listeners.size === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
    cache = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ensurePolling();
  return () => {
    listeners.delete(listener);
    stopPolling();
  };
}

function getSnapshot(): JobStoreState {
  return cache ?? EMPTY;
}

export function useActiveJobs(): JobStoreState {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

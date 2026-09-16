"use client";

import { useEffect } from "react";
import { ensureStoreHydrated } from "@/lib/store";
import { appRunner } from "@/lib/story/runner";

/**
 * Hydrates the server-backed asset store once per page load (importing this
 * browser's legacy localStorage rows on the first run after the upgrade),
 * then resumes story queues that were mid-run when the tab closed. The
 * rehydrate pass reads the ADOPTED list — the server truth — so stories
 * created in another browser resume here too (durable-jobs spec Phase A).
 */
export function StoreBootstrap() {
  useEffect(() => {
    void (async () => {
      const assets = await ensureStoreHydrated();
      appRunner.rehydrate(assets.filter((a) => a.kind === "story").map((a) => a.id));
    })();
  }, []);

  return null;
}

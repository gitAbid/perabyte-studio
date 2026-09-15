"use client";

import { useEffect } from "react";
import { useAssets } from "@/lib/store";
import { appRunner } from "@/lib/story/runner";
import { seedDemoContent } from "@/lib/store";

/**
 * Seeds the example renders once per browser, before any screen asks for
 * assets, and resumes story queues that were mid-run when the tab closed
 * (spec §5 — the persisted story asset IS the queue).
 */
export function StoreBootstrap() {
  const { assets, ready } = useAssets();

  useEffect(() => {
    seedDemoContent();
  }, []);

  useEffect(() => {
    if (!ready) return;
    appRunner.rehydrate(assets.filter((a) => a.kind === "story").map((a) => a.id));
    // Run once after hydration — rehydration is idempotent anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return null;
}

"use client";

import { useEffect } from "react";
import { ensureStoreHydrated } from "@/lib/store";

/**
 * Hydrates the server-backed asset store once per page load (importing this
 * browser's legacy localStorage rows on the first run after the upgrade).
 * Story runs live entirely server-side now (Phase C) — there is nothing for
 * the client to resume.
 */
export function StoreBootstrap() {
  useEffect(() => {
    void ensureStoreHydrated();
  }, []);

  return null;
}

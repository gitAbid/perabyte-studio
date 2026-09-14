"use client";

import { useEffect } from "react";
import { seedDemoContent } from "@/lib/store";

/**
 * Seeds the example renders once per browser, before any screen asks for
 * assets. Lives in the root layout so a render created on the generator page
 * is never replaced when History is opened for the first time.
 */
export function StoreBootstrap() {
  useEffect(() => {
    seedDemoContent();
  }, []);
  return null;
}
import { Suspense } from "react";
import type { Metadata } from "next";
import { StudioHomeSkeleton } from "@/components/studio/StudioHomeSkeleton";
import { StudioHomeView } from "@/components/studio/StudioHomeView";
import { loadStudioHome } from "@/lib/studio/home-read-model";

export const metadata: Metadata = {
  title: "Studio Home",
  description:
    "Continue an episode or start a new one — your characters, places, and productions all begin here.",
};

/**
 * Studio Home (feature spec 04) — post-login landing for creators.
 * Server component: reads ONLY through lib/studio/home-read-model.ts (the one
 * data seam; workspace APIs land next wave, so the shell renders its teaching
 * empty states today).
 */
export default function StudioHomePage() {
  return (
    <Suspense fallback={<StudioHomeSkeleton />}>
      <StudioHomeContent />
    </Suspense>
  );
}

async function StudioHomeContent() {
  const model = await loadStudioHome();
  return <StudioHomeView model={model} />;
}

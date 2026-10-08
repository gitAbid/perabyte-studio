import { Suspense } from "react";
import type { Metadata } from "next";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { LibraryGridSkeleton } from "@/components/library/LibraryGrid";
import { LibraryExplorer } from "@/components/library/LibraryExplorer";
import { buildLibraryModel, type LibraryModel } from "@/lib/library/read-model";
import { listCharacters } from "@/lib/services/characters.service";
import { listLocations } from "@/lib/services/locations.service";
import { ensureRecordsSeeded, listRecords } from "@/lib/services/records.service";

export const metadata: Metadata = {
  title: "Library",
  description:
    "One place to find your characters, environments, images, and videos — search everything, favorite what you love, and open items where they live.",
};

/**
 * /library (feature spec 16, Creator Alpha "basic discovery" slice).
 *
 * Server component: reads rows through the SAME read layer the existing
 * APIs expose (characters / locations / records services — read-only, no
 * provider calls) and assembles the discovery model via
 * lib/library/read-model.ts. The client explorer adds search, filters, and
 * the browser-local favorites overlay. Stories intentionally stay in
 * /stories (spec 16 §2: creative and media stay separate concepts).
 *
 * Dynamic render: the stores are fs-backed JSON that change outside Next's
 * knowledge, so every request re-reads. The Suspense boundary carries the
 * named skeleton loading state (spec 03 §3 — never an anonymous spinner).
 */
export const dynamic = "force-dynamic";

/** One await for the whole page; the seam lives in lib/library/read-model.ts. */
async function loadLibraryModel(): Promise<LibraryModel> {
  // Same first-read demo seeding /api/assets performs, so a fresh install
  // sees the example strip here too.
  ensureRecordsSeeded();
  return buildLibraryModel({
    characters: listCharacters(),
    locations: listLocations(),
    records: listRecords(),
  });
}

export default function LibraryPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-14 pt-6 sm:px-6 lg:px-10 lg:pt-9">
          <div className="space-y-3">
            <div className="skeleton h-4 w-40 rounded-[6px]" />
            <div className="skeleton h-9 w-56 rounded-[8px]" />
            <div className="skeleton h-4 w-80 max-w-full rounded-[6px]" />
          </div>
          <div className="mt-8">
            <LibraryGridSkeleton tiles={8} />
          </div>
        </div>
      }
    >
      <LibraryContent />
    </Suspense>
  );
}

async function LibraryContent() {
  let model: LibraryModel;
  try {
    model = await loadLibraryModel();
  } catch {
    // A corrupt/unreadable store must not crash the page (the repositories'
    // own loaders already degrade; this guards the assembly step).
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 sm:px-6">
        <div role="alert" data-testid="library.error">
          <EmptyState
            icon="alert"
            title="Your library couldn't be loaded"
            body="Nothing was lost — your characters, places, and renders are safe on disk. Refresh the page to try again."
            action={
              <a
                href="/library"
                className="inline-flex h-11 items-center gap-2 rounded-[7px] bg-primary-strong px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
              >
                <Icon name="refresh" size={16} aria-hidden="true" />
                Refresh
              </a>
            }
            testId="library.error.state"
          />
        </div>
      </div>
    );
  }

  return <LibraryExplorer model={model} />;
}

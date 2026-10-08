/**
 * Loading state for /studio while the read model resolves. Mirrors the page
 * rhythm (header, onboarding, sections) with skeleton blocks — a named
 * loading state, never an anonymous spinner (spec 03 section 3).
 */
export function StudioHomeSkeleton() {
  return (
    <div
      data-testid="studio.home.loading"
      aria-busy="true"
      className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-8"
    >
      <p className="sr-only">Loading your studio…</p>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <div className="skeleton h-8 w-52 rounded-[8px]" />
          <div className="skeleton h-4 w-80 max-w-full rounded-[6px]" />
        </div>
        <div className="skeleton h-4 w-40 rounded-[6px]" />
      </div>

      <div className="mt-8 rounded-[12px] border border-border bg-raised p-6 shadow-card">
        <div className="skeleton h-4 w-44 rounded-[6px]" />
        <div className="mt-4 grid grid-cols-1 gap-2.5 md:grid-cols-2">
          <div className="skeleton h-[68px] rounded-[10px]" />
          <div className="skeleton h-[68px] rounded-[10px]" />
        </div>
      </div>

      {["continue-working", "workspaces", "create"].map((section) => (
        <div key={section} className="mt-10">
          <div className="skeleton h-4 w-36 rounded-[6px]" />
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="skeleton h-[104px] rounded-[12px]" />
            <div className="skeleton h-[104px] rounded-[12px]" />
            <div className="skeleton hidden h-[104px] rounded-[12px] md:block" />
            <div className="skeleton hidden h-[104px] rounded-[12px] lg:block" />
          </div>
        </div>
      ))}
    </div>
  );
}

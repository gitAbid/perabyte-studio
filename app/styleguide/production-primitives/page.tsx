"use client";

import { useState } from "react";
import { Button, Segmented } from "@/components/ui";
import { Icon } from "@/components/Icon";
import {
  ApprovalBadge,
  type ApprovalBadgeProps,
} from "@/components/production/primitives/approval";
import {
  WorkspaceContextChip,
  type WorkspaceRating,
} from "@/components/production/primitives/workspace";
import {
  CostEstimateCard,
  type QualityStrategy,
} from "@/components/production/primitives/cost";
import {
  NaturalLanguageChangeBox,
} from "@/components/production/primitives/change";
import {
  EmptyState,
} from "@/components/production/primitives/empty-state";
import {
  VariantGrid,
  CompareModal,
  type VariantCandidate,
} from "@/components/production/primitives/variants";
import {
  MediaPreview,
  VersionStrip,
  type MediaPreviewState,
  type VersionThumb,
} from "@/components/production/primitives/media";
import {
  GenerationStatus,
  JobProgress,
  type GenerationPhase,
} from "@/components/production/primitives/status";

/* ------------------------------------------------------------------ */
/* Styleguide harness — Creator Alpha production primitives            */
/* Renders every primitive in components/production/primitives/** in  */
/* its demo states (default / loading / error / draft-recommended-     */
/* approved / empty). No fetching, no feature imports.                 */
/* ------------------------------------------------------------------ */

const INDEX: [string, string, string][] = [
  ["01", "Approval", "#approval"],
  ["02", "Workspace", "#workspace"],
  ["03", "Cost", "#cost"],
  ["04", "Change", "#change"],
  ["05", "Empty states", "#empty"],
  ["06", "Generation & media", "#generation"],
];

/* All five long-action phases on one switchable status card. */
const JOB_PHASES: { value: GenerationPhase; label: string }[] = [
  { value: "ready", label: "Ready" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

/* Self-contained demo artwork: tiny inline SVGs, so the styleguide needs
   no network and no binary fixtures. These colors are picture content,
   not UI chrome — UI colors always come from tokens. */
function demoImage(background: string, subject: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${background}"/><circle cx="320" cy="190" r="92" fill="${subject}"/><rect x="170" y="310" width="300" height="80" rx="18" fill="${subject}" opacity="0.45"/><rect x="230" y="330" width="180" height="14" rx="7" fill="${background}" opacity="0.6"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const DEMO_READY: MediaPreviewState = {
  phase: "ready",
  media: {
    kind: "image",
    src: demoImage("#315f4b", "#e0eade"),
    alt: "Demo frame: a pale circle and platform on an evergreen background",
  },
};

const DEMO_READY_ALT: MediaPreviewState = {
  phase: "ready",
  media: {
    kind: "image",
    src: demoImage("#c96c4c", "#f4f1e9"),
    alt: "Demo frame: a pale circle and platform on a clay background",
  },
};

const DEMO_VARIANTS: VariantCandidate[] = [
  {
    id: "v1",
    label: "Take 1",
    caption: "Wide, calm, morning light.",
    preview: DEMO_READY,
  },
  {
    id: "v2",
    label: "Take 2",
    caption: "Closer, warmer, a little more tense.",
    badge: "Recommended",
    badgeTone: "primary",
    preview: DEMO_READY_ALT,
  },
  {
    id: "v3",
    label: "Take 3",
    caption: "Same framing, softer focus.",
    preview: DEMO_READY,
  },
];

const DEMO_VERSIONS: VersionThumb[] = [
  {
    id: "v3",
    label: "v3",
    caption: "Softer focus",
    state: DEMO_READY,
  },
  {
    id: "v2",
    label: "v2",
    caption: "Warmer light",
    state: DEMO_READY_ALT,
  },
  {
    id: "v1",
    label: "v1",
    caption: "First cut",
    state: { phase: "loading" },
  },
];

const APPROVAL_DEMOS: {
  state: ApprovalBadgeProps["state"];
  caption: string;
}[] = [
  { state: "draft", caption: "Nothing checked yet." },
  { state: "recommended", caption: "PeraByte's pick — you still decide." },
  { state: "approved", caption: "Locked in by you." },
];

const STRATEGIES: {
  value: QualityStrategy;
  label: string;
  min: number;
  max: number;
  perVideo: string;
}[] = [
  { value: "economy", label: "Economy", min: 0.6, max: 0.95, perVideo: "$0.10 – $0.16" },
  { value: "balanced", label: "Balanced", min: 0.9, max: 1.5, perVideo: "$0.15 – $0.25" },
  { value: "best", label: "Best", min: 1.6, max: 2.8, perVideo: "$0.27 – $0.47" },
];

function SectionHeading({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent">
        {eyebrow}
      </p>
      <h2 className="editorial-display mt-3 text-[32px] leading-tight text-ink">
        {title}
      </h2>
      <p className="mt-3 max-w-sm text-[13px] leading-[1.8] text-muted">
        {copy}
      </p>
    </div>
  );
}

function DemoCaption({ children }: { children: string }) {
  return <p className="mt-2 text-[11px] text-muted">{children}</p>;
}

export default function ProductionPrimitivesPage() {
  const [strategy, setStrategy] = useState<QualityStrategy>("balanced");
  const [costOutcome, setCostOutcome] = useState<string | null>(null);
  const [workspaceNote, setWorkspaceNote] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<string | null>("v2");
  const [gridMode, setGridMode] = useState<
    "ready" | "loading" | "error" | "empty"
  >("ready");
  const [compare, setCompare] = useState<{
    mode: "side-by-side" | "slider";
    leftId: string;
  } | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>("v3");
  const [recoveredFrame, setRecoveredFrame] = useState<MediaPreviewState>({
    phase: "error",
    message: "This preview could not load.",
    onRetry: () => setRecoveredFrame(DEMO_READY),
  });
  const [jobPhase, setJobPhase] = useState<GenerationPhase>("running");
  const [statusNote, setStatusNote] = useState<string | null>(null);

  const active = STRATEGIES.find((s) => s.value === strategy) ?? STRATEGIES[1];

  return (
    <div className="mx-auto w-full max-w-[1320px] px-5 pb-16 pt-8 sm:px-8 lg:px-12">
      <header className="grid gap-8 border-b border-border pb-8 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
            <span className="h-px w-6 bg-accent" /> Creator Alpha primitives{" "}
            <span className="text-muted">/ production</span>
          </p>
          <h1 className="editorial-display mt-4 max-w-3xl text-[42px] leading-[1.02] text-ink sm:text-[56px]">
            The building blocks of making a video.
          </h1>
          <p className="mt-4 max-w-2xl text-[13px] leading-[1.8] text-muted sm:text-sm">
            Every shared primitive for Creator Alpha, shown in its states:
            normal, working, failed, waiting for your approval, and empty.
            Check both light and dark — every color comes from the shared
            tokens.
          </p>
        </div>
        <div className="border-l border-border pl-4 text-[11px] leading-[1.7] text-muted lg:max-w-[210px]">
          <span className="block font-bold uppercase tracking-[0.16em] text-ink-soft">
            Contracts
          </span>
          <span className="mt-1 block">
            Shapes follow <code className="text-ink">CONTRACTS-FROZEN</code> C8
            + C12.
          </span>
          <span className="block">
            Source lives in{" "}
            <code className="text-ink">components/production/primitives/</code>
          </span>
        </div>
      </header>

      <nav
        aria-label="Primitive sections"
        className="grid grid-cols-2 border-b border-border sm:grid-cols-3 lg:grid-cols-6"
      >
        {INDEX.map(([number, label, href]) => (
          <a
            key={number}
            href={href}
            className="group flex min-h-[56px] items-center gap-3 border-border px-2 transition-colors hover:bg-surface sm:border-l sm:px-4 first:sm:border-l-0"
          >
            <span className="text-[10px] font-bold tracking-[0.12em] text-accent">
              {number}
            </span>
            <span className="text-[12px] font-semibold text-ink-soft group-hover:text-ink">
              {label}
            </span>
            <Icon
              name="arrow-right"
              size={13}
              className="ml-auto text-muted transition-transform group-hover:translate-x-0.5"
            />
          </a>
        ))}
      </nav>

      {/* 01 — Approval ------------------------------------------------ */}
      <section
        id="approval"
        className="scroll-mt-8 border-b border-border py-10 sm:py-14"
      >
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <SectionHeading
            eyebrow="01 / Approval"
            title="You decide. PeraByte suggests."
            copy="PeraByte can recommend a take or a frame, but nothing becomes final until you approve it. The badge explains this out loud, so the colors are never the only signal."
          />
          <div className="grid content-start gap-6 border-y border-border bg-surface/45 p-4 sm:p-6">
            <div className="grid gap-4 sm:grid-cols-3">
              {APPROVAL_DEMOS.map((demo) => (
                <div key={demo.state}>
                  <ApprovalBadge state={demo.state} />
                  <DemoCaption>{demo.caption}</DemoCaption>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <span className="text-[12px] text-muted">In context:</span>
              <ApprovalBadge state="recommended" testId="demo.approval.context" />
              <span className="text-[13px] font-semibold text-ink">
                Take 3 — Luna at the greenhouse door
              </span>
              <Button size="sm" variant="secondary" data-testid="demo.approval.use">
                Use this
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* 02 — Workspace ----------------------------------------------- */}
      <section
        id="workspace"
        className="scroll-mt-8 border-b border-border py-10 sm:py-14"
      >
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <SectionHeading
            eyebrow="02 / Workspace"
            title="Always know where you are."
            copy="A small reminder of the active workspace and how it is rated. Characters and places stay inside their own workspace, so the chip follows you across production pages."
          />
          <div className="grid content-start gap-6 border-y border-border bg-surface/45 p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <WorkspaceContextChip
                name="Milo & Luna"
                rating={"General" as WorkspaceRating}
                href="/workspaces"
              />
              <DemoCaption>General · links to the workspace page.</DemoCaption>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <WorkspaceContextChip
                name="Night Shift"
                rating="Mature"
                onClick={() =>
                  setWorkspaceNote(
                    "Tapping the chip would open the workspace picker.",
                  )
                }
              />
              <DemoCaption>Mature · the whole chip is a button.</DemoCaption>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <WorkspaceContextChip name="After Dark" rating="Adult" />
              <DemoCaption>Adult · plain chip, no action attached.</DemoCaption>
            </div>
            <p
              role="status"
              data-testid="demo.workspace.feedback"
              className="border-t border-border pt-4 text-[12px] text-ink-soft"
            >
              {workspaceNote ?? "Tap the Mature chip to try its action."}
            </p>
          </div>
        </div>
      </section>

      {/* 03 — Cost ----------------------------------------------------- */}
      <section
        id="cost"
        className="scroll-mt-8 border-b border-border py-10 sm:py-14"
      >
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <SectionHeading
            eyebrow="03 / Cost"
            title="The price, before you spend."
            copy="Nothing is generated without a clear estimate first: what will be made, what it should cost, and a real choice. The actual cost is shown again once the work finishes."
          />
          <div className="grid content-start gap-6 border-y border-border bg-surface/45 p-4 sm:p-6">
            <Segmented
              ariaLabel="Quality strategy for the demo"
              size="sm"
              value={strategy}
              onChange={setStrategy}
              options={STRATEGIES.map((s) => ({
                value: s.value,
                label: s.label,
              }))}
            />
            <CostEstimateCard
              itemCount={6}
              itemNoun="video"
              estimateMin={active.min}
              estimateMax={active.max}
              currency="USD"
              qualityStrategy={strategy}
              breakdown={[
                { label: "6 videos, about 8 seconds each", amount: active.perVideo },
                { label: "Keeps every character and place consistent", amount: "Included" },
              ]}
              onConfirm={() =>
                setCostOutcome(
                  "Started. The actual cost will appear when it finishes.",
                )
              }
              onDecline={() =>
                setCostOutcome("No problem — nothing was spent.")
              }
            />
            <p
              role="status"
              data-testid="demo.cost.feedback"
              className="text-[12px] text-ink-soft"
            >
              {costOutcome ?? "Try Start generating or Not now."}
            </p>
            <div className="border-t border-border pt-6">
              <CostEstimateCard
                itemCount={1}
                itemNoun="video"
                estimateMin={0.25}
                estimateMax={0.25}
                currency="USD"
                qualityStrategy="best"
                busy
                testIdBase="cost.estimate.busy"
              />
              <DemoCaption>
                Working state — both buttons are disabled until the go-ahead
                goes through.
              </DemoCaption>
            </div>
          </div>
        </div>
      </section>

      {/* 04 — Change --------------------------------------------------- */}
      <section
        id="change"
        className="scroll-mt-8 border-b border-border py-10 sm:py-14"
      >
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <SectionHeading
            eyebrow="04 / Change"
            title="Say it in your own words."
            copy="Every “change something” box works the same: write what you want different, watch the character count, and send it. PeraByte always shows what it plans to change before doing anything expensive."
          />
          <div className="grid content-start gap-6 border-y border-border bg-surface/45 p-4 sm:p-6">
            <div>
              <NaturalLanguageChangeBox
                onSubmit={(instruction) =>
                  setChangeNote(
                    `PeraByte will show the plan for: “${instruction}”`,
                  )
                }
              />
              <p
                role="status"
                data-testid="demo.change.feedback"
                className="mt-2 text-[12px] text-ink-soft"
              >
                {changeNote ?? "Submit an instruction to see the next step."}
              </p>
            </div>
            <div className="border-t border-border pt-6">
              <NaturalLanguageChangeBox
                busy
                onSubmit={() => {}}
                testIdBase="change.request.busy"
              />
              <DemoCaption>
                Working state — the box and button wait until the change is
                applied.
              </DemoCaption>
            </div>
            <div className="border-t border-border pt-6">
              <NaturalLanguageChangeBox
                error="That change didn't go through. Your video is safe — try again in a moment."
                onSubmit={() => {}}
                testIdBase="change.request.error"
              />
              <DemoCaption>
                Error state — a plain explanation, never a provider code.
              </DemoCaption>
            </div>
          </div>
        </div>
      </section>

      {/* 05 — Empty states --------------------------------------------- */}
      <section
        id="empty"
        className="scroll-mt-8 border-b border-border py-10 sm:py-14"
      >
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <SectionHeading
            eyebrow="05 / Empty states"
            title="Empty pages teach, not scold."
            copy="An empty surface always explains what belongs here and offers the one action that fills it. Never a bare “no items”."
          />
          <div className="grid content-start gap-6 border-y border-border bg-surface/45 p-4 sm:p-6">
            <EmptyState
              icon="layers"
              title="No workspaces yet"
              body="A workspace keeps your characters, places, and style together so every scene stays consistent. Create one to start your first video."
              action={
                <Button size="sm" data-testid="demo.empty.create">
                  Create workspace
                </Button>
              }
            />
            <EmptyState
              title="No takes for this shot yet"
              body="Generate a take and PeraByte will keep Luna's look and the greenhouse lighting exactly as approved."
              action={
                <Button size="sm" icon="video" data-testid="demo.empty.generate">
                  Generate a take
                </Button>
              }
              illustration={
                <span
                  aria-hidden="true"
                  className="flex items-end justify-center gap-1.5"
                >
                  {[
                    { fill: "bg-surface-2", size: 24 },
                    { fill: "bg-primary-soft", size: 32 },
                    { fill: "bg-surface-2", size: 40 },
                  ].map((frame) => (
                    <span
                      key={frame.size}
                      className={`rounded-[6px] border border-border ${frame.fill}`}
                      style={{ width: 34, height: frame.size }}
                    />
                  ))}
                </span>
              }
            />
            <DemoCaption>
              Second demo uses the illustration slot instead of an icon.
            </DemoCaption>
          </div>
        </div>
      </section>

      {/* 06 — Generation & media ---------------------------------------- */}
      <section
        id="generation"
        className="scroll-mt-8 border-b border-border py-10 sm:py-14"
      >
        <div className="grid gap-8 lg:grid-cols-[0.65fr_1.35fr]">
          <SectionHeading
            eyebrow="06 / Generation & media"
            title="Long waits, handled calmly."
            copy="Every wait names its stage, previews hold their shape while they load, results arrive as labeled takes, comparisons open in place, and earlier versions stay — nothing is overwritten."
          />
          <div className="grid content-start gap-8 border-y border-border bg-surface/45 p-4 sm:p-6">
            <div>
              <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-soft">
                MediaPreview
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <MediaPreview
                    state={{ phase: "loading" }}
                    ratio="1 / 1"
                    testId="demo.preview.loading"
                  />
                  <DemoCaption>Loading</DemoCaption>
                </div>
                <div>
                  <MediaPreview
                    state={DEMO_READY}
                    ratio="1 / 1"
                    testId="demo.preview.ready"
                  />
                  <DemoCaption>Ready</DemoCaption>
                </div>
                <div>
                  <MediaPreview
                    state={recoveredFrame}
                    ratio="1 / 1"
                    testId="demo.preview.error"
                  />
                  <DemoCaption>Error — retry recovers it</DemoCaption>
                </div>
                <div>
                  <MediaPreview
                    state={{
                      phase: "empty",
                      title: "No frame yet",
                      body: "This shot has no preview yet.",
                    }}
                    ratio="1 / 1"
                    testId="demo.preview.empty"
                  />
                  <DemoCaption>Empty</DemoCaption>
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-soft">
                  VariantGrid
                </p>
                <Segmented
                  ariaLabel="Variant grid demo state"
                  size="sm"
                  value={gridMode}
                  onChange={setGridMode}
                  options={[
                    { value: "ready", label: "Results" },
                    { value: "loading", label: "Loading" },
                    { value: "error", label: "Error" },
                    { value: "empty", label: "Empty" },
                  ]}
                />
              </div>
              <div className="mt-3">
                <VariantGrid
                  testId="demo.variants"
                  candidates={gridMode === "ready" ? DEMO_VARIANTS : []}
                  selectedId={selectedVariant}
                  onSelect={(id) => setSelectedVariant(id)}
                  onCompare={(id) =>
                    setCompare({ mode: "side-by-side", leftId: id })
                  }
                  onRefine={() =>
                    setChangeNote(
                      "Refining opens the same “Ask for a change” box.",
                    )
                  }
                  columns={3}
                  ratio="16 / 9"
                  loading={gridMode === "loading"}
                  error={
                    gridMode === "error"
                      ? {
                          message:
                            "Take 2's video couldn't generate. The approved storyboard frame is still safe — retry the same take or make a different one.",
                          onRetry: () => setGridMode("ready"),
                        }
                      : null
                  }
                  emptyState={{
                    title: "No takes yet",
                    body: "Generate a take and PeraByte keeps Luna's look and the greenhouse lighting exactly as approved.",
                    action: (
                      <Button size="sm" data-testid="demo.variants.generate">
                        Generate a take
                      </Button>
                    ),
                  }}
                />
              </div>
            </div>

            <div className="border-t border-border pt-6">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-soft">
                  CompareModal
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setCompare({ mode: "side-by-side", leftId: "v1" })
                  }
                  data-testid="demo.compare.open"
                >
                  Compare side by side
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCompare({ mode: "slider", leftId: "v1" })}
                  data-testid="demo.compare.slider"
                >
                  Compare with slider
                </Button>
              </div>
              <DemoCaption>
                Esc, the close button, or clicking outside closes it.
              </DemoCaption>
            </div>

            <div className="border-t border-border pt-6">
              <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-soft">
                VersionStrip
              </p>
              <div className="mt-3">
                <VersionStrip
                  testId="demo.versions"
                  versions={DEMO_VERSIONS}
                  selectedId={selectedVersion}
                  onSelect={setSelectedVersion}
                />
              </div>
            </div>

            <div className="border-t border-border pt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-soft">
                  GenerationStatus
                </p>
                <Segmented
                  ariaLabel="Generation status demo phase"
                  size="sm"
                  value={jobPhase}
                  onChange={setJobPhase}
                  options={JOB_PHASES}
                />
              </div>
              <div className="mt-3">
                <GenerationStatus
                  testId="demo.status"
                  phase={jobPhase}
                  stage={
                    jobPhase === "running"
                      ? "Composing frame 2 of 4"
                      : jobPhase === "queued"
                        ? "Waiting for a free slot…"
                        : undefined
                  }
                  currentItem={
                    jobPhase === "running" || jobPhase === "queued"
                      ? "Scene 04 — Moonlit bridge"
                      : undefined
                  }
                  failureMessage={
                    jobPhase === "failed"
                      ? "The video service didn't answer in time. Your approved storyboard frame is safe — retry the same take or make a different one."
                      : undefined
                  }
                  cost={
                    jobPhase === "ready"
                      ? "Estimated cost: $0.90 – $1.50"
                      : jobPhase === "running"
                        ? "Estimated cost: $1.20"
                        : jobPhase === "completed"
                          ? "Actual cost: $1.08"
                          : undefined
                  }
                  onCancel={
                    jobPhase === "queued" || jobPhase === "running"
                      ? () => {
                          setJobPhase("ready");
                          setStatusNote(
                            "Canceled before anything was generated — nothing was spent.",
                          );
                        }
                      : undefined
                  }
                  onRetry={
                    jobPhase === "failed"
                      ? () => {
                          setJobPhase("running");
                          setStatusNote("Retrying the same take…");
                        }
                      : undefined
                  }
                />
                <p
                  role="status"
                  data-testid="demo.status.feedback"
                  className="mt-2 text-[12px] text-ink-soft"
                >
                  {statusNote ??
                    "Switch phases, then try Cancel or Retry where offered."}
                </p>
              </div>
            </div>

            <div className="border-t border-border pt-6">
              <p className="text-[12px] font-bold uppercase tracking-[0.12em] text-ink-soft">
                JobProgress
              </p>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <JobProgress
                  label="Rendering scene 4"
                  percent={25}
                  currentItem="Frame 12 of 48"
                  testId="demo.progress.determinate"
                />
                <JobProgress
                  label="Finishing up"
                  testId="demo.progress.indeterminate"
                />
              </div>
              <DemoCaption>
                Indeterminate progress still names its stage — never a bare
                spinner.
              </DemoCaption>
            </div>
          </div>
        </div>
      </section>

      <CompareModal
        open={compare !== null}
        left={
          compare
            ? (DEMO_VARIANTS.find((v) => v.id === compare.leftId) ?? null)
            : null
        }
        right={
          compare
            ? (DEMO_VARIANTS.find(
                (v) => v.id === (compare.leftId === "v2" ? "v1" : "v2"),
              ) ?? null)
            : null
        }
        mode={compare?.mode ?? "side-by-side"}
        ratio="16 / 9"
        onClose={() => setCompare(null)}
        testId="demo.compare"
      />
    </div>
  );
}

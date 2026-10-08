"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { ApprovalBadge } from "@/components/production/primitives/approval";
import { MediaPreview, VersionStrip, type MediaPreviewState, type VersionThumb } from "@/components/production/primitives/media";
import { Badge, Button, ConfirmDialog, EmptyState, LinkButton, formatDate, useToast } from "@/components/ui";
import {
  EMPTY_STRUCTURED_STATE,
  StructuredStateFields,
  type StructuredStateValue,
} from "@/components/environments/StructuredStateFields";
import {
  DERIVED_VIEWS,
  approveEnvironment,
  currentRevision,
  environmentApprovalState,
  removeEnvironmentView,
  removeEnvironments,
  setEnvironmentView,
  toggleEnvironmentFavorite,
  updateEnvironment,
  useEnvironments,
  type EnvironmentCanonEntry,
  type EnvironmentSnapshot,
  type EnvironmentViewId,
} from "@/components/environments/environment-store";
import { IMAGE_STYLES, type ImageStyleKey } from "@/lib/constants";
import { downloadMedia, GenerationError, requestGeneration } from "@/lib/generation";
import { refFromMediaUrl } from "@/lib/media/frame";

/**
 * Environment detail (spec 07 §5–§6): the canonical plate, the derived
 * supporting views (wide / entrance / day / night — each independently
 * re-rollable without touching the others), the structured
 * zone/lighting/time/weather/props editor, and the immutable version strip.
 * A failed derived view never invalidates the approved main canon (§8).
 */

const RATIO = "16 / 9";

type ViewRender = {
  status: "idle" | "rendering" | "failed";
  error?: string;
};

type ViewState = Partial<Record<EnvironmentViewId, ViewRender>>;

function environmentSettings(style: string) {
  return {
    kind: "image" as const,
    aspect: "16:9" as const,
    resolution: "1080p" as const,
    style: (style in IMAGE_STYLES ? style : "Cinematic") as ImageStyleKey,
    duration: "5s" as const,
    count: 1,
    seed: "",
    negativePrompt: "",
    enhance: true,
    safe: true,
  };
}

function composeViewPrompt(entry: EnvironmentCanonEntry, viewId: EnvironmentViewId, chained: boolean): string {
  const view = DERIVED_VIEWS.find((candidate) => candidate.id === viewId);
  const style = environmentSettings(entry.style).style;
  return [
    entry.description.trim(),
    view?.direction,
    chained ? "same environment as the reference image" : "",
    IMAGE_STYLES[style],
    "no people, no text",
  ]
    .filter(Boolean)
    .join(", ");
}

export function EnvironmentDetail({ environmentId }: { environmentId: string }) {
  const toast = useToast();
  const router = useRouter();
  const { environments, ready } = useEnvironments();
  const entry = useMemo(
    () => environments.find((candidate) => candidate.id === environmentId) ?? null,
    [environments, environmentId],
  );

  // Derived-view renders are session state; pinned results go to the store.
  const [renders, setRenders] = useState<ViewState>({});
  const rendersRef = useRef(renders);
  rendersRef.current = renders;
  const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRef = useRef(false);
  const entryRef = useRef<EnvironmentCanonEntry | null>(null);
  entryRef.current = entry;

  // Structured-state draft, reset per environment.
  const [draft, setDraft] = useState<StructuredStateValue>(EMPTY_STRUCTURED_STATE);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const draftEnvironmentRef = useRef<string | null>(null);
  useEffect(() => {
    if (entry && draftEnvironmentRef.current !== entry.id) {
      draftEnvironmentRef.current = entry.id;
      setDraft({
        zone: entry.zone,
        lighting: entry.lighting,
        timeOfDay: entry.timeOfDay,
        weather: entry.weather,
        persistentProps: entry.persistentProps,
      });
      setSaveNote(null);
    }
  }, [entry]);

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const [paletteDraft, setPaletteDraft] = useState<string | null>(null);
  const name = nameDraft ?? entry?.name ?? "";
  const description = descriptionDraft ?? entry?.description ?? "";
  const palette = paletteDraft ?? entry?.palette ?? "";

  const [viewingRevisionId, setViewingRevisionId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 sm:px-6" role="status" aria-label="Loading environment">
        <div className="flex justify-center">
          <div aria-hidden className="size-10 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary" />
        </div>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 sm:px-6" data-testid="environments.detail.missing">
        <EmptyState
          icon="home"
          title="Environment not found"
          body="This environment may have been deleted, or the link is out of date."
          action={
            <LinkButton href="/environments" variant="secondary">
              Back to the library
            </LinkButton>
          }
        />
      </div>
    );
  }

  const current = currentRevision(entry);
  const viewing = entry.revisions.find((revision) => revision.id === viewingRevisionId) ?? current;
  const viewingIsCurrent = viewing.id === current.id;
  const approved = environmentApprovalState(entry) === "approved";
  const chainedPlateRef = entry.plate;

  const runningCount = Object.values(renders).filter((render) => render?.status === "rendering").length;
  const doneViews = entry.views.length;

  function patchRender(viewId: EnvironmentViewId, patch: ViewRender) {
    setRenders((prev) => ({ ...prev, [viewId]: patch }));
  }

  /** Render one derived view. Chains off the canonical plate (img2img) so
   * every view stays the same place; a failed view is retryable solo and
   * never touches the other views (spec 07 §10 test 2). */
  async function renderView(viewId: EnvironmentViewId): Promise<void> {
    const active = entryRef.current;
    if (!active) return;
    const previous = rendersRef.current[viewId];
    const controller = new AbortController();
    abortRef.current = controller;
    patchRender(viewId, { status: "rendering" });
    try {
      const chained = Boolean(active.plate);
      const response = await requestGeneration({
        settings: environmentSettings(active.style),
        prompt: composeViewPrompt(active, viewId, chained),
        ...(chained && active.plate ? { startImageRef: active.plate } : {}),
        signal: controller.signal,
      });
      const media = response.media[0];
      if (!media?.url) throw new GenerationError("The render came back empty. Try again.");
      setEnvironmentView(active.id, viewId, {
        ref: refFromMediaUrl(media.url),
        url: media.url,
      });
      setRenders((prev) => ({ ...prev, [viewId]: { status: "idle" } }));
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        setRenders((prev) => ({ ...prev, [viewId]: previous ?? { status: "idle" } }));
        return;
      }
      patchRender(viewId, {
        status: "failed",
        error: (error as GenerationError).message || "This view could not be rendered. Try again.",
      });
    }
  }

  /** Render every missing view in DERIVED_VIEWS order; failures stay retryable. */
  async function runViewBatch() {
    if (batch || !entry) return;
    cancelRef.current = false;
    const missing = DERIVED_VIEWS.filter(
      (view) => !entry.views.some((asset) => asset.viewId === view.id),
    );
    setBatch({ index: 0, total: missing.length });
    try {
      for (let index = 0; index < missing.length; index++) {
        if (cancelRef.current) break;
        setBatch({ index: index + 1, total: missing.length });
        await renderView(missing[index].id);
      }
    } finally {
      setBatch(null);
      abortRef.current = null;
    }
  }

  function saveState() {
    if (!entry) return;
    const snapshotPatch: Partial<EnvironmentSnapshot> = {
      name,
      description,
      palette,
      ...draft,
    };
    const created = updateEnvironment(entry.id, snapshotPatch, "Structured state or details updated.");
    setSaveNote(
      created
        ? "Saved — a new revision is now current. Earlier versions stay in the history below."
        : "Everything already saved — no changes to record.",
    );
    if (created) toast.push("Environment updated.", "success");
  }

  function restoreRevision(revisionId: string) {
    if (!entry) return;
    const revision = entry.revisions.find((candidate) => candidate.id === revisionId);
    if (!revision || revision.id === current.id) return;
    updateEnvironment(entry.id, revision.snapshot, `Restored v${revision.revision}.`);
    setViewingRevisionId(null);
    setDraft({
      zone: revision.snapshot.zone,
      lighting: revision.snapshot.lighting,
      timeOfDay: revision.snapshot.timeOfDay,
      weather: revision.snapshot.weather,
      persistentProps: revision.snapshot.persistentProps,
    });
    setNameDraft(null);
    setDescriptionDraft(null);
    setPaletteDraft(null);
    setSaveNote(`Restored v${revision.revision} as a new revision — nothing was overwritten.`);
    toast.push(`Version ${revision.revision} restored.`, "success");
  }

  const stateSummary = [
    entry.zone && `Zone: ${entry.zone}`,
    entry.lighting && `Lighting: ${entry.lighting}`,
    entry.timeOfDay && `Time: ${entry.timeOfDay}`,
    entry.weather && `Weather: ${entry.weather}`,
    entry.persistentProps.length > 0 && `Props: ${entry.persistentProps.join(", ")}`,
  ].filter(Boolean) as string[];

  const versions: VersionThumb[] = [...entry.revisions]
    .sort((a, b) => b.revision - a.revision)
    .map((revision) => ({
      id: revision.id,
      label: `v${revision.revision}`,
      caption: `${revision.note} · ${formatDate(revision.createdAt)}`,
      state: revision.snapshot.plateUrl
        ? {
            phase: "ready" as const,
            media: {
              kind: "image" as const,
              src: revision.snapshot.plateUrl,
              alt: `Version ${revision.revision} plate`,
            },
          }
        : { phase: "empty" as const, title: "No plate", body: "This version saved without a plate." },
    }));

  return (
    <div className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col px-4 py-5 sm:px-6 lg:px-9 lg:py-7">
      <header className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <LinkButton href="/environments" variant="ghost" size="sm" icon="arrow-left" aria-label="Back to the environment library">
          Library
        </LinkButton>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-accent">Environments / canon profile</p>
          <h1 className="mt-1 min-w-0 truncate text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">
            {entry.name}
          </h1>
          <p className="text-[11.5px] text-muted">
            {entry.origin === "migrated" ? "Imported from the legacy library · " : ""}
            Revision v{current.revision} · Saved {new Date(entry.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ApprovalBadge state={approved ? "approved" : "draft"} testId="environments.detail.approval" />
          {approved ? (
            <Badge tone="success">
              <Icon name="check" size={11} />
              Canon
            </Badge>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon="check"
              onClick={() => {
                approveEnvironment(entry.id);
                toast.push("Main canon approved — the plate stays stable while views render.", "success");
              }}
              data-testid="environments.detail.approve"
            >
              Approve
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="trash"
            aria-label={`Delete ${entry.name}`}
            onClick={() => setConfirmDelete(true)}
          >
            <span className="hidden sm:inline">Delete</span>
          </Button>
        </div>
      </header>

      <div className="mt-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(340px,430px)] lg:items-start lg:gap-7">
        {/* Media column */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="border border-border bg-surface p-3.5 sm:p-4" data-testid="environments.detail.plate">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13.5px] font-bold text-ink">Canonical plate</p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="star"
                  aria-label={entry.favorite ? "Remove favourite" : "Add favourite"}
                  onClick={() => toggleEnvironmentFavorite(entry.id)}
                >
                  {entry.favorite ? "Favourited" : "Favourite"}
                </Button>
                {entry.plateUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="download"
                    onClick={() => downloadMedia(entry.plateUrl!, `${entry.name}-plate-${Date.now()}`)}
                  >
                    Download
                  </Button>
                )}
              </div>
            </div>
            {entry.plateUrl ? (
              <MediaFrame
                src={entry.plateUrl}
                alt={`${entry.name} canonical plate`}
                ratio="16/9"
                rounded="rounded-[12px]"
                className="mt-3"
                priority
              />
            ) : (
              <div className="mt-3 flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed border-border-strong bg-surface text-center">
                <Icon name="image" size={22} className="text-muted" />
                <p className="max-w-[260px] text-[12px] text-muted">
                  No canonical plate yet — set one from a derived view, or create a new environment with generated plates.
                </p>
              </div>
            )}
          </div>

          {/* Derived views */}
          <div className="border border-border bg-raised p-3.5 sm:p-4" data-testid="environments.detail.views">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[13.5px] font-bold text-ink">Derived views</p>
                <p className="text-[11.5px] leading-tight text-muted">
                  {batch
                    ? `Rendering view ${batch.index} of ${batch.total}…`
                    : doneViews > 0
                      ? `${doneViews} of ${DERIVED_VIEWS.length} views pinned — re-roll any single view.`
                      : "Wide, entrance, day and night — each one chains off the plate."}
                </p>
              </div>
              {batch ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="close"
                  onClick={() => {
                    cancelRef.current = true;
                    abortRef.current?.abort();
                  }}
                >
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon="sparkle"
                  disabled={!entry.description.trim() || runningCount > 0}
                  title={entry.description.trim() ? undefined : "Add a description first — views render from it."}
                  onClick={() => void runViewBatch()}
                  data-testid="environments.detail.views.render-all"
                >
                  {doneViews > 0 ? "Render missing views" : "Render all views"}
                </Button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DERIVED_VIEWS.map((view) => {
                const asset = entry.views.find((candidate) => candidate.viewId === view.id);
                const render = renders[view.id] ?? { status: "idle" as const };
                const preview: MediaPreviewState =
                  render.status === "rendering"
                    ? { phase: "loading" }
                    : render.status === "failed"
                      ? {
                          phase: "error",
                          message: render.error,
                          onRetry: () => void renderView(view.id),
                        }
                      : asset
                        ? {
                            phase: "ready",
                            media: { kind: "image", src: asset.url, alt: `${entry.name} — ${view.label} view` },
                          }
                        : {
                            phase: "empty",
                            title: `${view.label} view not rendered`,
                            body: "Render it to lock this supporting view of the canon.",
                          };
                const isPlate = Boolean(asset && asset.ref && asset.ref === entry.plate);
                return (
                  <div
                    key={view.id}
                    className="group relative overflow-hidden rounded-[12px] border border-border bg-surface"
                    data-testid={`environments.detail.view.${view.id}`}
                  >
                    <p className="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                      {view.label}
                      {isPlate ? " · plate" : ""}
                    </p>
                    <MediaPreview state={preview} ratio={RATIO} fit="cover" rounded="none" testId={`environments.detail.view.${view.id}.media`} />
                    <div
                      className={`absolute inset-x-1.5 bottom-1.5 z-10 flex items-center justify-center gap-1 transition-opacity ${
                        render.status === "rendering"
                          ? "pointer-events-none opacity-0"
                          : "opacity-100 focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                      }`}
                    >
                      <ViewAction
                        label={render.status === "failed" ? `Retry ${view.label} view` : `Render ${view.label} view`}
                        icon="refresh"
                        disabled={batch !== null}
                        onClick={() => void renderView(view.id)}
                        testId={`environments.detail.view.${view.id}.reroll`}
                      />
                      {asset && (
                        <>
                          <ViewAction
                            label={`Download ${view.label} view`}
                            icon="download"
                            disabled={batch !== null}
                            onClick={() => downloadMedia(asset.url, `${entry.name}-${view.id}-${Date.now()}`)}
                            testId={`environments.detail.view.${view.id}.download`}
                          />
                          {!isPlate && (
                            <ViewAction
                              label={`Set ${view.label} view as canonical plate`}
                              icon="star"
                              disabled={batch !== null}
                              onClick={() => {
                                updateEnvironment(
                                  entry.id,
                                  { plate: asset.ref, plateUrl: asset.url },
                                  `Plate set from the ${view.label} view.`,
                                );
                                toast.push("Canonical plate updated.", "success");
                              }}
                              testId={`environments.detail.view.${view.id}.set-plate`}
                            />
                          )}
                          <ViewAction
                            label={`Remove ${view.label} view`}
                            icon="trash"
                            disabled={batch !== null}
                            onClick={() => removeEnvironmentView(entry.id, view.id)}
                            testId={`environments.detail.view.${view.id}.remove`}
                          />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-[11.5px] text-muted">
              A failed view never invalidates the approved main canon — re-roll views one at a time.
            </p>
          </div>

          {/* Structured summary strip (spec §6 bottom bar) */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-border bg-raised px-4 py-3">
            <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-soft">
              {stateSummary.length > 0 ? (
                stateSummary.map((line, index) => (
                  <span key={line}>
                    {index > 0 && <span className="mx-1.5 text-muted">·</span>}
                    {line}
                  </span>
                ))
              ) : (
                <span className="text-muted">
                  No structured state yet — set zone, lighting, time of day, weather and props in the editor.
                </span>
              )}
            </p>
            {!approved && (
              <Button
                size="sm"
                icon="check"
                onClick={() => {
                  approveEnvironment(entry.id);
                  toast.push("Main canon approved.", "success");
                }}
              >
                Approve
              </Button>
            )}
          </div>
        </div>

        {/* Inspector column */}
        <aside className="mt-4 flex flex-col gap-4 lg:sticky lg:top-6 lg:mt-0">
          <section aria-label="Structured state editor" className="rounded-[14px] border border-border bg-raised p-4 sm:p-5" data-testid="environments.detail.state">
            <p className="text-[13.5px] font-bold text-ink">Structured state</p>
            <p className="mb-4 mt-0.5 text-[11.5px] text-muted">
              Structured values, not prompt prose — scenes inherit these and override per shot.
            </p>
            <div className="space-y-4">
              <label className="block space-y-2">
                <span className="text-[13px] font-semibold text-ink-soft">Name</span>
                <input
                  value={name}
                  maxLength={160}
                  onChange={(event) => setNameDraft(event.target.value)}
                  data-testid="environments.detail.field.name"
                  className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-[13px] font-semibold text-ink-soft">Description</span>
                <textarea
                  value={description}
                  maxLength={600}
                  rows={3}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  data-testid="environments.detail.field.description"
                  className="w-full resize-y rounded-[12px] border border-border-strong bg-raised px-3.5 py-2.5 text-sm leading-relaxed text-ink focus:border-primary focus:outline-none"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-[13px] font-semibold text-ink-soft">Palette</span>
                <input
                  value={palette}
                  maxLength={200}
                  placeholder="e.g. teal and rust"
                  onChange={(event) => setPaletteDraft(event.target.value)}
                  data-testid="environments.detail.field.palette"
                  className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
              </label>
              <StructuredStateFields
                value={draft}
                onChange={setDraft}
                idPrefix="environment-detail"
                testIdPrefix="environments.detail.state"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  icon="check"
                  size="sm"
                  onClick={saveState}
                  data-testid="environments.detail.state.save"
                >
                  Save changes
                </Button>
                {saveNote && (
                  <p role="status" data-testid="environments.detail.state.status" className="text-[12px] text-ink-soft">
                    {saveNote}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section aria-label="Version history" className="rounded-[14px] border border-border bg-raised p-4 sm:p-5">
            <VersionStrip
              versions={versions}
              selectedId={viewing.id}
              onSelect={setViewingRevisionId}
              heading="Version history"
              testId="environments.detail.versions"
              emptyState={{
                title: "No versions yet",
                body: "Every save that changes content appends a version here.",
              }}
            />
            {!viewingIsCurrent ? (
              <div className="mt-3 rounded-[10px] border border-border bg-surface p-3">
                <p className="text-[12.5px] font-semibold text-ink">
                  Viewing v{viewing.revision} — {viewing.note}
                </p>
                <p className="mt-1 text-[11.5px] text-muted">
                  {viewing.snapshot.zone && `Zone: ${viewing.snapshot.zone}. `}
                  {viewing.snapshot.lighting && `Lighting: ${viewing.snapshot.lighting}. `}
                  {viewing.snapshot.timeOfDay && `Time: ${viewing.snapshot.timeOfDay}. `}
                  {viewing.snapshot.weather && `Weather: ${viewing.snapshot.weather}. `}
                  {viewing.snapshot.persistentProps.length > 0 &&
                    `Props: ${viewing.snapshot.persistentProps.join(", ")}.`}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="history"
                  className="mt-2.5"
                  onClick={() => restoreRevision(viewing.id)}
                  data-testid="environments.detail.versions.restore"
                >
                  Restore this version
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-[11.5px] text-muted">
                Viewing the current revision (v{current.revision}). Restoring an older version appends a new one — history is never rewritten.
              </p>
            )}
          </section>

          <section aria-label="Workspace usage note" className="rounded-[14px] border border-border bg-surface p-4">
            <p className="text-[12.5px] font-bold text-ink">Use in a workspace</p>
            <p className="mt-1 text-[11.5px] leading-snug text-muted">
              Add this environment from the workspace editor — scenes then resolve its structured
              state per shot, most specific layer wins.
            </p>
            <Link
              href="/production"
              className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-primary underline-offset-4 hover:underline"
            >
              Open production projects
              <Icon name="arrow-right" size={13} />
            </Link>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${entry.name}”?`}
        body="This removes the environment and its derived views from the canon library. Scenes that already rendered keep their frames."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          removeEnvironments([entry.id]);
          toast.push("Environment deleted.", "success");
          router.push("/environments");
        }}
      />
    </div>
  );
}

/** Action over a view card — plain button, keyboard reachable, always
 * visible on touch screens (no hover-only actions on mobile; UX spec §9). */
function ViewAction({
  label,
  icon,
  onClick,
  testId,
  disabled,
}: {
  label: string;
  icon: "refresh" | "download" | "star" | "trash";
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="inline-flex size-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75 disabled:opacity-40"
    >
      <Icon name={icon} size={13} />
    </button>
  );
}

"use client";

/**
 * Publish & Export Alpha (spec 15): master MP4 export + the manual publication package.
 *
 * Speaks HTTP only, exactly like the legacy export workspace it succeeds: GET /api/production/
 * projects/:id for the read model, POST .../manifests + POST .../exports to start a master
 * export, GET /api/production/exports/:id?projectId= polled while the render is in flight
 * (the ExportRecord polling pattern), POST run_qc for the technical checks, and the strictly
 * separated final vs draft download routes for video.mp4. The publication package is derived
 * with the frozen pure helpers in lib/production/publishing.ts — no rule is re-implemented.
 *
 * Export-only framing throughout (spec 15 §3): there is no OAuth, no upload, no publish
 * button that could fire — the unsupported platform affordance renders visibly unavailable,
 * never fake-enabled. Adult-rated workspaces (workspace rating via GET /api/workspaces/:id)
 * get the explicit "Export-only publishing" notice required by spec §8.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, LinkButton, TextAreaField } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { GenerationStatus } from "@/components/production/primitives/status";
import { WorkspaceContextChip } from "@/components/production/primitives/workspace";
import { deriveDownloadGate, type DownloadGate } from "@/components/production/export";
import { ProjectReadModelSchema, WorkspaceSchema, type ExportRecord, type ProjectReadModel } from "@/lib/production/contracts";
import { ExportDetailResponseSchema, type ExportDetailResponse } from "@/lib/production/qc";
import { MANUAL_UPLOAD_DISCLAIMER } from "@/lib/production/publishing";
import {
  METADATA_LIMITS,
  applyOverridesToDraft,
  buildManifestCommand,
  buildPackageJson,
  buildTextFileDownloads,
  deriveExportPrerequisites,
  deriveExportProgress,
  derivePackageDownloadGate,
  derivePublicationPackageSafe,
  deriveQcChecklist,
  isExportInFlight,
  seedMetadataFromPackage,
  summarizeQcChecklist,
  type PackageMetadataDraft,
  type PackageOverridesPayload,
} from "./view-model";

type WorkspaceSummary = { name: string; rating: "General" | "Mature" | "Adult" };

const MONO = "font-mono text-[12px] break-all";

const STATUS_TONE: Record<ExportRecord["status"], "neutral" | "primary" | "success" | "warning" | "danger"> = {
  queued: "neutral",
  rendering: "neutral",
  qc_pending: "neutral",
  qc_failed: "danger",
  ready_for_review: "primary",
  approved: "success",
  failed: "danger",
  canceled: "danger",
};

function triggerFileDownload(name: string, blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

async function readErrorEnvelope(payload: unknown, fallback: string): Promise<string> {
  const envelope = payload as { error?: { code?: unknown; message?: unknown; action?: unknown }; requestId?: unknown } | undefined;
  if (!envelope?.error) return `${fallback} (network error)`;
  const code = typeof envelope.error.code === "string" ? envelope.error.code : "UNKNOWN";
  const message = typeof envelope.error.message === "string" ? envelope.error.message : fallback;
  const action = typeof envelope.error.action === "string" ? ` — ${envelope.error.action}` : "";
  const requestId = typeof envelope.requestId === "string" ? envelope.requestId : "unknown";
  return `${code}: ${message}${action} (requestId ${requestId})`;
}

export function PublishView({ projectId }: { projectId: string }) {
  const [readModel, setReadModel] = useState<ProjectReadModel | null>(null);
  const [loadPhase, setLoadPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [workspaceNote, setWorkspaceNote] = useState<string | null>(null);

  const [selectedExportId, setSelectedExportId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExportDetailResponse | null>(null);
  const [detailPhase, setDetailPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailError, setDetailError] = useState<string | null>(null);

  const [exportPhase, setExportPhase] = useState<"idle" | "working">("idle");
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [actionPhase, setActionPhase] = useState<"idle" | "busy">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [downloadGate, setDownloadGate] = useState<DownloadGate | null>(null);

  // ExportRecord polling bookkeeping: last seen status (drives the read-model refresh when the
  // render leaves an in-flight state) and a re-entrancy guard for the poll interval.
  const previousStatusRef = useRef<ExportRecord["status"] | null>(null);
  const pollBusyRef = useRef(false);

  const [metadataEdits, setMetadataEdits] = useState<PackageMetadataDraft | null>(null);
  const [metadataPhase, setMetadataPhase] = useState<"idle" | "saving" | "saved" | "error" | "proposing">("idle");
  const [youtube, setYoutube] = useState<{ configured: boolean; connected: boolean; records: Array<{ id: string; state: string; remoteUrl: string | null; error: string | null }> } | null>(null);
  const [youtubePhase, setYoutubePhase] = useState<"idle" | "connecting" | "uploading">("idle");
  const [youtubeMessage, setYoutubeMessage] = useState<string | null>(null);
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null);

  const exportsList = useMemo(
    () => (readModel ? [...readModel.exports].sort((a, b) => a.createdAt - b.createdAt) : []),
    [readModel],
  );
  const prerequisites = useMemo(() => (readModel ? deriveExportPrerequisites(readModel) : null), [readModel]);
  const pkg = useMemo(() => derivePublicationPackageSafe(readModel), [readModel]);

  // Editable metadata: seeded from the derived package, then merged with the overrides persisted
  // server-side for the selected export; the creator's unsaved edits always win.
  const seededDraft = useMemo(() => (pkg.ok ? seedMetadataFromPackage(pkg.value) : null), [pkg]);
  const [savedOverrides, setSavedOverrides] = useState<PackageOverridesPayload | null>(null);
  const withOverrides = useMemo(
    () => (seededDraft ? applyOverridesToDraft(seededDraft, savedOverrides) : null),
    [seededDraft, savedOverrides],
  );
  const draft: PackageMetadataDraft =
    metadataEdits ?? withOverrides ?? { title: "", description: "", hashtags: "", chapters: "" };

  const progress = useMemo(
    () => (detail ? deriveExportProgress(detail.export, detail.failure) : null),
    [detail],
  );
  const qcRows = useMemo(() => deriveQcChecklist(detail?.qcReport ?? null), [detail?.qcReport]);
  const qcSummary = useMemo(() => summarizeQcChecklist(qcRows), [qcRows]);
  // The four text files of the manual package, built from exactly what the creator sees on screen.
  const textFiles = useMemo(() => buildTextFileDownloads(draft), [draft]);
  const textFile = (name: string) => textFiles.find((file) => file.name === name)!;

  /* ------------------------------- data loading ------------------------------- */

  useEffect(() => {
    void fetch("/api/production/platforms/youtube", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { configured?: unknown; connected?: unknown; records?: unknown } | null) => {
        if (payload && typeof payload.configured === "boolean") {
          setYoutube({ configured: payload.configured, connected: payload.connected === true, records: Array.isArray(payload.records) ? payload.records as never[] : [] });
        }
      })
      .catch(() => setYoutube(null));
  }, []);

  // Persisted server-side metadata overrides for one export; best effort — a miss keeps the seed.
  const loadOverrides = useCallback(async (exportId: string): Promise<void> => {
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(exportId)}/package?projectId=${encodeURIComponent(projectId)}&meta=1`, { cache: "no-store" });
      if (!response.ok) return;
      const payload: unknown = await response.json().catch(() => undefined);
      const parsed = payload as { overrides?: PackageOverridesPayload } | undefined;
      if (parsed?.overrides && parsed.overrides.exportId === exportId) setSavedOverrides(parsed.overrides);
    } catch { /* a missed override read never blocks the page */ }
  }, [projectId]);

  // The package (and its metadata) belongs to the basis export — the same export the publication
  // package derivation names — so saves and downloads always target it.
  const packageExportId = pkg.ok ? pkg.value.basis.exportId : null;
  const packageApproved = pkg.ok && pkg.value.basis.exportStatus === "approved";
  useEffect(() => {
    if (!packageExportId) {
      setSavedOverrides(null);
      setMetadataPhase("idle");
      setMetadataMessage(null);
      return;
    }
    void loadOverrides(packageExportId);
  }, [loadOverrides, packageExportId]);

  const loadReadModel = useCallback(async (mode: "visible" | "silent"): Promise<ProjectReadModel | null> => {
    if (mode === "visible") {
      setLoadPhase("loading");
      setLoadError(null);
    }
    try {
      const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message = await readErrorEnvelope(payload, "The project could not be loaded.");
        setReadModel(null);
        if (mode === "visible") {
          setLoadPhase("error");
          setLoadError(message);
        }
        return null;
      }
      const parsed = ProjectReadModelSchema.safeParse(payload);
      if (!parsed.success) {
        setReadModel(null);
        if (mode === "visible") {
          setLoadPhase("error");
          setLoadError("The project read model did not match the expected schema; reload to retry.");
        }
        return null;
      }
      setReadModel(parsed.data);
      setLoadPhase("ready");
      return parsed.data;
    } catch {
      setReadModel(null);
      if (mode === "visible") {
        setLoadPhase("error");
        setLoadError("The project could not be loaded: network error — the local studio server may be offline.");
      }
      return null;
    }
  }, [projectId]);

  const selectExport = useCallback(async (exportId: string) => {
    setSelectedExportId(exportId);
    setDetailPhase("loading");
    setDetailError(null);
    setDownloadGate(null);
    setActionMessage(null);
    setExportMessage(null);
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(exportId)}?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        setDetail(null);
        setDetailPhase("error");
        setDetailError(await readErrorEnvelope(payload, "The export could not be loaded."));
        return;
      }
      const parsed = ExportDetailResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setDetail(null);
        setDetailPhase("error");
        setDetailError("The export detail did not match the expected schema; reload to retry.");
        return;
      }
      previousStatusRef.current = parsed.data.export.status;
      setDetail(parsed.data);
      setDetailPhase("ready");
    } catch {
      setDetail(null);
      setDetailPhase("error");
      setDetailError("The export could not be loaded: network error — the local studio server may be offline.");
    }
  }, [projectId]);

  useEffect(() => {
    void loadReadModel("visible").then((model) => {
      const latest = model ? [...model.exports].sort((a, b) => a.createdAt - b.createdAt).at(-1) : undefined;
      if (latest) void selectExport(latest.id);
    });
  }, [loadReadModel, selectExport]);

  // Workspace rating: best effort — an unknown rating never blocks the honest export-only rules.
  const workspaceId = readModel?.project.workspaceId ?? null;
  useEffect(() => {
    if (!workspaceId) {
      setWorkspace(null);
      setWorkspaceNote(null);
      return;
    }
    let cancelled = false;
    setWorkspaceNote(null);
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { cache: "no-store" });
        const payload: unknown = await response.json().catch(() => undefined);
        if (cancelled) return;
        const parsed = WorkspaceSchema.safeParse(payload);
        if (response.ok && parsed.success) {
          setWorkspace({ name: parsed.data.name, rating: parsed.data.rating });
        } else {
          setWorkspace(null);
          setWorkspaceNote("The workspace rating couldn't be read — the export-only rules on this page apply either way.");
        }
      } catch {
        if (!cancelled) {
          setWorkspace(null);
          setWorkspaceNote("The workspace rating couldn't be read — the export-only rules on this page apply either way.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  /* ------------------------ ExportRecord polling pattern ---------------------- */

  const refreshDetailSilently = useCallback(async () => {
    if (!selectedExportId) return;
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(selectedExportId)}?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) return;
      const parsed = ExportDetailResponseSchema.safeParse(payload);
      if (!parsed.success) return;
      const previous = previousStatusRef.current;
      previousStatusRef.current = parsed.data.export.status;
      setDetail(parsed.data);
      // A finished render changes the project-level export list: refresh the read model so the
      // publication package basis (latest reviewed/approved export) stays honest.
      if (previous !== null && isExportInFlight(previous) && !isExportInFlight(parsed.data.export.status)) {
        void loadReadModel("silent");
      }
    } catch { /* transient poll errors stay silent; the next tick retries */ }
  }, [loadReadModel, projectId, selectedExportId]);

  useEffect(() => {
    if (!detail || !isExportInFlight(detail.export.status)) {
      previousStatusRef.current = detail?.export.status ?? null;
      return;
    }
    const timer = window.setInterval(() => {
      if (pollBusyRef.current) return;
      pollBusyRef.current = true;
      void refreshDetailSilently().finally(() => { pollBusyRef.current = false; });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [detail, refreshDetailSilently]);

  /* --------------------------------- actions --------------------------------- */

  const createExport = useCallback(async (model: ProjectReadModel): Promise<boolean> => {
    const command = buildManifestCommand(model);
    if (!command) {
      setExportMessage("This project isn't ready to export yet — the missing pieces are listed above.");
      return false;
    }
    const compileResponse = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}/manifests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    const compilePayload: unknown = await compileResponse.json().catch(() => undefined);
    if (!compileResponse.ok) {
      setExportMessage(await readErrorEnvelope(compilePayload, "The render manifest could not be compiled."));
      return false;
    }
    const compiled = compilePayload as { manifest?: { id?: string; inputsHash?: string } } | undefined;
    const manifestId = compiled?.manifest?.id;
    const inputsHash = compiled?.manifest?.inputsHash;
    if (!manifestId || !inputsHash) {
      setExportMessage("The compiled manifest came back incomplete — reload and try again.");
      return false;
    }
    const exportResponse = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}/exports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, manifestId, expectedManifestHash: inputsHash, idempotencyKey: `publish-${Date.now().toString(36)}` }),
    });
    const exportPayload: unknown = await exportResponse.json().catch(() => undefined);
    if (exportResponse.status !== 202 && exportResponse.status !== 200 && exportResponse.status !== 201) {
      setExportMessage(await readErrorEnvelope(exportPayload, "The export could not be queued."));
      return false;
    }
    const created = exportPayload as { id?: string } | undefined;
    const refreshed = await loadReadModel("silent");
    const exportsNow = refreshed ? [...refreshed.exports].sort((a, b) => a.createdAt - b.createdAt) : [];
    const nextId = typeof created?.id === "string" ? created.id : exportsNow.at(-1)?.id;
    if (!nextId) {
      setExportMessage("The export was queued but its record could not be loaded — reload the page to watch its progress.");
      return false;
    }
    await selectExport(nextId);
    return true;
  }, [loadReadModel, projectId, selectExport]);

  const startExport = useCallback(() => {
    if (!readModel) return;
    setExportPhase("working");
    setExportMessage(null);
    void createExport(readModel).finally(() => setExportPhase("idle"));
  }, [createExport, readModel]);

  const retryExport = useCallback(() => {
    if (!readModel) return;
    setExportPhase("working");
    setExportMessage(null);
    // Recompile (idempotent) so the retry binds a fresh manifest hash; failed exports stay kept.
    void createExport(readModel).finally(() => setExportPhase("idle"));
  }, [createExport, readModel]);

  const runQc = useCallback(async () => {
    if (!selectedExportId) return;
    setActionPhase("busy");
    setActionMessage(null);
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(selectedExportId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "run_qc" }),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (response.status !== 200) {
        setActionMessage(await readErrorEnvelope(payload, "The technical checks could not run."));
        return;
      }
      await refreshDetailSilently();
      await loadReadModel("silent");
    } catch {
      setActionMessage("The technical checks could not run: network error — the local studio server may be offline.");
    } finally {
      setActionPhase("idle");
    }
  }, [loadReadModel, refreshDetailSilently, selectedExportId]);

  const downloadVideo = useCallback(async (kind: "final" | "draft") => {
    if (!selectedExportId) return;
    setActionPhase("busy");
    setActionMessage(null);
    const url = kind === "final"
      ? `/api/production/exports/${encodeURIComponent(selectedExportId)}/download?projectId=${encodeURIComponent(projectId)}`
      : `/api/production/exports/${encodeURIComponent(selectedExportId)}/draft?projectId=${encodeURIComponent(projectId)}`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        const blob = await response.blob();
        triggerFileDownload(`${kind === "final" ? "video" : "draft-video"}-${selectedExportId}.mp4`, blob);
        setDownloadGate({ phase: "ready", message: kind === "final" ? "video.mp4 downloaded — these are the approved bytes." : "Draft video downloaded — it is clearly labeled as a draft, not the approved master." });
      } else {
        const payload: unknown = await response.json().catch(() => undefined);
        setDownloadGate(deriveDownloadGate(response.status, payload));
      }
    } catch {
      setDownloadGate(deriveDownloadGate(null, undefined));
    } finally {
      setActionPhase("idle");
    }
  }, [projectId, selectedExportId]);

  const downloadTextFile = useCallback((name: string, label: string, content: string) => {
    triggerFileDownload(name, new Blob([content], { type: "text/plain;charset=utf-8" }));
    setDownloadGate({ phase: "ready", message: `${label} downloaded as ${name}.` });
  }, []);

  const downloadPackageJson = useCallback(() => {
    if (!pkg.ok) return;
    triggerFileDownload("production.json", new Blob([buildPackageJson(pkg.value, draft)], { type: "application/json" }));
    setDownloadGate({ phase: "ready", message: "production.json downloaded — the full package data for your records." });
  }, [draft, pkg]);

  // Saves exactly what the card shows to the server, so a package download (and every later one)
  // uses the creator's edited words. Metadata is editable before publishing — approval not required.
  async function youtubeAction(kind: "connect" | "upload") {
    if (!packageExportId || youtubePhase !== "idle") return;
    setYoutubePhase(kind === "connect" ? "connecting" : "uploading");
    setYoutubeMessage(null);
    try {
      const response = await fetch("/api/production/platforms/youtube", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: kind, projectId, exportId: packageExportId, privacy: "unlisted", ...(kind === "upload" ? { confirmed: true } : {}) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const authorizeUrl = (payload as { authorizeUrl?: unknown } | null)?.authorizeUrl;
      if (kind === "connect" && typeof authorizeUrl === "string") {
        window.location.href = authorizeUrl;
        return;
      }
      const record = (payload as { record?: { state?: unknown; remoteUrl?: unknown; error?: unknown } } | null)?.record;
      if (record && typeof record.state === "string") {
        setYoutube((current) => (current ? { ...current, records: [record as never, ...current.records], connected: record.state === "completed" ? true : current.connected } : current));
        setYoutubePhase("idle");
        setYoutubeMessage(record.state === "completed" && typeof record.remoteUrl === "string" ? `Published: ${record.remoteUrl}` : typeof record.error === "string" ? `The upload failed: ${record.error}` : "Upload status updated.");
        return;
      }
      const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
      setYoutubePhase("idle");
      setYoutubeMessage(typeof message === "string" ? message : "The YouTube action failed.");
    } catch {
      setYoutubePhase("idle");
      setYoutubeMessage("The YouTube action failed: network error.");
    }
  }

  async function proposeMetadata() {
    setMetadataPhase("proposing");
    setMetadataMessage(null);
    try {
      const response = await fetch(`/api/production/projects/${encodeURIComponent(projectId)}/metadata-proposal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const metadata = (payload as { metadata?: { title?: unknown; description?: unknown; hashtags?: unknown; chapters?: unknown } } | null)?.metadata;
      if (response.ok && metadata && typeof metadata.title === "string" && typeof metadata.description === "string") {
        setMetadataEdits({
          title: metadata.title,
          description: metadata.description,
          hashtags: typeof metadata.hashtags === "string" ? metadata.hashtags : "",
          chapters: typeof metadata.chapters === "string" ? metadata.chapters : "",
        });
        setMetadataPhase("idle");
        setMetadataMessage("Drafted by the text engine — edit anything before saving; every word is yours.");
        return;
      }
      const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
      setMetadataPhase("error");
      setMetadataMessage(typeof message === "string" ? message : "The metadata draft failed.");
    } catch {
      setMetadataPhase("error");
      setMetadataMessage("The metadata draft failed: network error.");
    }
  }

  const saveMetadata = useCallback(async (): Promise<boolean> => {
    if (!packageExportId) {
      setMetadataPhase("error");
      setMetadataMessage("No publication basis export yet — metadata saves against the basis export once it exists.");
      return false;
    }
    setMetadataPhase("saving");
    setMetadataMessage(null);
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(packageExportId)}/package`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: draft.title, description: draft.description, hashtags: draft.hashtags, chapters: draft.chapters }),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        setMetadataPhase("error");
        setMetadataMessage(await readErrorEnvelope(payload, "The metadata could not be saved."));
        return false;
      }
      const parsed = payload as { overrides?: PackageOverridesPayload } | undefined;
      if (parsed?.overrides) setSavedOverrides(parsed.overrides);
      setMetadataPhase("saved");
      setMetadataMessage("Metadata saved — package downloads use exactly these words.");
      return true;
    } catch {
      setMetadataPhase("error");
      setMetadataMessage("The metadata could not be saved: network error — the local studio server may be offline.");
      return false;
    }
  }, [draft, packageExportId]);

  // Downloads the complete manual package zip; the card's current words are saved first so the
  // bundle matches the screen. The server gates on the approved export and preserves any
  // previously built package if a rebuild fails.
  const downloadPackage = useCallback(async () => {
    if (!packageExportId) return;
    setActionPhase("busy");
    setActionMessage(null);
    try {
      const saved = await saveMetadata();
      if (!saved) return;
      const response = await fetch(`/api/production/exports/${encodeURIComponent(packageExportId)}/package?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (response.ok) {
        const blob = await response.blob();
        triggerFileDownload(`publication-package-${packageExportId}.zip`, blob);
        setDownloadGate({ phase: "ready", message: "Publication package downloaded — video.mp4, thumbnail.png, captions.srt, title.txt, description.txt, hashtags.txt, chapters.txt, production.json." });
      } else {
        const payload: unknown = await response.json().catch(() => undefined);
        setDownloadGate(derivePackageDownloadGate(response.status, payload));
      }
    } catch {
      setDownloadGate(derivePackageDownloadGate(null, undefined));
    } finally {
      setActionPhase("idle");
    }
  }, [packageExportId, projectId, saveMetadata]);

  /* --------------------------------- render ---------------------------------- */

  const exportOnlyCopy = "PeraByte prepares the files and the words — nothing is uploaded automatically. You stay in control of every platform.";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8" data-testid="publish.page">
      <header className="flex flex-col gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Publish &amp; export</p>

            <div className="mt-5 rounded-[12px] border border-border bg-surface p-4" data-testid="publish.youtube">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-bold text-ink">Publish to YouTube</h3>
                <span className="text-[11px] text-muted">
                  {!youtube ? "Checking connection…" : !youtube.configured ? "Not configured on this machine" : youtube.connected ? "Channel connected" : "Channel not connected"}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-muted">
                {!youtube
                  ? "Checking whether this machine can reach YouTube."
                  : !youtube.configured
                    ? "YouTube publishing appears only after YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are set — the manual package works without any platform."
                    : youtube.connected
                      ? "Publishing uploads the approved master to your channel as unlisted. The upload is explicit, auditable, and never completes on a failure."
                      : "Connect your channel first — the connection asks consent on Google's own page."}
              </p>
              {youtube?.configured && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {!youtube.connected ? (
                    <Button type="button" size="sm" variant="secondary" icon="play" loading={youtubePhase === "connecting"} data-testid="publish.youtube.connect" onClick={() => { void youtubeAction("connect"); }}>
                      Connect YouTube
                    </Button>
                  ) : (
                    <Button type="button" size="sm" variant="primary" icon="play" loading={youtubePhase === "uploading"} disabled={!packageExportId} data-testid="publish.youtube.upload" onClick={() => { void youtubeAction("upload"); }}>
                      Publish to YouTube (unlisted)
                    </Button>
                  )}
                </div>
              )}
              {youtubeMessage && (
                <p role={youtubeMessage.startsWith("Published") ? "status" : "alert"} data-testid="publish.youtube.status" className="mt-2 text-xs text-ink-soft">
                  {youtubeMessage}
                </p>
              )}
            </div>
        <h1 className="text-xl font-bold text-ink">Ready to publish</h1>
        <p className="max-w-2xl text-sm text-muted">
          Turn your approved film into finished files: a master MP4, a technical check, and a
          complete package of words and metadata. {exportOnlyCopy}
        </p>
        {workspace && workspaceId && (
          <div data-testid="publish.workspace">
            <WorkspaceContextChip name={workspace.name} rating={workspace.rating} href={`/workspaces/${workspaceId}`} testId="publish.workspace.chip" />
          </div>
        )}
        {workspaceNote && <p className="text-[12px] text-muted">{workspaceNote}</p>}
      </header>

      {workspace?.rating === "Adult" && (
        <div role="note" data-testid="publish.rating-gate" className="rounded-[12px] border border-danger/40 bg-danger-soft/40 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-ink">
            <Icon name="lock" size={15} aria-hidden="true" />
            Export-only publishing
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
            This workspace is rated <strong>Adult</strong>. PeraByte gives you the files and the
            words, and nothing more: there is no connected-platform publishing for Adult-rated
            workspaces. Upload manually, by hand, only where it is allowed.
          </p>
        </div>
      )}

      {loadPhase === "loading" && <p role="status" data-testid="publish.loading">Loading your project…</p>}

      {loadPhase === "error" && (
        <div role="alert" data-testid="publish.error" className="rounded-[12px] border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {loadError}
          <div className="mt-3">
            <Button type="button" data-testid="publish.error.retry" onClick={() => {
              void loadReadModel("visible").then((model) => {
                const latest = model ? [...model.exports].sort((a, b) => a.createdAt - b.createdAt).at(-1) : undefined;
                if (latest) void selectExport(latest.id);
              });
            }}>
              Reload
            </Button>
          </div>
        </div>
      )}

      {loadPhase === "ready" && readModel && prerequisites && !prerequisites.canStart && exportsList.length === 0 && (
        <div data-testid="publish.empty" role="status" className="flex flex-col gap-3">
          <EmptyState
            icon="video"
            title="Nothing to publish yet"
            body="PeraByte publishes from an approved First Cut: an approved story, planned shots, and a selected take for every shot. Finish those steps and the master export starts from right here."
            testId="publish.empty.state"
            action={
              <LinkButton href="/first-cut" size="sm" data-testid="publish.empty.action">
                Open the First Cut studio
              </LinkButton>
            }
          />
          {prerequisites.issues.length > 0 && (
            <ul className="list-disc pl-5 text-[13px] text-muted" data-testid="publish.empty.issues">
              {prerequisites.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
        </div>
      )}

      {loadPhase === "ready" && readModel && prerequisites && prerequisites.canStart && exportsList.length === 0 && (
        <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="publish.export.card">
          <h2 className="text-sm font-bold text-ink">Export the master MP4</h2>
          <p className="mt-1 max-w-xl text-sm text-muted">
            PeraByte compiles your approved edit into a render manifest, then renders the master
            video locally. It takes a few minutes, and you can leave this page — progress lives
            here when you come back.
          </p>
          <div className="mt-4">
            <Button type="button" icon="video" loading={exportPhase === "working"} data-testid="publish.export.start" onClick={startExport}>
              Export master (MP4)
            </Button>
          </div>
          {exportMessage && <p role="alert" data-testid="publish.export.alert" className="mt-3 text-xs text-danger">{exportMessage}</p>}
        </section>
      )}

      {loadPhase === "ready" && exportsList.length > 0 && (
        <section className="flex flex-col gap-3" data-testid="publish.export.section">
          {exportsList.length > 1 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-bold text-ink">Exports ({exportsList.length})</h2>
              <div className="flex flex-col gap-2" data-testid="publish.export.list">
                {exportsList.map((exportRecord) => (
                  <button
                    key={exportRecord.id}
                    type="button"
                    data-testid="publish.export.item"
                    aria-pressed={exportRecord.id === selectedExportId}
                    onClick={() => { void selectExport(exportRecord.id); }}
                    className={`flex items-center justify-between gap-3 rounded-[10px] border px-4 py-2.5 text-left text-sm transition-colors ${exportRecord.id === selectedExportId ? "border-primary bg-primary/5 text-ink" : "border-border bg-raised text-ink-soft hover:border-muted"}`}
                  >
                    <span className={`truncate ${MONO}`}>{exportRecord.id}</span>
                    <Badge tone={STATUS_TONE[exportRecord.status]}>{exportRecord.status}</Badge>
                  </button>
                ))}
              </div>
            </div>
          )}

          {detailPhase === "loading" && <p role="status" data-testid="publish.export-detail.loading">Loading export…</p>}
          {detailPhase === "error" && (
            <div role="alert" className="rounded-[12px] border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
              {detailError}
              <div className="mt-3">
                <Button type="button" variant="secondary" onClick={() => { if (selectedExportId) void selectExport(selectedExportId); }}>Reload</Button>
              </div>
            </div>
          )}

          {detail && progress && (
            <div className="flex flex-col gap-3" data-testid="publish.export.card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-ink">Master export</h2>
                <Badge tone={STATUS_TONE[detail.export.status]}>{detail.export.status}</Badge>
              </div>
              <p className={`text-muted ${MONO}`} data-testid="publish.export.id">{detail.export.id}</p>
              {detail.manifestSummary && (
                <p className="text-[12px] text-muted" data-testid="publish.export.manifest-summary">
                  {detail.manifestSummary.profile.aspect} · {detail.manifestSummary.profile.width}×{detail.manifestSummary.profile.height} ·{" "}
                  {detail.manifestSummary.profile.fps} fps · {detail.manifestSummary.shotCount}{" "}
                  {detail.manifestSummary.shotCount === 1 ? "shot" : "shots"} · manifest {detail.manifestSummary.inputsHash.slice(0, 12)}…
                </p>
              )}
              <GenerationStatus
                phase={progress.phase}
                stage={progress.stage}
                failureMessage={progress.failureMessage ?? undefined}
                onRetry={progress.retryable ? retryExport : undefined}
                retryInFlight={exportPhase === "working"}
                testId="publish.export.status"
              />
              <div className="flex flex-wrap items-center gap-2">
                {detail.export.status === "qc_pending" && (
                  <Button type="button" icon="check" loading={actionPhase === "busy"} data-testid="publish.export.run-qc" onClick={() => { void runQc(); }}>
                    Run technical checks
                  </Button>
                )}
                {detail.export.status === "ready_for_review" && (
                  <LinkButton href={`/production/${projectId}/export`} size="md" icon="arrow-right" data-testid="publish.export.review-link">
                    Finish review &amp; approval
                  </LinkButton>
                )}
                {detail.export.status === "ready_for_review" && (
                  <p className="text-[12px] text-muted">
                    Your human review happens on the export page — approving the exact file unlocks the final download.
                  </p>
                )}
              </div>
              {exportMessage && <p role="alert" data-testid="publish.export.alert" className="text-xs text-danger">{exportMessage}</p>}
              {actionMessage && <p role="alert" data-testid="publish.action-alert" className="text-xs text-danger">{actionMessage}</p>}
              {downloadGate && (
                <p role={downloadGate.phase === "ready" ? "status" : "alert"} data-testid="publish.download-gate" className={`text-xs ${downloadGate.phase === "ready" ? "text-success" : "text-danger"}`}>
                  {downloadGate.message}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {detail && (
        <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="publish.qc.card">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-ink">Technical checks</h2>
            {detail.qcReport ? (
              <>
                <span data-testid="publish.qc.verdict">
                  <Badge tone={detail.qcReport.verdict === "passed" ? "success" : "danger"}>
                    {detail.qcReport.verdict === "passed" ? "All checks passed" : "Problems found"}
                  </Badge>
                </span>
                {detail.qcReport.draftOnly && <Badge tone="warning">Silent draft — no audio</Badge>}
              </>
            ) : (
              <Badge tone="neutral">Pending</Badge>
            )}
          </div>

          {!detail.qcReport && (
            <p className="mt-2 text-sm text-muted" data-testid="publish.qc.pending">
              {detail.export.status === "queued" || detail.export.status === "rendering"
                ? "The checks run on the finished file — they appear here once the render completes."
                : detail.export.status === "qc_pending"
                  ? "The file is rendered. Run the technical checks above to measure it."
                  : detail.export.status === "failed" || detail.export.status === "canceled"
                    ? "The render didn't finish, so there is nothing to check yet."
                    : "No check report is attached to this export."}
            </p>
          )}

          {detail.qcReport && (
            <>
              <p className="mt-2 text-[13px] font-medium text-ink-soft" data-testid="publish.qc.summary">
                {qcSummary.failed === 0
                  ? `All ${qcSummary.total} checks passed — the file plays, sounds right, and matches your edit.`
                  : `${qcSummary.passed} of ${qcSummary.total} checks passed. ${qcSummary.failed === 1 ? "One check needs" : "Some checks need"} attention below.`}
              </p>
              <ul className="mt-3 flex flex-col gap-2" data-testid="publish.qc.checklist">
                {qcRows.map((row) => (
                  <li
                    key={row.id}
                    data-testid="publish.qc.check"
                    data-check-id={row.id}
                    data-state={row.state}
                    className={`rounded-[8px] border p-3 ${row.state === "pass" ? "border-border bg-surface" : "border-danger/40 bg-danger/5"}`}
                  >
                    <p className={`flex items-center gap-2 text-[13px] font-bold ${row.state === "pass" ? "text-ink" : "text-danger"}`}>
                      <Icon name={row.state === "pass" ? "check" : "alert"} size={14} aria-hidden="true" />
                      {row.label}
                      <span className="sr-only">{row.state === "pass" ? " — passed" : " — failed"}</span>
                    </p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{row.explanation}</p>
                    <p className={`mt-1 text-[11px] text-muted ${MONO}`}>{row.detail}</p>
                  </li>
                ))}
              </ul>

              {detail.qcReport.blockers.length > 0 && (
                <div className="mt-3 rounded-[10px] border border-danger/40 bg-danger/5 p-3 text-sm text-danger" data-testid="publish.qc.blockers">
                  <p className="font-semibold">What stopped this export from passing</p>
                  <ul className="mt-1 list-disc pl-5">
                    {detail.qcReport.blockers.map((blocker, index) => (
                      <li key={`${blocker.code}-${index}`}>{blocker.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {detail.qcReport.advisories.length > 0 && (
                <div className="mt-3 rounded-[10px] border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="publish.qc.advisories">
                  <p className="font-semibold text-ink">
                    {detail.qcReport.advisories.length === 1 ? "One thing worth a look" : `${detail.qcReport.advisories.length} things worth a look`}
                  </p>
                  <ul className="mt-1 list-disc pl-5">
                    {detail.qcReport.advisories.slice(0, 5).map((advisory, index) => (
                      <li key={`${advisory.code}-${index}`} className="text-[13px] text-ink-soft">{advisory.message}</li>
                    ))}
                  </ul>
                  {detail.qcReport.advisories.length > 5 && (
                    <p className="mt-1 text-[12px] text-muted">{detail.qcReport.advisories.length - 5} more on the export page.</p>
                  )}
                  <p className="mt-2 text-[12px] text-muted">
                    These are hints, not failures — each one needs a short written acknowledgement during your final review on the export page.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {loadPhase === "ready" && exportsList.length > 0 && (
        pkg.ok ? (
          <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="publish.package">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-ink">Publication package</h2>
              <span className={`text-muted ${MONO}`} data-testid="publish.package.basis">basis export {pkg.value.basis.exportId}</span>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Everything a platform asks for, in one manual bundle. PeraByte never uploads it —
              download the files and publish them yourself.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                icon="download"
                loading={actionPhase === "busy"}
                disabled={!packageApproved}
                data-testid="publish.package.download"
                onClick={() => { void downloadPackage(); }}
              >
                Download package (zip)
              </Button>
              <p className="text-[12px] text-muted" data-testid="publish.package.download-hint">
                {packageApproved
                  ? "One zip with the whole bundle — your saved metadata words are used exactly as shown below."
                  : "The package unlocks when the basis export passes your review and approval — the same gate as the approved master download."}
              </p>
            </div>

            <ul className="mt-4 flex flex-col gap-4" data-testid="publish.package.files">
              <li data-testid="publish.package.video">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[13px] font-bold text-ink">
                    <Icon name="video" size={14} className="mr-1.5 inline" aria-hidden="true" />
                    video.mp4 — the film itself
                  </p>
                  <div className="flex gap-2">
                    {detail?.export.status === "approved" && (
                      <Button type="button" size="sm" icon="download" disabled={actionPhase === "busy"} data-testid="publish.package.video.final-download" onClick={() => { void downloadVideo("final"); }}>
                        Download approved master
                      </Button>
                    )}
                    {detail && ["qc_pending", "qc_failed", "ready_for_review"].includes(detail.export.status) && (
                      <Button type="button" size="sm" variant="secondary" icon="download" disabled={actionPhase === "busy"} data-testid="publish.package.video.draft-download" onClick={() => { void downloadVideo("draft"); }}>
                        Download labeled draft
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-[12px] text-muted">
                  {detail?.export.status === "approved"
                    ? "These are the approved bytes — the same file your review signed off."
                    : detail && ["qc_pending", "qc_failed", "ready_for_review"].includes(detail.export.status)
                      ? "A clearly labeled draft for checking. The approved master unlocks after your review."
                      : "The video file appears once this export finishes."}
                </p>
              </li>

              <li data-testid="publish.package.thumbnail">
                <p className="text-[13px] font-bold text-ink">thumbnail.png — the cover image</p>
                <p className="mt-1 text-[12px] text-muted">
                  Generated into the package zip: a real frame from your approved master, pulled at
                  roughly ten percent into the film and capped at 1080p-class size. Reference
                  frames pinned in the storyboard ({pkg.value.thumbnailCandidates.length}) stay
                  available as alternatives.
                </p>
              </li>

              <li data-testid="publish.package.captions">
                <p className="text-[13px] font-bold text-ink">captions.srt — the subtitles</p>
                <p className="mt-1 text-[12px] text-muted">
                  {detail?.manifestSummary
                    ? "Built into the package zip from your edit's caption cues, timed on the render timeline at 24 fps. Cues are managed in the First Cut timeline; with no cues yet the file ships empty rather than guessed."
                    : "Built into the package zip from your edit's caption cues, timed on the render timeline. Nothing here is guessed."}
                </p>
              </li>
            </ul>

            <div className="mt-5 rounded-[12px] border border-border bg-surface p-4" data-testid="publish.metadata">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-bold text-ink">Package metadata</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {metadataPhase === "saved" && <Badge tone="success">Saved</Badge>}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon="pen"
                    loading={metadataPhase === "proposing"}
                    data-testid="publish.metadata.propose"
                    onClick={() => { void proposeMetadata(); }}
                  >
                    Draft with AI
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon="check"
                    loading={metadataPhase === "saving"}
                    disabled={!packageExportId}
                    data-testid="publish.metadata.save"
                    onClick={() => { void saveMetadata(); }}
                  >
                    Save metadata
                  </Button>
                </div>
              </div>
              <p className="mt-1 text-[12px] text-muted">
                Editable any time before publishing — saved server-side against basis export{" "}
                <span className={MONO}>{packageExportId ?? "—"}</span> and used verbatim in the package zip.
              </p>
              {metadataMessage && (
                <p role={metadataPhase === "error" ? "alert" : "status"} data-testid="publish.metadata.status" className={`mt-2 text-xs ${metadataPhase === "error" ? "text-danger" : "text-success"}`}>
                  {metadataMessage}
                </p>
              )}

              <div className="mt-4 flex flex-col gap-5">
                <div data-testid="publish.metadata.title">
                  <TextAreaField
                    label="Title (saved as title.txt)"
                    value={draft.title}
                    maxLength={METADATA_LIMITS.title}
                    rows={2}
                    onChange={(title) => setMetadataEdits((previous) => ({ ...(previous ?? draft), title }))}
                    hint="Suggested from your project name — edit freely; platforms see what you write."
                  />
                  {pkg.value.title.truncated && (
                    <p className="mt-1 text-[12px] text-muted" data-testid="publish.package.title-truncated">
                      PeraByte trimmed the suggested title to {pkg.value.title.maxLength} characters to fit platform limits.
                    </p>
                  )}
                  <Button type="button" size="sm" variant="secondary" icon="download" data-testid="publish.package.title.download" onClick={() => { const file = textFile("title.txt"); downloadTextFile(file.name, file.label, file.content); }}>
                    Download title.txt
                  </Button>
                </div>

                <div data-testid="publish.metadata.description">
                  <TextAreaField
                    label="Description (saved as description.txt)"
                    value={draft.description}
                    maxLength={METADATA_LIMITS.description}
                    rows={6}
                    onChange={(description) => setMetadataEdits((previous) => ({ ...(previous ?? draft), description }))}
                    hint="Parts in parentheses are yours to write — PeraByte never invents credits or claims."
                  />
                  <Button type="button" size="sm" variant="secondary" icon="download" data-testid="publish.package.description.download" onClick={() => { const file = textFile("description.txt"); downloadTextFile(file.name, file.label, file.content); }}>
                    Download description.txt
                  </Button>
                </div>

                <div data-testid="publish.metadata.hashtags">
                  <TextAreaField
                    label="Hashtags (saved as hashtags.txt)"
                    value={draft.hashtags}
                    maxLength={METADATA_LIMITS.hashtags}
                    rows={2}
                    placeholder="Write your own hashtags — PeraByte doesn't invent them."
                    onChange={(hashtags) => setMetadataEdits((previous) => ({ ...(previous ?? draft), hashtags }))}
                  />
                  <Button type="button" size="sm" variant="secondary" icon="download" data-testid="publish.package.hashtags.download" onClick={() => { const file = textFile("hashtags.txt"); downloadTextFile(file.name, file.label, file.content); }}>
                    Download hashtags.txt
                  </Button>
                </div>

                <div data-testid="publish.metadata.chapters">
                  <TextAreaField
                    label="Chapters (saved as chapters.txt)"
                    value={draft.chapters}
                    maxLength={METADATA_LIMITS.chapters}
                    rows={4}
                    placeholder={"0:00 Your opening shot\n0:24 The next moment"}
                    onChange={(chapters) => setMetadataEdits((previous) => ({ ...(previous ?? draft), chapters }))}
                    hint="Timestamps plus short labels — paste them into your platform's chapter box."
                  />
                  <Button type="button" size="sm" variant="secondary" icon="download" data-testid="publish.package.chapters.download" onClick={() => { const file = textFile("chapters.txt"); downloadTextFile(file.name, file.label, file.content); }}>
                    Download chapters.txt
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" size="sm" variant="secondary" icon="download" data-testid="publish.package.json.download" onClick={downloadPackageJson}>
                    Download production.json
                  </Button>
                  <p className="text-[12px] text-muted">The full package data — manifest basis, metadata, and checklist — for your records.</p>
                </div>
              </div>
            </div>

            <p className="mt-4 rounded-[8px] bg-surface-2 p-3 text-[12px] leading-relaxed text-muted" data-testid="publish.package.disclaimer">
              {MANUAL_UPLOAD_DISCLAIMER}
            </p>

            <div className="mt-4 rounded-[12px] border border-border bg-surface p-4" data-testid="publish.platform.unavailable">
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex items-center gap-2 text-[13px] font-bold text-ink">
                  <Icon name="lock" size={14} aria-hidden="true" />
                  Publish to YouTube
                </p>
                <Badge tone="neutral">Not available yet</Badge>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                Publishing platforms arrive in a later release. Until then the package is the
                product: download the files above and upload them yourself. Nothing here connects
                to any platform.
              </p>
            </div>
          </section>
        ) : (
          <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="publish.package.pending" role="status">
            <h2 className="text-sm font-bold text-ink">Publication package</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              The package builds from an export that has passed technical checks (or your full
              approval). It isn&apos;t ready yet — {pkg.message}
            </p>
          </section>
        )
      )}
    </div>
  );
}

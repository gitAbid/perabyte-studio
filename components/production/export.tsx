"use client";

/**
 * C12 export QC + final-review/download UI.
 *
 * Speaks HTTP only: reads the project read model (GET /api/production/projects/:id) and the export
 * detail (GET /api/production/exports/:id?projectId=), then mutates through POST run_qc /
 * final_review and the strictly separated final vs draft download routes. Every rule shown here is
 * derived from the server's own artifacts (export record, QC report, failure record) — no server
 * validation is reimplemented. The exported plain functions at the top are pure view-model helpers
 * (no hooks, no window, no fetch) so node tests can import them.
 *
 * Fail-closed rules honored throughout: a draft/QC-failed artifact is always labeled "Draft /
 * QC-failed" and never receives "Ready to upload"; the final badge appears only for an approved
 * export whose checksum matches its QC report; silent drafts surface as never-approvable.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState } from "@/components/ui";
import { derivePackageDownloadGate, PACKAGE_ZIP_FILES } from "@/components/production/publish";
import { ProjectReadModelSchema, type ExportRecord } from "@/lib/production/contracts";
import {
  ExportDetailResponseSchema, FailureRecordSchema, QcReportSchema, FINAL_REVIEW_CHECKLIST_IDS,
  type FailureRecord, type FinalReviewCommand, type QcReport,
} from "@/lib/production/qc";

export { FINAL_REVIEW_CHECKLIST_IDS };

/* ================================================================== */
/* Pure view-model helpers (no hooks / window / fetch — test in node)  */
/* ================================================================== */

export type FinalChecklistDraft = { id: string; passed: boolean; note: string };
export type AdvisoryAckDraft = { code: string; reason: string };

export type ExportViewState = {
  status: ExportRecord["status"];
  headline: string;
  detail: string;
  canRunQc: boolean;
  canRetryExport: boolean;
  canDraftDownload: boolean;
  canFinalDownload: boolean;
  canFinalReview: boolean;
  badges: { final: boolean; draft: boolean };
  finalLabel: string | null;
  draftLabel: string | null;
  outputSha256: string | null;
  manifestInputsHash: string | null;
};

const DRAFT_LABEL = "Draft / QC-failed download";
const FINAL_LABEL = "Ready to upload";

/**
 * Per-status rendering rules. The final badge requires the approved status AND a checksum match
 * against the QC report's measured output sha256; draft-eligible artifacts carry the explicit
 * draft badge and can never render the release badge.
 */
export function deriveExportViewState(input: {
  exportRecord: ExportRecord;
  qcReport: QcReport | null;
  failure: FailureRecord | null;
}): ExportViewState {
  const { exportRecord, qcReport, failure } = input;
  const status = exportRecord.status;
  const checksumMatch = exportRecord.approvedSha256 !== null && qcReport !== null && exportRecord.approvedSha256 === qcReport.outputSha256;
  const canDraftDownload = ["qc_pending", "qc_failed", "ready_for_review"].includes(status) && exportRecord.assetId !== null;
  const badges = {
    final: status === "approved" && checksumMatch,
    draft: canDraftDownload,
  };
  const base: ExportViewState = {
    status,
    headline: status,
    detail: "",
    canRunQc: status === "qc_pending",
    canRetryExport: status === "qc_failed" || status === "failed" || status === "canceled",
    canDraftDownload,
    canFinalDownload: status === "approved",
    canFinalReview: status === "ready_for_review",
    badges,
    finalLabel: badges.final ? FINAL_LABEL : null,
    draftLabel: canDraftDownload ? DRAFT_LABEL : null,
    outputSha256: qcReport?.outputSha256 ?? null,
    manifestInputsHash: qcReport?.manifestInputsHash ?? null,
  };
  switch (status) {
    case "queued":
      return { ...base, headline: "Queued for rendering", detail: "The export waits for the local render slot. Nothing has been rendered yet, so there is nothing to download." };
    case "rendering":
      return { ...base, headline: "Rendering with local FFmpeg", detail: "The manifest is being assembled right now. The artifact appears once the render commits." };
    case "qc_pending":
      return { ...base, headline: "Rendered — technical QC pending", detail: "The render committed an artifact. Run technical QC to measure it against the frozen profile (codec, dimensions, fps, duration, loudness, true peak, checksum)." };
    case "qc_failed":
      return { ...base, headline: "Technical QC failed", detail: "Automated blockers were measured on the output. Inspect the report below; the artifact stays inspectable through the clearly labeled draft download, and retrying creates a new export." };
    case "ready_for_review":
      return { ...base, headline: qcReport?.draftOnly ? "Silent draft — never release-ready" : "Ready for your final review", detail: qcReport?.draftOnly
        ? "This export has no audio cues (silent-draft profile). It can be downloaded as a labeled draft but can never be approved or become release-ready."
        : "Technical QC passed. Watch the exact downloadable bytes end to end, answer the four checklist items, acknowledge every advisory with a reason, then approve or reject the exact output checksum." };
    case "approved":
      return { ...base, headline: checksumMatch ? "Approved — ready to upload" : "Approved (checksum drift detected)", detail: checksumMatch
        ? "The human final review approved the exact output checksum. The final download serves those approved bytes."
        : "The export record is approved, but its approved checksum no longer matches the QC report's output checksum. The final download will refuse the request until the export is re-rendered, re-measured, and re-approved." };
    case "failed":
      return { ...base, headline: "Export failed", detail: failure ? `The render failed at stage "${failure.stage}" (${failure.code}). Inspect the redacted tool output below and retry as a new export; nothing was deleted.` : "The render failed. Retry as a new export; nothing was deleted." };
    case "canceled":
      return { ...base, headline: "Export canceled", detail: "The render was canceled before it committed an artifact. Retry as a new export." };
  }
}

export type DownloadGate = { phase: "ready" | "blocked" | "error"; message: string };

/**
 * Maps a download-route response onto honest UI text: 428 names the human G09 requirement, 409
 * names the stale-checksum recovery, 404/400/network name the error. Nothing here fabricates a
 * success; 200 is the only ready state.
 */
export function deriveDownloadGate(httpStatus: number | null, payload: unknown): DownloadGate {
  const envelope = payload !== null && typeof payload === "object" ? (payload as { error?: { code?: unknown; message?: unknown }; requestId?: unknown }) : null;
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : "UNKNOWN";
  const serverMessage = typeof envelope?.error?.message === "string" ? envelope.error.message : "";
  const requestId = typeof envelope?.requestId === "string" ? envelope.requestId : "unknown";
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    return { phase: "ready", message: "Download unlocked — these are the approved bytes." };
  }
  if (httpStatus === 428 || code === "APPROVAL_REQUIRED") {
    return { phase: "blocked", message: `Final download locked (HTTP 428): technical QC plus the human G09 final review and approval of the exact output checksum are required. Technical QC alone never unlocks the final download. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 409) {
    return { phase: "blocked", message: `Download blocked (HTTP 409 ${code}): ${code === "STALE_REVISION" ? "the approved checksum is stale — the output was re-encoded, so run technical QC again and approve the new checksum" : "this route cannot serve the artifact in its current state"}. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 404) {
    return { phase: "error", message: `Download failed (HTTP 404): this export or its manifest is unknown locally. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 400) {
    return { phase: "error", message: `Download refused (HTTP 400): the request is scoped to the owning project — the projectId parameter must match the export's owning project. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === null) {
    return { phase: "error", message: "Download failed: network error — the local studio server could not be reached. Retry once it is running." };
  }
  return { phase: "error", message: `Download failed (HTTP ${httpStatus} ${code}): ${serverMessage || "the server answered with a response this page does not understand"}. (requestId ${requestId})` };
}

export type FinalReviewReadiness =
  | { ok: true; command: FinalReviewCommand & { kind: "final_review" } }
  | { ok: false; issues: string[] };

/**
 * The client-side G09 preflight, mirroring (never replacing) the service's own validation: the
 * report must exist, have passed, and not be a silent draft; approval requires every advisory
 * acknowledged with a nonempty reason, the complete four-item binary checklist, and the exact
 * expectedOutputSha256 the approval binds.
 */
export function deriveFinalReviewReadiness(input: {
  exportRecord: ExportRecord;
  report: QcReport | null;
  decision: "approved" | "rejected";
  checklist: FinalChecklistDraft[];
  acknowledgements: AdvisoryAckDraft[];
  notes: string;
  expectedOutputSha256: string | null;
  idempotencyKey: string;
}): FinalReviewReadiness {
  const { exportRecord, report, decision, checklist, acknowledgements, notes, expectedOutputSha256, idempotencyKey } = input;
  const issues: string[] = [];
  if (exportRecord.status !== "ready_for_review") issues.push("The export is not in ready_for_review; the final review is unavailable.");
  if (!report) issues.push("The QC report is unavailable; run technical QC again before reviewing.");
  else {
    if (report.verdict !== "passed") issues.push("Technical QC did not pass; the final review requires a passed report.");
    if (report.draftOnly) issues.push("This export is a silent draft (draftOnly): it can never be approved or become release-ready; use the clearly labeled draft download.");
    if (decision === "approved") {
      for (const advisory of report.advisories) {
        const acknowledgement = acknowledgements.find((item) => item.code === advisory.code);
        if (!acknowledgement || acknowledgement.reason.trim().length === 0) {
          issues.push(`Advisory ${advisory.code} needs an explicit acknowledgement reason before approval.`);
        }
      }
      if (expectedOutputSha256 === null) issues.push("The exact expectedOutputSha256 the approval binds is required.");
      else if (expectedOutputSha256 !== report.outputSha256) issues.push(`The approval must bind the exact measured output checksum ${report.outputSha256} (received ${expectedOutputSha256}); a drifted checksum means the export must be re-run and re-reviewed.`);
    }
  }
  const requiredIds = [...FINAL_REVIEW_CHECKLIST_IDS];
  const checklistIds = checklist.map((item) => item.id);
  if (checklist.length !== requiredIds.length || new Set(checklistIds).size !== checklistIds.length ||
      requiredIds.some((id) => !checklistIds.includes(id))) {
    issues.push(`The final checklist must answer exactly these items once each: ${requiredIds.join(", ")}.`);
  } else if (decision === "approved" && checklist.some((item) => !item.passed)) {
    const failed = checklist.filter((item) => !item.passed).map((item) => item.id);
    issues.push(`An approval cannot include failed checklist items (${failed.join(", ")}); reject instead or re-check after fixing.`);
  }
  if (decision === "rejected" && notes.trim().length === 0 && !checklist.some((item) => !item.passed && item.note.trim().length > 0)) {
    issues.push("A rejection requires notes or a failed checklist item with a reason.");
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    command: {
      kind: "final_review",
      idempotencyKey,
      decision,
      checklist: checklist.map((item) => ({ id: item.id, passed: item.passed, note: item.note })),
      notes,
      advisoryAcknowledgements: acknowledgements.filter((item) => item.reason.trim().length > 0),
      expectedOutputSha256: report!.outputSha256,
    },
  };
}

/* ================================================================== */
/* Workspace component                                                */
/* ================================================================== */

const MONO = "font-mono text-[12px] break-all";

function describeMeasuredNumber(value: number | null, suffix: string): string {
  return value === null ? "not measured" : `${value}${suffix}`;
}

export function ExportWorkspace({ projectId }: { projectId: string }) {
  const [readModel, setReadModel] = useState<ExportRecord[]>([]);
  const [loadPhase, setLoadPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedExportId, setSelectedExportId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ export: ExportRecord; manifestSummary: { shotCount: number; audioCueCount: number; inputsHash: string; profile: { width: number; height: number; fps: number } }; qcReport: QcReport | null; failure: FailureRecord | null; owningProjectId: string } | null>(null);
  const [detailPhase, setDetailPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionPhase, setActionPhase] = useState<"idle" | "busy">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [downloadGate, setDownloadGate] = useState<DownloadGate | null>(null);
  const [checklist, setChecklist] = useState<FinalChecklistDraft[]>([]);
  const [acknowledgements, setAcknowledgements] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [reviewDecision, setReviewDecision] = useState<"approved" | "rejected">("approved");

  const load = useCallback(async (reason: "mount" | "manual"): Promise<ExportRecord[]> => {
    setLoadPhase("loading");
    setLoadError(null);
    try {
      const response = await fetch(`/api/production/projects/${projectId}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const envelope = payload as { error?: { code?: string; message?: string }; requestId?: string } | undefined;
        setReadModel([]);
        setLoadPhase("error");
        setLoadError(`${envelope?.error?.code ?? "UNKNOWN"}: ${envelope?.error?.message ?? "The project could not be loaded."} (requestId ${envelope?.requestId ?? "unknown"})`);
        return [];
      }
      const parsed = ProjectReadModelSchema.safeParse(payload);
      if (!parsed.success) {
        setReadModel([]);
        setLoadPhase("error");
        setLoadError("The project read model did not match the expected schema; reload to retry.");
        return [];
      }
      const exportsList = [...parsed.data.exports].sort((a, b) => a.createdAt - b.createdAt);
      setReadModel(exportsList);
      setLoadPhase("ready");
      return exportsList;
    } catch {
      setReadModel([]);
      setLoadPhase("error");
      setLoadError("The project could not be loaded: network error — the local studio server may be offline.");
      return [];
    }
  }, [projectId]);

  const loadDetail = useCallback(async (exportId: string): Promise<void> => {
    setDetailPhase("loading");
    setDetailError(null);
    setSelectedExportId(exportId);
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(exportId)}?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const payload: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const envelope = payload as { error?: { code?: string; message?: string }; requestId?: string } | undefined;
        setDetail(null);
        setDetailPhase("error");
        setDetailError(`${envelope?.error?.code ?? "UNKNOWN"}: ${envelope?.error?.message ?? "The export could not be loaded."} (requestId ${envelope?.requestId ?? "unknown"})`);
        return;
      }
      const parsed = ExportDetailResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setDetail(null);
        setDetailPhase("error");
        setDetailError("The export detail did not match the expected schema; reload to retry.");
        return;
      }
      setDetail(parsed.data);
      setDetailPhase("ready");
      const report = parsed.data.qcReport;
      setChecklist(report ? [...FINAL_REVIEW_CHECKLIST_IDS].map((id) => ({ id, passed: true, note: "" })) : []);
      setAcknowledgements({});
      setNotes("");
      setReviewDecision("approved");
      setDownloadGate(null);
      setActionMessage(null);
    } catch {
      setDetail(null);
      setDetailPhase("error");
      setDetailError("The export could not be loaded: network error — the local studio server may be offline.");
    }
  }, [projectId]);

  useEffect(() => {
    void load("mount").then((exportsList) => {
      const latest = exportsList[exportsList.length - 1];
      if (latest) void loadDetail(latest.id);
    });
  }, [load, loadDetail]);

  const postJson = async (url: string, body: unknown): Promise<{ status: number; payload: unknown }> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json().catch(() => undefined) };
  };

  const describeFailure = (status: number, payload: unknown, fallback: string): string => {
    const envelope = payload as { error?: { code?: string; message?: string; action?: string }; requestId?: string } | null;
    if (!envelope?.error) return `${fallback} (network error)`;
    return `${envelope.error.code ?? "UNKNOWN"}: ${envelope.error.message ?? fallback}${envelope.error.action ? ` — ${envelope.error.action}` : ""} (requestId ${envelope.requestId ?? "unknown"})`;
  };

  async function runQc() {
    if (!selectedExportId) return;
    setActionPhase("busy");
    setActionMessage(null);
    try {
      const { status, payload } = await postJson(`/api/production/exports/${encodeURIComponent(selectedExportId)}`, { kind: "run_qc" });
      if (status !== 200) {
        setActionMessage(describeFailure(status, payload, "Technical QC could not run."));
      } else {
        await loadDetail(selectedExportId);
      }
    } catch {
      setActionMessage("Technical QC could not run: network error — the local studio server may be offline.");
    } finally {
      setActionPhase("idle");
    }
  }

  async function retryExport() {
    if (!detail) return;
    setActionPhase("busy");
    setActionMessage(null);
    try {
      const idempotencyKey = `retry-${detail.export.id}-${Date.now().toString(36)}`;
      const { status, payload } = await postJson(`/api/production/projects/${encodeURIComponent(projectId)}/exports`, {
        projectId, manifestId: detail.export.manifestId, expectedManifestHash: detail.manifestSummary.inputsHash, idempotencyKey,
      });
      if (status !== 202 && status !== 200 && status !== 201) {
        setActionMessage(describeFailure(status, payload, "The retry could not be queued."));
        return;
      }
      const created = payload as { id?: string } | undefined;
      const exportsList = await load("manual");
      const nextId = typeof created?.id === "string" ? created.id : exportsList[exportsList.length - 1]?.id;
      if (nextId) await loadDetail(nextId);
    } catch {
      setActionMessage("The retry could not be queued: network error — the local studio server may be offline.");
    } finally {
      setActionPhase("idle");
    }
  }

  async function submitReview(decision: "approved" | "rejected") {
    if (!detail?.qcReport || !selectedExportId) return;
    const readiness = deriveFinalReviewReadiness({
      exportRecord: detail.export, report: detail.qcReport, decision, checklist,
      acknowledgements: Object.entries(acknowledgements).map(([code, reason]) => ({ code, reason })),
      notes, expectedOutputSha256: detail.qcReport.outputSha256,
      idempotencyKey: `final-review-${detail.export.id}-${Date.now().toString(36)}`,
    });
    if (!readiness.ok) {
      setActionMessage(readiness.issues.join(" "));
      return;
    }
    setActionPhase("busy");
    setActionMessage(null);
    try {
      const { status, payload } = await postJson(`/api/production/exports/${encodeURIComponent(selectedExportId)}`, readiness.command);
      if (status !== 200 && status !== 201) {
        setActionMessage(describeFailure(status, payload, "The final review could not be recorded."));
        return;
      }
      await loadDetail(selectedExportId);
    } catch {
      setActionMessage("The final review could not be recorded: network error — the local studio server may be offline.");
    } finally {
      setActionPhase("idle");
    }
  }

  async function download(kind: "final" | "draft") {
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
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `${kind === "final" ? "export" : "draft-export"}-${selectedExportId}.mp4`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        setDownloadGate({ phase: "ready", message: kind === "final" ? "Final download served the approved bytes." : "Draft download served the clearly labeled draft bytes." });
      } else {
        const payload: unknown = await response.json().catch(() => undefined);
        setDownloadGate(deriveDownloadGate(response.status, payload));
      }
    } catch {
      setDownloadGate(deriveDownloadGate(null, undefined));
    } finally {
      setActionPhase("idle");
    }
  }

  // M4-5: the complete manual publication package zip, gated server-side exactly like the final
  // download (approved export, checksum still matching). Nothing here uploads anywhere.
  async function downloadPackage() {
    if (!selectedExportId) return;
    setActionPhase("busy");
    setActionMessage(null);
    try {
      const response = await fetch(`/api/production/exports/${encodeURIComponent(selectedExportId)}/package?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      if (response.ok) {
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `publication-package-${selectedExportId}.zip`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        setDownloadGate({ phase: "ready", message: `Publication package downloaded — ${PACKAGE_ZIP_FILES.join(", ")}.` });
      } else {
        const payload: unknown = await response.json().catch(() => undefined);
        setDownloadGate(derivePackageDownloadGate(response.status, payload));
      }
    } catch {
      setDownloadGate(derivePackageDownloadGate(null, undefined));
    } finally {
      setActionPhase("idle");
    }
  }

  const view = useMemo(
    () => (detail ? deriveExportViewState({ exportRecord: detail.export, qcReport: detail.qcReport, failure: detail.failure }) : null),
    [detail],
  );
  const readiness = useMemo(() => {
    if (!detail || !view?.canFinalReview) return null;
    return deriveFinalReviewReadiness({
      exportRecord: detail.export, report: detail.qcReport, decision: reviewDecision, checklist,
      acknowledgements: Object.entries(acknowledgements).map(([code, reason]) => ({ code, reason })),
      notes, expectedOutputSha256: detail.qcReport?.outputSha256 ?? null,
      idempotencyKey: `final-review-${detail.export.id}`,
    });
  }, [acknowledgements, checklist, detail, notes, reviewDecision, view?.canFinalReview]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8" data-testid="export-page">
      <header className="flex flex-col gap-1">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Export QC &amp; download</p>
        <h1 className="text-xl font-bold text-ink">Exports</h1>
        <p className="max-w-2xl text-sm text-muted">
          Measured technical QC, the human final review, and the strictly separated final vs draft
          downloads for this project&apos;s rendered exports.
        </p>
      </header>

      {loadPhase === "loading" && <p role="status" data-testid="export-loading">Loading exports…</p>}
      {loadPhase === "error" && (
        <div role="alert" data-testid="export-error" className="rounded-[10px] border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {loadError}
          <div className="mt-3">
            <Button type="button" data-testid="reload" onClick={() => { void load("manual").then((list) => { const latest = list[list.length - 1]; if (latest) void loadDetail(latest.id); }); }}>
              Reload
            </Button>
          </div>
        </div>
      )}

      {loadPhase === "ready" && readModel.length === 0 && (
        <div data-testid="export-empty" role="status">
          <EmptyState
            icon="image"
            title="No exports yet"
            body="Exports appear here once approved takes and an approved audio mix compile into a render manifest, the render finishes, and technical QC has run. Prerequisites: approved takes for every shot, an approved audio mix, a compiled render manifest, a completed export."
          />
        </div>
      )}

      {loadPhase === "ready" && (
        <div className="flex flex-col gap-2" data-testid="export-list">
          {readModel.length > 0 && <h2 className="text-sm font-bold text-ink">Exports ({readModel.length})</h2>}
          {readModel.map((exportRecord) => (
            <button
              key={exportRecord.id}
              type="button"
              data-testid="export-item"
              aria-pressed={exportRecord.id === selectedExportId}
              onClick={() => { void loadDetail(exportRecord.id); }}
              className={`flex items-center justify-between rounded-[10px] border px-4 py-3 text-left text-sm transition-colors ${exportRecord.id === selectedExportId ? "border-primary bg-primary/5 text-ink" : "border-border bg-raised text-ink-soft hover:border-muted"}`}
            >
              <span className={MONO}>{exportRecord.id}</span>
              <Badge tone={exportRecord.status === "approved" ? "success" : exportRecord.status === "qc_failed" || exportRecord.status === "failed" ? "danger" : "neutral"}>{exportRecord.status}</Badge>
            </button>
          ))}
        </div>
      )}

      {detailPhase === "loading" && <p role="status" data-testid="detail-loading">Loading export…</p>}
      {detailPhase === "error" && (
        <div role="alert" className="rounded-[10px] border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          {detailError}
          <div className="mt-3">
            <Button type="button" onClick={() => { if (selectedExportId) void loadDetail(selectedExportId); }}>Reload</Button>
          </div>
        </div>
      )}

      {detail && view && (
        <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="export-detail">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={MONO}>{detail.export.id}</h2>
            {view.badges.final && <span data-testid="final-badge"><Badge tone="success">{view.finalLabel}</Badge></span>}
            {view.badges.draft && <span data-testid="draft-badge"><Badge tone="warning">{view.draftLabel}</Badge></span>}
            {view.badges.final && view.badges.draft && null}
          </div>
          <ol className="mt-3 flex flex-wrap gap-1 text-[10px] font-bold uppercase tracking-[0.06em]" data-testid="status-timeline" aria-label="Export status timeline">
            {(["queued", "rendering", "qc_pending", "qc_failed", "ready_for_review", "approved", "failed", "canceled"] as const).map((status) => (
              <li key={status} aria-current={status === view.status ? "step" : undefined} className={`rounded-[5px] px-2 py-1 ${status === view.status ? "bg-primary text-white" : "bg-surface-2 text-muted"}`}>
                {status}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-sm font-semibold text-ink">{view.headline}</p>
          <p className="mt-1 text-sm text-muted">{view.detail}</p>

          {detail.failure && (
            <div className="mt-3 rounded-[10px] border border-danger/40 bg-danger/5 p-3 text-sm text-danger" data-testid="failure-artifact">
              <p className="font-semibold">Render failure — {detail.failure.code} at stage {detail.failure.stage}</p>
              {detail.failure.shotRevisionId && <p className="mt-1">shot revision: <span className={MONO}>{detail.failure.shotRevisionId}</span></p>}
              {detail.failure.cueId && <p className="mt-1">audio cue: <span className={MONO}>{detail.failure.cueId}</span></p>}
              <p className="mt-1 whitespace-pre-wrap">{detail.failure.redactedStderr}</p>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {view.canRunQc && (
              <Button type="button" data-testid="run-qc" disabled={actionPhase === "busy"} onClick={() => { void runQc(); }}>
                {actionPhase === "busy" ? "Running technical QC…" : "Run technical QC"}
              </Button>
            )}
            {view.canDraftDownload && (
              <Button type="button" variant="secondary" data-testid="download-draft" disabled={actionPhase === "busy"} onClick={() => { void download("draft"); }}>
                {view.draftLabel}
              </Button>
            )}
            {view.canFinalDownload && (
              <Button type="button" variant="primary" data-testid="download-final" disabled={actionPhase === "busy"} onClick={() => { void download("final"); }}>
                Final download (approved bytes)
              </Button>
            )}
            {view.canFinalDownload && (
              <Button type="button" variant="secondary" icon="download" data-testid="export.package.download" disabled={actionPhase === "busy"} onClick={() => { void downloadPackage(); }}>
                Download publication package (zip)
              </Button>
            )}
            {view.canFinalDownload && detail?.export.id && (
              <>
                {([["16:9", "high"], ["9:16", "high"], ["1:1", "medium"]] as const).map(([aspect, quality]) => (
                  <a
                    key={aspect}
                    className="inline-flex items-center justify-center gap-1.5 rounded-[8px] border border-border-strong bg-raised px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-surface"
                    href={`/api/production/exports/${encodeURIComponent(detail!.export.id)}/derivatives?projectId=${encodeURIComponent(projectId)}&aspect=${encodeURIComponent(aspect)}&quality=${quality}`}
                    data-testid={`export.derivative.${aspect.replace(":", "-")}`}
                  >
                    {aspect.replace(":", "×")} clip
                  </a>
                ))}
              </>
            )}
            {view.canRetryExport && (
              <Button type="button" variant="secondary" data-testid="retry-export" disabled={actionPhase === "busy"} onClick={() => { void retryExport(); }}>
                Retry as a new export
              </Button>
            )}
          </div>
          {!view.canFinalDownload && (
            <p className="mt-2 text-xs text-muted" data-testid="download-locked">
              Final download locked — it unlocks only after the human G09 final review approves the exact output checksum (technical QC alone never unlocks it).
            </p>
          )}
          {downloadGate && (
            <p role={downloadGate.phase === "ready" ? "status" : "alert"} data-testid="download-gate" className={`mt-2 text-xs ${downloadGate.phase === "ready" ? "text-success" : "text-danger"}`}>
              {downloadGate.message}
            </p>
          )}
          {actionMessage && <p role="alert" data-testid="action-alert" className="mt-2 text-xs text-danger">{actionMessage}</p>}
        </section>
      )}

      {detail?.qcReport && (
        <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="qc-report">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-ink">Technical QC report</h2>
            <Badge tone={detail.qcReport.verdict === "passed" ? "success" : "danger"}>{detail.qcReport.verdict}</Badge>
            {detail.qcReport.draftOnly && <Badge tone="warning">silent draft (draftOnly)</Badge>}
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2" data-testid="qc-measured">
            <div className="flex justify-between gap-2"><dt className="text-muted">Integrated loudness</dt><dd className={MONO}>{describeMeasuredNumber(detail.qcReport.measured.integratedLufs, " LUFS")} (target -14 ±1)</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">True peak</dt><dd className={MONO}>{describeMeasuredNumber(detail.qcReport.measured.truePeakDbtp, " dBTP")} (limit ≤ -1)</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Duration</dt><dd className={MONO}>{detail.qcReport.measured.durationFrames === null ? "not measured" : `${detail.qcReport.measured.durationFrames} frames`} (expected {detail.qcReport.measured.expectedDurationFrames} ±1)</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Video</dt><dd className={MONO}>{detail.qcReport.measured.codec ?? "?"} {detail.qcReport.measured.width ?? "?"}x{detail.qcReport.measured.height ?? "?"} {detail.qcReport.measured.pixFmt ?? "?"} @ {detail.qcReport.measured.fps ?? "?"} fps</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Container</dt><dd className={MONO}>{detail.qcReport.measured.container ?? "not measured"}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Output sha256</dt><dd className={MONO} data-testid="output-sha256">{detail.qcReport.outputSha256}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Manifest inputs hash</dt><dd className={MONO} data-testid="inputs-hash">{detail.qcReport.manifestInputsHash}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted">Detectors</dt><dd className={MONO}>{String(detail.qcReport.toolVersions.ffmpeg)} / ffprobe {String(detail.qcReport.toolVersions.ffprobe)}</dd></div>
          </dl>

          {detail.qcReport.blockers.length > 0 && (
            <div className="mt-3 rounded-[10px] border border-danger/40 bg-danger/5 p-3 text-sm text-danger" data-testid="qc-blockers">
              <p className="font-semibold">Automated blockers (no waiver)</p>
              <ul className="mt-1 list-disc pl-5">
                {detail.qcReport.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${index}`}><span className={MONO}>{blocker.code}</span>: {blocker.message}</li>
                ))}
              </ul>
            </div>
          )}

          {detail.qcReport.advisories.length > 0 && (
            <div className="mt-3 rounded-[10px] border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="qc-advisories">
              <p className="font-semibold text-ink">Advisory warnings — each needs your explicit acknowledgement with a reason</p>
              <ul className="mt-2 flex flex-col gap-2">
                {detail.qcReport.advisories.map((advisory, index) => (
                  <li key={`${advisory.code}-${index}`} className="rounded-[8px] border border-warning/40 bg-surface p-2">
                    <p className="font-semibold text-ink">{advisory.code}</p>
                    <p className="text-[12px] text-ink-soft">{advisory.message}</p>
                    <p className="mt-1 text-[11px] text-muted">threshold: {advisory.threshold} · detector {advisory.detectorVersion}</p>
                    <label className="mt-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-muted" htmlFor={`ack-${index}`}>
                      Acknowledgement reason for {advisory.code}
                    </label>
                    <input
                      id={`ack-${index}`}
                      type="text"
                      className="mt-1 w-full rounded-[7px] border border-border-strong bg-surface px-2.5 py-2 text-[13px] text-ink focus:border-primary focus:outline-none"
                      aria-label={`Acknowledgement reason for ${advisory.code}`}
                      value={acknowledgements[advisory.code] ?? ""}
                      onChange={(event) => setAcknowledgements((previous) => ({ ...previous, [advisory.code]: event.target.value }))}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="mt-3 text-[12px] text-muted">
            <summary className="cursor-pointer font-semibold text-ink">Per-check expected/actual evidence</summary>
            <table className="mt-2 w-full text-left" data-testid="qc-checks">
              <thead><tr className="text-[10px] uppercase tracking-[0.08em]"><th className="py-1">Check</th><th>Expected</th><th>Actual</th><th>Pass</th><th>Evidence</th></tr></thead>
              <tbody>
                {detail.qcReport.checks.map((check) => (
                  <tr key={check.id} className="border-t border-border">
                    <td className={`py-1 ${MONO}`}>{check.id}</td>
                    <td className="pr-2">{check.expected}</td>
                    <td className="pr-2">{check.actual}</td>
                    <td>{check.passed ? "yes" : "NO"}</td>
                    <td className="pr-2 text-[11px]">{check.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}

      {detail && view?.canFinalReview && detail.qcReport && !detail.qcReport.draftOnly && (
        <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="final-review-form">
          <h2 className="text-sm font-bold text-ink">Final review (G09) — human only</h2>
          <p className="mt-1 text-sm text-muted">
            Watch the exact downloadable bytes end to end, then mark every check on this checksum. The approval binds
            exactly <span className={MONO} data-testid="expected-output-sha256">{detail.qcReport.outputSha256}</span>.
          </p>
          <fieldset className="mt-3 flex flex-col gap-2">
            <legend className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted">Final checklist</legend>
            {[...FINAL_REVIEW_CHECKLIST_IDS].map((id) => {
              const item = checklist.find((candidate) => candidate.id === id);
              return (
                <div key={id} className="flex flex-col gap-1 rounded-[8px] border border-border bg-surface p-2 sm:flex-row sm:items-center sm:gap-3">
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      aria-label={`Checklist ${id} passed`}
                      checked={item?.passed ?? false}
                      onChange={(event) => setChecklist((previous) => previous.map((row) => (row.id === id ? { ...row, passed: event.target.checked } : row)))}
                    />
                    <span className="font-mono text-[12px]">{id}</span>
                  </label>
                  <input
                    type="text"
                    className="flex-1 rounded-[7px] border border-border-strong bg-surface px-2.5 py-2 text-[13px] text-ink focus:border-primary focus:outline-none"
                    aria-label={`Checklist ${id} note`}
                    placeholder={`Note for ${id}`}
                    value={item?.note ?? ""}
                    onChange={(event) => setChecklist((previous) => previous.map((row) => (row.id === id ? { ...row, note: event.target.value } : row)))}
                  />
                </div>
              );
            })}
          </fieldset>
          <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.08em] text-muted" htmlFor="review-notes">Review notes</label>
          <textarea
            id="review-notes"
            className="mt-1 w-full rounded-[7px] border border-border-strong bg-surface px-2.5 py-2 text-[13px] text-ink focus:border-primary focus:outline-none"
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid="approve-final"
              disabled={actionPhase === "busy" || (readiness ? !readiness.ok && reviewDecision === "approved" : true)}
              onClick={() => { void submitReview("approved"); }}
            >
              Approve exact checksum
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-testid="reject-final"
              disabled={actionPhase === "busy" || (readiness ? !readiness.ok && reviewDecision === "rejected" : true)}
              onClick={() => { void submitReview("rejected"); }}
            >
              Reject export
            </Button>
          </div>
          {readiness && !readiness.ok && (
            <ul className="mt-2 list-disc pl-5 text-xs text-danger" data-testid="review-issues">
              {readiness.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
        </section>
      )}

      {detail && view?.canFinalReview && detail.qcReport?.draftOnly && (
        <section className="rounded-[12px] border border-border bg-raised p-6 shadow-card" data-testid="draft-only-notice">
          <p className="text-sm text-muted">
            This silent draft can never be approved or become release-ready. It stays downloadable through the clearly
            labeled draft action above only.
          </p>
        </section>
      )}
    </div>
  );
}

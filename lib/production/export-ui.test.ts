import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExportSchema, type ExportRecord } from "./contracts";
import { QcReportSchema, type QcReport } from "./qc";
import {
  deriveDownloadGate, deriveExportViewState, deriveFinalReviewReadiness, FINAL_REVIEW_CHECKLIST_IDS,
  type AdvisoryAckDraft, type FinalChecklistDraft,
} from "@/components/production/export";

const sha = (label: string) => createHash("sha256").update(label, "utf8").digest("hex");
const OUTPUT_SHA = sha("output-bytes");
const INPUTS_HASH = sha("inputs");

const exportRecord = (status: ExportRecord["status"], overrides: Partial<ExportRecord> = {}): ExportRecord =>
  ExportSchema.parse({
    version: 1, id: "export-ui-1", manifestId: "manifest-ui-1", jobId: null,
    assetId: ["failed", "canceled", "queued", "rendering"].includes(status) ? null : "export-asset-1",
    qcReportId: status === "approved" ? "qc-report-ui-1" : null, status, createdAt: 1_000,
    approvedSha256: status === "approved" ? OUTPUT_SHA : null,
    finalApprovalId: status === "approved" ? "approval-final" : null,
    ...overrides,
  });

const passedReport = (overrides: Partial<QcReport> = {}, advisories: QcReport["advisories"] = []): QcReport =>
  QcReportSchema.parse({
    version: 1, id: `qc-${sha("report")}`, exportId: "export-ui-1", manifestId: "manifest-ui-1",
    manifestInputsHash: INPUTS_HASH, outputAssetId: "export-asset-1", outputSha256: OUTPUT_SHA,
    draftOnly: false, verdict: "passed",
    measured: {
      integratedLufs: -14.1, truePeakDbtp: -9.4, lraLu: 0, durationFrames: 48, expectedDurationFrames: 48,
      audioEndSample: 72_000, expectedAudioEndSample: 72_000, codec: "h264", container: "mov,mp4,m4a,3gp,3mj",
      width: 1080, height: 1920, fps: 24, pixFmt: "yuv420p",
    },
    checks: [], blockers: [], advisories, toolFailure: null,
    toolVersions: { ffmpeg: "9.0.2", ffprobe: "9.0.2" },
    detectorThresholds: { fps: 24, sampleRate: 48_000, detectorVersion: "qc-detectors-v1" },
    createdAt: 5_000,
    ...overrides,
  });

const completeChecklist = (overrides: Partial<Record<string, { passed: boolean; note: string }>> = {}): FinalChecklistDraft[] =>
  FINAL_REVIEW_CHECKLIST_IDS.map((id) => ({ id, passed: overrides[id]?.passed ?? true, note: overrides[id]?.note ?? `Checked ${id}.` }));

describe("C12 deriveExportViewState per status", () => {
  const view = (status: ExportRecord["status"], report: QcReport | null = null) =>
    deriveExportViewState({ exportRecord: exportRecord(status), qcReport: report, failure: null });

  it("gates actions per lifecycle state", () => {
    expect(view("queued")).toMatchObject({ canRunQc: false, canDraftDownload: false, canFinalDownload: false, canFinalReview: false });
    expect(view("rendering")).toMatchObject({ canRunQc: false, canDraftDownload: false, canFinalDownload: false, canFinalReview: false });
    expect(view("qc_pending")).toMatchObject({ canRunQc: true, canDraftDownload: true, canFinalDownload: false, canFinalReview: false });
    expect(view("qc_failed")).toMatchObject({ canRunQc: false, canDraftDownload: true, canFinalDownload: false, canFinalReview: false, canRetryExport: true });
    expect(view("ready_for_review")).toMatchObject({ canRunQc: false, canDraftDownload: true, canFinalDownload: false, canFinalReview: true });
    expect(view("approved")).toMatchObject({ canRunQc: false, canFinalDownload: true, canFinalReview: false });
    expect(view("failed")).toMatchObject({ canDraftDownload: false, canFinalDownload: false, canRetryExport: true });
    expect(view("canceled")).toMatchObject({ canDraftDownload: false, canFinalDownload: false, canRetryExport: true });
  });

  it("shows the final badge only for approved with a matching report checksum", () => {
    expect(view("approved", passedReport()).badges.final).toBe(true);
    expect(view("approved", passedReport({ outputSha256: sha("different-bytes") })).badges.final).toBe(false);
    expect(view("approved", null).badges.final).toBe(false);
    expect(view("ready_for_review", passedReport()).badges.final).toBe(false);
    expect(view("qc_pending", passedReport()).badges.final).toBe(false);
  });

  it("never renders Ready-to-upload language for draft or failed artifacts", () => {
    for (const status of ["queued", "rendering", "qc_pending", "qc_failed", "ready_for_review", "failed", "canceled"] as const) {
      const state = view(status, passedReport());
      expect(state.badges.final).toBe(false);
      expect(JSON.stringify(state)).not.toContain("Ready to upload");
    }
    // Draft-eligible states carry the explicit draft badge.
    expect(view("qc_pending").badges.draft).toBe(true);
    expect(view("qc_failed").badges.draft).toBe(true);
    expect(view("ready_for_review").badges.draft).toBe(true);
    expect(view("approved").badges.draft).toBe(false);
  });
});

describe("C12 deriveDownloadGate maps blocking statuses to actionable text", () => {
  it("maps 428 to the human final-approval requirement", () => {
    const gate = deriveDownloadGate(428, { error: { code: "APPROVAL_REQUIRED", message: "not approved", retryable: false }, requestId: "r1" });
    expect(gate.phase).toBe("blocked");
    expect(gate.message).toMatch(/final (review|approval)|human/i);
    expect(gate.message).toMatch(/QC|technical/i);
  });

  it("maps 409 to the stale-checksum recovery", () => {
    const gate = deriveDownloadGate(409, { error: { code: "STALE_REVISION", message: "checksum drift", retryable: true }, requestId: "r2" });
    expect(gate.phase).toBe("blocked");
    expect(gate.message).toMatch(/re-?encode|stale|checksum/i);
    expect(gate.message).toMatch(/QC|approv/i);
  });

  it("maps 404, 400 and network failure to honest errors and 200 to ready", () => {
    expect(deriveDownloadGate(404, {}).phase).toBe("error");
    expect(deriveDownloadGate(400, {}).message).toMatch(/project|scope/i);
    expect(deriveDownloadGate(null, undefined).message).toMatch(/network/i);
    expect(deriveDownloadGate(200, {}).phase).toBe("ready");
  });
});

describe("C12 deriveFinalReviewReadiness requires the full G09 gate", () => {
  const base = {
    exportRecord: exportRecord("ready_for_review", { qcReportId: `qc-${sha("report")}` }),
    report: passedReport(),
    decision: "approved" as const,
    checklist: completeChecklist(),
    acknowledgements: [] as AdvisoryAckDraft[],
    notes: "Watched the exported bytes end to end.",
    expectedOutputSha256: OUTPUT_SHA,
    idempotencyKey: "review-key-1",
  };

  it("builds the exact final_review command when every gate is satisfied", () => {
    const readiness = deriveFinalReviewReadiness(base);
    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.command).toMatchObject({
        kind: "final_review", decision: "approved", expectedOutputSha256: OUTPUT_SHA, idempotencyKey: "review-key-1",
      });
      expect(readiness.command.checklist.map((item) => item.id)).toEqual([...FINAL_REVIEW_CHECKLIST_IDS]);
    }
  });

  it("requires every advisory acknowledged with a nonempty reason", () => {
    const advisory = {
      code: "freeze_range" as const, detectorVersion: "qc-detectors-v1",
      message: "Freeze from frame 0 to 72.", startFrame: 0, endFrame: 72, startSample: null, endSample: null,
      cueId: null, threshold: ">= 48 frames",
    };
    const withAdvisory = { ...base, report: passedReport({}, [advisory]) };
    const blocked = deriveFinalReviewReadiness(withAdvisory);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.issues.join(" ")).toMatch(/freeze_range/);
    const emptyReason = deriveFinalReviewReadiness({ ...withAdvisory, acknowledgements: [{ code: "freeze_range", reason: "  " }] });
    expect(emptyReason.ok).toBe(false);
    const acked = deriveFinalReviewReadiness({ ...withAdvisory, acknowledgements: [{ code: "freeze_range", reason: "Planned static title card." }] });
    expect(acked.ok).toBe(true);
  });

  it("requires the complete four-item binary checklist", () => {
    const incomplete = deriveFinalReviewReadiness({ ...base, checklist: completeChecklist().slice(0, 3) });
    expect(incomplete.ok).toBe(false);
    const failedItem = deriveFinalReviewReadiness({ ...base, checklist: completeChecklist({ captions: { passed: false, note: "Typo in caption." } }) });
    expect(failedItem.ok).toBe(false);
    if (!failedItem.ok) expect(failedItem.issues.join(" ")).toMatch(/captions/);
  });

  it("binds the exact expectedOutputSha256 and rejects silent drafts", () => {
    const stale = deriveFinalReviewReadiness({ ...base, expectedOutputSha256: sha("old-bytes") });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.issues.join(" ")).toMatch(/checksum|sha/i);
    const missing = deriveFinalReviewReadiness({ ...base, expectedOutputSha256: null });
    expect(missing.ok).toBe(false);
    const draftReport = passedReport({ draftOnly: true, measured: passedReport().measured });
    const draft = deriveFinalReviewReadiness({ ...base, report: draftReport });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.issues.join(" ")).toMatch(/silent draft/i);
    const failedQc = deriveFinalReviewReadiness({ ...base, report: passedReport({ verdict: "failed" }) });
    expect(failedQc.ok).toBe(false);
    const noReport = deriveFinalReviewReadiness({ ...base, report: null });
    expect(noReport.ok).toBe(false);
  });

  it("accepts a rejection with notes or a failed item without the checksum binding", () => {
    const rejected = deriveFinalReviewReadiness({ ...base, decision: "rejected", notes: "Wrong narration in shot 2." });
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.command.decision).toBe("rejected");
    const rejectedFailedItem = deriveFinalReviewReadiness({
      ...base, decision: "rejected", notes: "",
      checklist: completeChecklist({ visual: { passed: false, note: "Flicker in shot 1." } }),
    });
    expect(rejectedFailedItem.ok).toBe(true);
    const rejectedNoReason = deriveFinalReviewReadiness({ ...base, decision: "rejected", notes: "" });
    expect(rejectedNoReason.ok).toBe(false);
  });
});

/**
 * Publish & Export (spec 15) pure view-model helpers.
 *
 * Everything here is a plain function over frozen shared artifacts (ExportRecord,
 * ExportDetailResponse, QcReport, ProjectReadModel, PublicationPackage): no hooks, no window,
 * no fetch, so the file stays node-testable and server-safe. The UI layer in publish-view.tsx
 * renders exactly what these helpers derive; no server rule is re-implemented there. Plain
 * language throughout — provider and gate jargon belongs to the legacy diagnostics surfaces.
 */

import type { CreateManifestCommand, ExportRecord, ProjectReadModel } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";
import type { FailureRecord, QcReport } from "@/lib/production/qc";
import type { GenerationPhase } from "@/components/production/primitives/status";
import type { DownloadGate } from "@/components/production/export";
import {
  MANUAL_UPLOAD_DISCLAIMER,
  derivePublicationPackage,
  resolvePublicationProfile,
  type PublicationPackage,
} from "@/lib/production/publishing";

/* ------------------------------------------------------------------ */
/* Export progress (Ready → Queued → Running → Completed / Failed)     */
/* ------------------------------------------------------------------ */

/** True while the render is still moving; these are the only polling states. */
export function isExportInFlight(status: ExportRecord["status"]): boolean {
  return status === "queued" || status === "rendering";
}

export type ExportProgress = {
  phase: GenerationPhase;
  /** Human-readable stage line; never a bare status word. */
  stage: string;
  /** Plain failure reason for the failed phase, or null. */
  failureMessage: string | null;
  /** Whether "retry as a new export" is an honest offer in this state. */
  retryable: boolean;
};

/**
 * Maps the frozen ExportStatus vocabulary onto the universal long-action phases with a named,
 * human stage for each — an indefinite spinner without a name is never shown.
 */
export function deriveExportProgress(exportRecord: ExportRecord, failure: FailureRecord | null): ExportProgress {
  switch (exportRecord.status) {
    case "queued":
      return { phase: "queued", stage: "Waiting for a free render slot — nothing has been rendered yet.", failureMessage: null, retryable: false };
    case "rendering":
      return { phase: "running", stage: "Rendering your master MP4 with the local FFmpeg renderer.", failureMessage: null, retryable: false };
    case "qc_pending":
      return { phase: "ready", stage: "The file is rendered. Run the technical checks to measure it.", failureMessage: null, retryable: false };
    case "qc_failed":
      return {
        phase: "failed",
        stage: "Technical checks found problems with the rendered file.",
        failureMessage: "Nothing was deleted — your takes, mixes, and earlier exports are safe. Read the check results below, then retry as a new export when ready.",
        retryable: true,
      };
    case "ready_for_review":
      return { phase: "ready", stage: "Technical checks passed. Your review unlocks the final download.", failureMessage: null, retryable: false };
    case "approved":
      return { phase: "completed", stage: "Approved — the master MP4 is yours to download and upload by hand.", failureMessage: null, retryable: false };
    case "failed":
      return {
        phase: "failed",
        stage: "The export didn't finish.",
        failureMessage: failure
          ? `The render stopped at the "${failure.stage}" step. Nothing was deleted — your takes, mixes, and earlier exports are safe, and you can retry as a new export.`
          : "The render failed. Nothing was deleted — your takes, mixes, and earlier exports are safe, and you can retry as a new export.",
        retryable: true,
      };
    case "canceled":
      return {
        phase: "failed",
        stage: "The export was canceled before it finished.",
        failureMessage: "Nothing was deleted — partial output is excluded, and you can start a new export whenever you're ready.",
        retryable: true,
      };
  }
}

/* ------------------------------------------------------------------ */
/* QC checklist card (pass / pending / fail, in plain words)            */
/* ------------------------------------------------------------------ */

export type QcCheckState = "pass" | "fail";

export type QcChecklistRow = {
  id: string;
  label: string;
  state: QcCheckState;
  /** One-sentence plain explanation of what this check protects. */
  explanation: string;
  /** Expected-vs-measured evidence line, kept short and human. */
  detail: string;
};

const PLAIN_QC_CHECKS: Record<string, { label: string; explanation: string }> = {
  checksum: { label: "File integrity", explanation: "The saved file is exactly the bytes that were rendered — verified by checksum." },
  decode: { label: "Plays end to end", explanation: "The whole file decodes without errors, so no stretch of it is corrupt or unplayable." },
  container: { label: "MP4 file", explanation: "The export is a standard MP4 file that video platforms accept." },
  video_codec: { label: "Video format", explanation: "H.264 video — the widely supported standard." },
  dimensions: { label: "Frame size", explanation: "Width and height match your chosen aspect ratio exactly." },
  pixel_format: { label: "Color format", explanation: "Standard color encoding (yuv420p), so colors look right on every player." },
  fps: { label: "Smooth motion", explanation: "Plays at a steady 24 frames per second, like a film." },
  duration: { label: "Length matches the edit", explanation: "The file's length matches your approved storyboard timeline." },
  audio_stream: { label: "Audio track", explanation: "The export carries the audio your approved mix declares." },
  integrated_loudness: { label: "Loudness", explanation: "Overall volume sits near −14 LUFS — the level streaming platforms expect." },
  true_peak: { label: "No clipping", explanation: "The loudest moments stay under the −1 dBTP limit, so nothing distorts." },
  audio_end: { label: "Audio ends cleanly", explanation: "Sound ends with the picture instead of cutting off or trailing on." },
  spoken_segments: { label: "All narration included", explanation: "Every narrated story beat made it into the audio." },
};

const FALLBACK_QC_CHECK = (id: string) => ({ label: id, explanation: "A measured technical check on the finished file." });

/** One row per measured check from the frozen QC report; fails and passes only — no verdict invented. */
export function deriveQcChecklist(report: QcReport | null): QcChecklistRow[] {
  if (!report) return [];
  return report.checks.map((check) => {
    const plain = PLAIN_QC_CHECKS[check.id] ?? FALLBACK_QC_CHECK(check.id);
    return {
      id: check.id,
      label: plain.label,
      state: check.passed ? ("pass" as const) : ("fail" as const),
      explanation: plain.explanation,
      detail: `Expected ${check.expected} — measured ${check.actual}.`,
    };
  });
}

export type QcChecklistSummary = { passed: number; failed: number; total: number };

export function summarizeQcChecklist(rows: readonly QcChecklistRow[]): QcChecklistSummary {
  return {
    passed: rows.filter((row) => row.state === "pass").length,
    failed: rows.filter((row) => row.state === "fail").length,
    total: rows.length,
  };
}

/* ------------------------------------------------------------------ */
/* Export readiness (manifest compile + export trigger preflight)      */
/* ------------------------------------------------------------------ */

/**
 * Structural preflight for the export trigger, mirroring (never replacing) the server's own
 * compile validation: story, shot plan, animatic, and one selected take per shot must exist.
 * Approval and media problems surface verbatim from the server when they fire.
 */
export function deriveExportPrerequisites(readModel: ProjectReadModel): { canStart: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!readModel.project.activeStoryRevisionId) issues.push("There's no story yet — this project hasn't been through the First Cut studio.");
  if (!readModel.project.activeShotPlanRevisionId) issues.push("No shot plan yet — the storyboard hasn't been planned.");
  if (!readModel.project.activeAnimaticRevisionId) issues.push("No animatic yet — shots haven't been turned into animatic frames.");
  if (readModel.shots.length === 0) issues.push("The shot plan has no shots to render.");
  const unselected = readModel.shots.filter((shot) => shot.takeSelection.takeId === null);
  if (unselected.length > 0) {
    issues.push(`${unselected.length} ${unselected.length === 1 ? "shot has" : "shots have"} no selected take yet — pick a take for each shot in the storyboard.`);
  }
  return { canStart: issues.length === 0, issues };
}

/**
 * Builds the manifest compile command from the current read model, or null when the structural
 * prerequisites fail. Take ids follow plan order; the audio mix may be absent (silent draft).
 */
export function buildManifestCommand(readModel: ProjectReadModel): CreateManifestCommand | null {
  const { canStart } = deriveExportPrerequisites(readModel);
  if (!canStart) return null;
  const selectedTakeIds = readModel.shots
    .slice()
    .sort((left, right) => left.shotRevision.order - right.shotRevision.order)
    .map((shot) => shot.takeSelection.takeId)
    .filter((takeId): takeId is string => takeId !== null);
  return {
    projectId: readModel.project.id,
    shotPlanRevisionId: readModel.project.activeShotPlanRevisionId!,
    animaticRevisionId: readModel.project.activeAnimaticRevisionId!,
    audioMixRevisionId: readModel.project.activeAudioMixRevisionId,
    selectedTakeIds,
    profileId: readModel.project.profileId,
    expectedSelectionVersion: readModel.project.takeSelectionVersion,
  };
}

/* ------------------------------------------------------------------ */
/* Publication package derivation (fail-closed, server-owned rules)    */
/* ------------------------------------------------------------------ */

/**
 * The studio's neutral film package profile: a plain "{projectName}" title with a synopsis plus
 * creator-owned credits and audience note. Genre-specific profiles stay available in the frozen
 * catalog for later slices.
 */
export const DEFAULT_PUBLICATION_PROFILE_ID = "mythology-publication-v1";

export type PublicationPackageOutcome =
  | { ok: true; value: PublicationPackage }
  | { ok: false; code: string; message: string };

/**
 * Derives the manual-upload publication package from the project read model using the frozen
 * pure helpers in lib/production/publishing.ts — the same fail-closed gates the server enforces
 * (an approved-or-reviewed export, an approved take behind every shot). No local re-definition
 * of any rule: failures bubble up with their stable code for honest display.
 */
export function derivePublicationPackageSafe(readModel: ProjectReadModel | null): PublicationPackageOutcome {
  if (!readModel) return { ok: false, code: "LOADING", message: "The project is still loading." };
  try {
    const value = derivePublicationPackage(readModel, resolvePublicationProfile(DEFAULT_PUBLICATION_PROFILE_ID));
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ProductionApplicationError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "UNKNOWN", message: error instanceof Error ? error.message : "The publication package could not be prepared." };
  }
}

/* ------------------------------------------------------------------ */
/* Editable metadata + the downloadable text files                     */
/* ------------------------------------------------------------------ */

export type PackageMetadataDraft = { title: string; description: string; hashtags: string; chapters: string };

/** Maximum lengths follow the strictest common platform limits; the file keeps what you wrote. */
export const METADATA_LIMITS = { title: 200, description: 5000, hashtags: 1000, chapters: 5000 } as const;

/**
 * Seeds the editable metadata from the derived package. Creator-owned sections stay clearly
 * marked as the creator's to write — the studio never invents claims, credits, or hashtags.
 */
export function seedMetadataFromPackage(pkg: PublicationPackage): PackageMetadataDraft {
  const description = pkg.description.sections
    .map((section) =>
      section.body !== null
        ? `${section.heading}\n${section.body}`
        : `${section.heading}\n(${section.guidance ?? "Write this part in your own words."})`,
    )
    .join("\n\n");
  const chapters = pkg.description.sections.find((section) => section.source === "derived_chapters")?.body ?? "";
  return { title: pkg.title.text, description, hashtags: "", chapters };
}

export type TextFileDownload = { name: string; label: string; content: string };

/** The four text files of the manual package, built from exactly what the creator sees on screen. */
export function buildTextFileDownloads(draft: PackageMetadataDraft): TextFileDownload[] {
  return [
    { name: "title.txt", label: "Title", content: `${draft.title.trim()}\n` },
    { name: "description.txt", label: "Description", content: `${draft.description.trim()}\n` },
    { name: "hashtags.txt", label: "Hashtags", content: `${draft.hashtags.trim()}\n` },
    { name: "chapters.txt", label: "Chapters", content: `${draft.chapters.trim()}\n` },
  ];
}

/**
 * production.json: the canonical derived package (untouched, auditable) beside the creator's
 * edited metadata and the manual-upload disclaimer. Nothing here claims a platform outcome.
 */
export function buildPackageJson(pkg: PublicationPackage, draft: PackageMetadataDraft): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "perabyte-publication-package",
      package: pkg,
      creatorEdited: draft,
      disclaimer: MANUAL_UPLOAD_DISCLAIMER,
    },
    null,
    2,
  )}\n`;
}

/* ------------------------------------------------------------------ */
/* Server package overrides (M4-5) + package zip download gating        */
/* ------------------------------------------------------------------ */

/** A saved metadata override row as persisted server-side next to the export record. */
export type PackageOverridesPayload = {
  version: number;
  exportId: string;
  title: string | null;
  description: string | null;
  hashtags: string | null;
  chapters: string | null;
  updatedAt: number;
};

/**
 * Merges persisted server overrides onto the seeded draft: a nonblank saved edit wins field by
 * field, so the card shows exactly what a package download would use for that field.
 */
export function applyOverridesToDraft(seed: PackageMetadataDraft, overrides: PackageOverridesPayload | null): PackageMetadataDraft {
  if (!overrides) return seed;
  const pick = (override: string | null | undefined, fallback: string): string =>
    typeof override === "string" && override.trim().length > 0 ? override : fallback;
  return {
    title: pick(overrides.title, seed.title),
    description: pick(overrides.description, seed.description),
    hashtags: pick(overrides.hashtags, seed.hashtags),
    chapters: pick(overrides.chapters, seed.chapters),
  };
}

/** The eight files a package zip is contracted to carry, verbatim per spec 15's manual package. */
export const PACKAGE_ZIP_FILES = [
  "video.mp4", "thumbnail.png", "captions.srt", "title.txt", "description.txt", "hashtags.txt", "chapters.txt", "production.json",
] as const;

/**
 * Maps a package-route response onto honest UI text with the same fail-closed shape as the video
 * gates: 428 names the approval requirement, 409 the stale checksum, 404/400/network the errors.
 * 200 is the only ready state — nothing here fabricates a success.
 */
export function derivePackageDownloadGate(httpStatus: number | null, payload: unknown): DownloadGate {
  const envelope = payload !== null && typeof payload === "object" ? (payload as { error?: { code?: unknown; message?: unknown }; requestId?: unknown }) : null;
  const code = typeof envelope?.error?.code === "string" ? envelope.error.code : "UNKNOWN";
  const serverMessage = typeof envelope?.error?.message === "string" ? envelope.error.message : "";
  const requestId = typeof envelope?.requestId === "string" ? envelope.requestId : "unknown";
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    return { phase: "ready", message: `Publication package downloaded — ${PACKAGE_ZIP_FILES.join(", ")}.` };
  }
  if (httpStatus === 428 || code === "APPROVAL_REQUIRED") {
    return { phase: "blocked", message: `Package locked (HTTP 428): the human final review must approve the exact output checksum before the complete package can be built. Technical QC alone never unlocks it. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 409) {
    return { phase: "blocked", message: `Package blocked (HTTP 409 ${code}): ${code === "STALE_REVISION" ? "the approved checksum is stale — the output was re-encoded, so run technical QC again and approve the new checksum" : "this route cannot build the package in the export's current state"}. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 404) {
    return { phase: "error", message: `Package download failed (HTTP 404): this export or its manifest is unknown locally. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 400) {
    return { phase: "error", message: `Package download refused (HTTP 400): the request is scoped to the owning project — the projectId parameter must match. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === 422) {
    return { phase: "error", message: `Package build failed (HTTP 422 ${code}): the local media tools could not produce the package. Nothing was lost — the previous valid package, if any, is preserved. ${serverMessage} (requestId ${requestId})`.trim() };
  }
  if (httpStatus === null) {
    return { phase: "error", message: "Package download failed: network error — the local studio server could not be reached. Retry once it is running." };
  }
  return { phase: "error", message: `Package download failed (HTTP ${httpStatus} ${code}): ${serverMessage || "the server answered with a response this page does not understand"}. (requestId ${requestId})` };
}

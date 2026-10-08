import type { HonoredInputsReceipt } from "../../production/contracts";
type HonoredInputItem = HonoredInputsReceipt["inputs"][number];

export type H3Mode = "FL2VA" | "FLF2V" | "Ref2VA" | "T2V" | "unknown";

export function h3ModeForModel(modelId: string): H3Mode {
  if (/^minimax-h3-ref2va-[a-z0-9_-]*r2v(?:_|$)/i.test(modelId)) return "Ref2VA";
  if (/^minimax-h3-(?:fl2va|fastvideo-int8)[-_][a-z0-9_-]*flf2v(?:_|$)/i.test(modelId)) return "FLF2V";
  if (/^minimax-h3-(?:fl2va|fastvideo-int8)[-_][a-z0-9_-]*i2v(?:_|$)/i.test(modelId)) return "FL2VA";
  if (/^minimax-h3-(?:fl2va|fastvideo-int8)[-_][a-z0-9_-]*t2v(?:_|$)/i.test(modelId)) return "T2V";
  return "unknown";
}

export function h3FrameCountLegal(frames: number): boolean {
  return Number.isSafeInteger(frames) && frames >= 124 && frames <= 362 && (frames - 124) % 17 === 0;
}

/* ---------------- Production model dropdown catalog (anchor / take) ---------------- */

/** The two generate forms' model kinds: anchors (image) and takes (i2v video). */
export type ProductionModelKind = "anchor" | "take";
/** A dropdown entry: raw provider model id (what quotes/enqueues submit), display label, workflow mode. */
export interface ProductionModelOption { id: string; label: string; mode: "image" | "image-to-video" }
/** Minimal catalog slice the merge needs; catalog entries win for labels, the baseline is always merged in. */
export interface ProductionCatalogEntry { id: string; label: string }

/**
 * Accepted pilot baselines, always merged into GET /api/production/models so the dropdowns stay
 * deterministic offline (the live studio catalog hides every Sogni model while SOGNI_API_KEY is
 * unset). Anchor: the accepted anchor pilot. Take: the approved-anchor i2v family (FL2VA) siblings.
 */
export const PRODUCTION_MODEL_BASELINE: Readonly<Record<ProductionModelKind, readonly string[]>> = {
  anchor: ["flux1-schnell-fp8"],
  take: ["minimax-h3-fl2va-fp8_i2v_turbo", "minimax-h3-fl2va-fp8_i2v"],
};
/** Preselected model per form; always the first baseline entry. */
export const PRODUCTION_MODEL_DEFAULTS: Readonly<Record<ProductionModelKind, string>> = {
  anchor: PRODUCTION_MODEL_BASELINE.anchor[0],
  take: PRODUCTION_MODEL_BASELINE.take[0],
};

/** Takes always ride the approved anchor, so only the FL2VA i2v endpoint variants are drivable. */
export function isProductionTakeModelId(modelId: string): boolean {
  return h3ModeForModel(modelId) === "FL2VA" && /i2v(?:_turbo)?$/i.test(modelId);
}

const modeSuffix: Record<ProductionModelKind, string> = { anchor: "", take: " — image-to-video" };

/**
 * Pure dropdown assembly: merge the baseline first (so the preselected default is always the top
 * option), then catalog-only extras. Dedupe by raw id; catalog entries win for labels. The take
 * kind keeps only drivable i2v entries. With an empty catalog this is exactly the baseline, which
 * keeps the route deterministic offline.
 */
export function productionModelOptions(kind: ProductionModelKind, catalogModels: ReadonlyArray<ProductionCatalogEntry>): ProductionModelOption[] {
  const mode = kind === "anchor" ? "image" as const : "image-to-video" as const;
  const byId = new Map(catalogModels.map((model) => [model.id, model]));
  const options: ProductionModelOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, label: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    options.push({ id, label: `${label.trim() !== "" ? label : id}${modeSuffix[kind]}`, mode });
  };
  for (const id of PRODUCTION_MODEL_BASELINE[kind]) push(id, byId.get(id)?.label ?? id);
  for (const model of catalogModels) {
    if (kind === "take" && !isProductionTakeModelId(model.id)) continue;
    push(model.id, model.label);
  }
  return options;
}

export function timedKeyframesSupported(version: string | null | undefined): boolean {
  return timedKeyframesStatus(version) === true;
}

export function timedKeyframesStatus(version: string | null | undefined): boolean | null {
  if (!version) return null;
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!parsed || version.includes("-")) return null;
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return major > 5 || (major === 5 && (minor > 58 || (minor === 58 && patch >= 0))) ? true : false;
}

export interface H3RequestCheck {
  ok: boolean;
  reason: string | null;
  mode: H3Mode;
  timedKeyframesSupported: boolean;
}
export interface H3Request {
  modelId: string;
  startFrame: boolean;
  endFrame?: boolean;
  contextImages: number;
  contextVideos: number;
  contextAudios: number;
  frameCount: number;
  sdkVersion: string;
  timedKeyframes?: boolean;
  requestedResolution?: string;
  knownResolution?: string;
}

/** Local compatibility check only: it never truncates inputs or submits a project. */
export function checkH3Request(request: H3Request): H3RequestCheck {
  const mode = h3ModeForModel(request.modelId);
  const keyframes = timedKeyframesSupported(request.sdkVersion);
  const fail = (reason: string): H3RequestCheck => ({ ok: false, reason, mode, timedKeyframesSupported: keyframes });
  if (mode === "unknown") return fail("Unknown H3 model mode; live capability discovery required.");
  for (const [name, value] of [["contextImages", request.contextImages], ["contextVideos", request.contextVideos], ["contextAudios", request.contextAudios]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) return fail(`${name} must be a nonnegative integer.`);
  }
  if (mode === "FLF2V" && (!request.startFrame || !request.endFrame)) return fail("FLF2V requires both start and end frame references.");
  if (mode === "FL2VA" && !request.startFrame && !request.endFrame) return fail("FL2VA requires a start or end frame reference.");
  if (mode === "Ref2VA" && request.endFrame) return fail("Ref2VA does not accept an end-frame anchor; use FLF2V for explicit endpoints.");
  if (mode === "Ref2VA" && request.startFrame) return fail("Ref2VA has no frame-anchor fields; provide an explicit context_image reference instead.");
  if (mode === "Ref2VA" && request.contextImages === 0 && request.contextVideos === 0) return fail("Ref2VA requires at least one visual reference.");
  if (mode !== "Ref2VA" && (request.contextImages > 0 || request.contextVideos > 0 || request.contextAudios > 0)) return fail("Context media requires the explicit Ref2VA workflow.");
  // Ref2VA has no endpoint frame fields; its explicit image context list has a nine-image limit.
  if (mode === "Ref2VA" && request.contextImages > 9) return fail("Visual reference capacity exceeded; remove references explicitly or select a compatible model.");
  if (mode === "Ref2VA" && (request.contextVideos > 3 || request.contextAudios > 3 || request.contextImages + request.contextVideos + request.contextAudios > 12)) return fail("Ref2VA total reference capacity exceeded.");
  if (!h3FrameCountLegal(request.frameCount)) return fail("H3 frame count must satisfy 124 + 17n and be at most 362.");
  if (request.timedKeyframes && !keyframes) return fail("Timed keyframes require a verified compatible Sogni SDK version (5.58.0 or newer).");
  if (request.requestedResolution && request.knownResolution && request.requestedResolution !== request.knownResolution) return fail("Conflicting resolution evidence; resolution remains unknown pending live probe.");
  if (request.requestedResolution && !request.knownResolution) return fail("Requested resolution is not verified by live capability evidence.");
  return { ok: true, reason: null, mode, timedKeyframesSupported: keyframes };
}

export interface H3InputReference { assetId: string; role: string; required: boolean }

/** Names the SDK request field only; mapping does not claim transport or visual adherence. */
export function mapH3InputFields(modelId: string, inputs: H3InputReference[]): HonoredInputItem[] {
  const mode = h3ModeForModel(modelId);
  const mapped: HonoredInputItem[] = [];
  let imageIndex = 0; let videoIndex = 0; let audioIndex = 0; let totalRefIndex = 0;
  const usedEndpointFields = new Set<string>();
  for (const input of inputs) {
    let providerField: string | null = null;
    if (mode === "FL2VA" || mode === "FLF2V") {
      if (input.role === "start_frame" && !usedEndpointFields.has("referenceImage")) providerField = "referenceImage";
      if (input.role === "end_frame" && !usedEndpointFields.has("referenceImageEnd")) providerField = "referenceImageEnd";
      if (providerField) usedEndpointFields.add(providerField);
    } else if (mode === "Ref2VA") {
      if (input.role === "context_image") {
        const index = imageIndex++;
        if (index < 9 && totalRefIndex < 12) providerField = index === 0 ? "referenceImage" : "contextImages";
      } else if (input.role === "context_video") {
        const index = videoIndex++;
        if (index < 3 && totalRefIndex < 12) providerField = index === 0 ? "referenceVideo" : "referenceVideos";
      } else if (input.role === "context_audio") {
        const index = audioIndex++;
        if (index < 3 && totalRefIndex < 12) providerField = index === 0 ? "referenceAudio" : "referenceAudios";
      }
      if (input.role === "context_image" || input.role === "context_video" || input.role === "context_audio") totalRefIndex += 1;
    }
    mapped.push({ role: input.role, assetId: input.assetId, required: input.required, state: providerField ? "mapped" : (mode === "unknown" ? "unknown" : "rejected"), providerField, disclosedOmission: providerField ? null : "No compatible provider request field or remaining capacity was verified for this workflow and role." });
  }
  return mapped;
}

/** Apply only an observed transport-level project acceptance/rejection; never visual adherence. */
export function acknowledgeH3Transport(receipt: HonoredInputsReceipt, accepted: boolean): HonoredInputsReceipt {
  return {
    ...receipt,
    inputs: receipt.inputs.map((input) => input.state === "mapped"
      ? { ...input, state: accepted ? "acknowledged" : "rejected", disclosedOmission: accepted ? null : "Provider transport rejected the request; visual adherence was not assessed." }
      : input),
  };
}

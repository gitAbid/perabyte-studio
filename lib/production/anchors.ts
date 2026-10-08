import { z } from "zod";
import {
  AnchorCandidateSchema, AnchorRenderSettingsSchema, CanonRevisionSchema, ShotRevisionSchema,
  isEnvironmentKind, type AnchorCandidate, type CanonRevision, type ShotRevision,
} from "./contracts";
import { ProductionApplicationError } from "./errors";
import { displayLabelForCanonRevision } from "./story-view-model";

/**
 * Wave-2 anchor commands (spec 09). Pure derivation only — no IO, no React, no job writes.
 * `buildAnchorGenerationCommand` composes everything a caller needs to submit an anchor
 * generation (model-facing prompt, provider inputs, validated render settings) plus a
 * creator-visible summary that stays free of internal jargon. Identity and wardrobe come
 * from the shot's cast bindings and their bound canon revisions; the environment comes from
 * the pinned environment canon revision. `recommendAnchorCandidate` picks the best
 * assessed candidate — advisory only; it never approves anything (CONTRACTS-FROZEN C8).
 */

/** Alias of the frozen `AnchorRenderSettingsSchema` shape (contracts exports no named type for it). */
export type AnchorRenderSettings = z.infer<typeof AnchorRenderSettingsSchema>;

export type AnchorReferenceInput = { assetId: string; role: string; required: boolean };

/**
 * Everything required to submit one anchor generation, with the human-readable summary
 * kept separate from the model-facing prompt. The caller still owns `projectId`,
 * `quoteId` and `idempotencyKey` (see `CreateAnchorCommandSchema`).
 */
export type AnchorCommandDraft = {
  shotRevisionId: string;
  /** Model-facing generation prompt: framing, visual intent, cast identity/wardrobe, environment. */
  prompt: string;
  /** One plain-language line a creator can read before spending money. */
  summary: string;
  /** Validated render settings, echoed verbatim. */
  renderSettings: AnchorRenderSettings;
  /** Reference image inputs shaped for `ProviderRequestSnapshotSchema.inputs`, deduplicated by asset. */
  inputs: AnchorReferenceInput[];
  /** Character canon revisions the generation pins (the shot's cast bindings, validated). */
  identityCanonRevisionIds: string[];
  /** Environment canon revision the generation pins, or null when none was provided. */
  environmentCanonRevisionId: string | null;
};

const BuildAnchorCommandInputSchema = z.strictObject({
  shot: ShotRevisionSchema,
  characterRevisions: z.array(CanonRevisionSchema).max(500),
  environmentRevision: CanonRevisionSchema.nullable(),
  settings: AnchorRenderSettingsSchema,
});

const FRAMING_LABELS: Record<ShotRevision["framing"], string> = {
  extreme_wide: "extreme wide shot",
  wide: "wide shot",
  medium_wide: "medium-wide shot",
  medium: "medium shot",
  close: "close-up",
  extreme_close: "extreme close-up",
};

const SUMMARY_INTENT_MAX_CHARS = 160;
const REFERENCE_ROLE_MAX_CHARS = 200;

function failInvalidInput(context: string, error: z.ZodError): never {
  const issue = error.issues[0];
  throw new ProductionApplicationError(
    "INVALID_INPUT",
    `${context} does not match the frozen contracts at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`,
  );
}

const firstVisualIntentLine = (visualIntent: string): string => {
  const line = visualIntent.split("\n", 1)[0]?.trim() ?? "";
  const capped = line.length <= SUMMARY_INTENT_MAX_CHARS ? line : `${line.slice(0, SUMMARY_INTENT_MAX_CHARS - 1)}…`;
  return /[.!?…]$/.test(capped) ? capped : `${capped}.`;
};

/** Creator-facing description that never repeats the label when the description already leads with it. */
const describeCanon = (revision: CanonRevision): string => {
  const label = displayLabelForCanonRevision(revision);
  const description = revision.description.trim();
  if (label === revision.entityId || description.toLowerCase().startsWith(label.toLowerCase())) return description;
  return `${label} — ${description}`;
};

/**
 * Builds the anchor generation draft for one shot. Cast bindings must resolve to
 * character canon revisions of matching entity, and a provided environment revision must
 * be environment-kind; violations fail closed with `UNKNOWN_REFERENCE` so no anchor is
 * ever composed from unresolved identity. Anchors are still frames, so the shot's motion
 * intent is deliberately left out of the prompt (it belongs to take `MotionSettings`).
 */
export function buildAnchorGenerationCommand(input: {
  shot: ShotRevision;
  characterRevisions: CanonRevision[];
  environmentRevision: CanonRevision | null;
  settings: AnchorRenderSettings;
}): AnchorCommandDraft {
  const parsed = BuildAnchorCommandInputSchema.safeParse(input);
  if (!parsed.success) failInvalidInput("Anchor command input", parsed.error);
  const { shot, characterRevisions, environmentRevision, settings } = parsed.data;

  const revisionById = new Map(characterRevisions.map((revision) => [revision.id, revision]));
  const cast = shot.castBindings.map((binding) => {
    const revision = revisionById.get(binding.canonRevisionId);
    if (!revision) {
      throw new ProductionApplicationError(
        "UNKNOWN_REFERENCE",
        `Shot ${shot.shotId} casts character ${binding.characterId} through unknown character revision ${binding.canonRevisionId}; resolve the cast before generating an anchor.`,
        { field: "characterRevisions", shotId: shot.id },
      );
    }
    if (revision.entityKind !== "character") {
      throw new ProductionApplicationError(
        "UNKNOWN_REFERENCE",
        `Shot ${shot.shotId} binds ${binding.canonRevisionId} as a character, but that revision is a ${revision.entityKind}.`,
        { field: "characterRevisions", shotId: shot.id },
      );
    }
    if (revision.entityId !== binding.characterId) {
      throw new ProductionApplicationError(
        "UNKNOWN_REFERENCE",
        `Shot ${shot.shotId} casts ${binding.characterId} through revision ${binding.canonRevisionId}, which belongs to character ${revision.entityId}.`,
        { field: "characterRevisions", shotId: shot.id },
      );
    }
    return { binding, revision };
  });
  if (environmentRevision !== null && !isEnvironmentKind(environmentRevision.entityKind)) {
    throw new ProductionApplicationError(
      "UNKNOWN_REFERENCE",
      `Anchor environment pin ${environmentRevision.id} is a ${environmentRevision.entityKind}, not an environment.`,
      { field: "environmentRevision", shotId: shot.id },
    );
  }

  const framingLabel = FRAMING_LABELS[shot.framing];
  const prompt = [
    `${framingLabel}: ${shot.visualIntent}`,
    ...cast.map(({ binding, revision }) =>
      `${describeCanon(revision).replace(/[.]+\s*$/, "")}. Wardrobe: ${binding.wardrobe}.`),
    ...(environmentRevision === null
      ? []
      : [`${describeCanon(environmentRevision).replace(/[.]+\s*$/, "")}.`]),
  ].join("\n");

  const castSummary = cast.map(({ binding, revision }) => {
    const label = displayLabelForCanonRevision(revision);
    return `${label}, wearing ${binding.wardrobe}`;
  });
  const summary = [
    `Anchor still, ${framingLabel} — ${firstVisualIntentLine(shot.visualIntent)}`,
    castSummary.length > 0 ? `Cast: ${castSummary.join("; ")}.` : null,
    environmentRevision === null ? "No environment pinned yet." : `Setting: ${describeCanon(environmentRevision).replace(/[.]+\s*$/, "")}.`,
  ].filter((part): part is string => part !== null).join(" ");

  const inputs: AnchorReferenceInput[] = [];
  const pushReference = (assetId: string, role: string, required: boolean): void => {
    const existing = inputs.find((candidate) => candidate.assetId === assetId);
    if (existing) {
      existing.required = existing.required || required;
      return;
    }
    inputs.push({ assetId, role: role.slice(0, REFERENCE_ROLE_MAX_CHARS), required });
  };
  for (const { revision } of cast) {
    for (const assetId of revision.referenceAssetIds) pushReference(assetId, `character_identity:${revision.entityId}`, true);
  }
  if (environmentRevision !== null) {
    for (const assetId of environmentRevision.referenceAssetIds) pushReference(assetId, "environment_reference", true);
  }
  for (const assetId of settings.referenceAssetIds) pushReference(assetId, "creator_reference", true);

  return {
    shotRevisionId: shot.id,
    prompt,
    summary,
    renderSettings: settings,
    inputs,
    identityCanonRevisionIds: shot.castBindings.map((binding) => binding.canonRevisionId),
    environmentCanonRevisionId: environmentRevision === null ? null : environmentRevision.id,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate recommendation                                            */
/* ------------------------------------------------------------------ */

const RecommendInputSchema = z.array(AnchorCandidateSchema).max(10_000);

const MISSING_SCORE = -1;

/** Qualification bar: a vision assessment that reached a verdict (pass or warning). */
const qualifies = (candidate: AnchorCandidate): boolean =>
  candidate.visionAssessment !== null &&
  (candidate.visionAssessment.status === "pass" || candidate.visionAssessment.status === "warning");

const statusRank = (candidate: AnchorCandidate): number =>
  candidate.visionAssessment?.status === "pass" ? 0 : 1;

const meanScore = (candidate: AnchorCandidate): number => {
  const scores = candidate.visionAssessment?.scores;
  if (!scores) return 0;
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
};

const stabilityScore = (candidate: AnchorCandidate): number => {
  const stability = candidate.visionAssessment?.scores?.["stability"];
  return typeof stability === "number" ? stability : MISSING_SCORE;
};

/**
 * Recommends the strongest assessed candidate: qualifying candidates carry a vision
 * assessment with status `pass` or `warning`; ranking is vision assessment outcome first
 * (pass above warning), then mean assessment score, then the `stability` score, then the
 * newest candidate. Returns null when nothing qualifies — no assessment, no
 * recommendation (a score is an implementation detail; approval stays a human act).
 */
export function recommendAnchorCandidate(candidates: AnchorCandidate[]): AnchorCandidate | null {
  const parsed = RecommendInputSchema.safeParse(candidates);
  if (!parsed.success) failInvalidInput("Anchor candidate list", parsed.error);

  const sorted = parsed.data.filter(qualifies).sort((left, right) =>
    statusRank(left) - statusRank(right) ||
    meanScore(right) - meanScore(left) ||
    stabilityScore(right) - stabilityScore(left) ||
    right.createdAt - left.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sorted[0] ?? null;
}

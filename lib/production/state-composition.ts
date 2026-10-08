import { z } from "zod";
import {
  ResolvedStatesStampSchema,
  type CharacterState,
  type EnvironmentState,
  type ResolvedStatesStamp,
} from "./contracts";
import { ProductionApplicationError } from "./errors";
import { resolveCharacterStateWithSources, resolveEnvironmentStateWithSources } from "./states";

/**
 * Continuity-state composition (M4). Turns resolved character/environment states into (a) a
 * deterministic, canonical text block appended to generation prompts under a stable section
 * header and (b) a structured {@link ResolvedStatesStamp} recorded on the request snapshot so
 * every provider request is auditable down to the layer that supplied each field. Generation
 * requests are therefore composed from RESOLVED structured state, not just prose.
 *
 * Layers are named explicitly (`canon` -> `production` -> `scene` -> `shot`) and sorted into
 * contract order before the field-wise resolvers in `states.ts` decide precedence; this module
 * only renders and stamps the outcome. Contentless states (only ids and empty arrays — the
 * default scene draft shape) are a deliberate no-op: no prompt lines, no stamp, byte-identical
 * snapshot.
 */

/** Stable prompt section header; prompts carry the block as `<base>\n\n<header>\n...`. */
export const CONTINUITY_STATE_SECTION = "--- continuity state ---";

const STATE_LAYER_NAMES = ["canon", "production", "scene", "shot"] as const;
export type StateLayerName = (typeof STATE_LAYER_NAMES)[number];
const LAYER_ORDER: Record<StateLayerName, number> = { canon: 0, production: 1, scene: 2, shot: 3 };

/** One named state layer; `at` records which inheritance layer the state came from. */
export type StateLayerInput<S> = { at: StateLayerName; state: S };

export type ComposedStateField = { field: string; value: string | string[]; layer: StateLayerName };
export type ComposedCharacterState = { characterCanonRevisionId: string; fields: ComposedStateField[] };
export type ComposedEnvironmentState = { environmentCanonRevisionId: string; fields: ComposedStateField[] };
export type ComposedGenerationStates = Readonly<{
  /** Deterministic section text (header included); "" when no state content exists. */
  promptBlock: string;
  characters: readonly ComposedCharacterState[];
  environment: ComposedEnvironmentState | null;
}>;

const StateLayerSchema = z.strictObject({ at: z.enum(STATE_LAYER_NAMES), state: z.unknown() });
const ComposeInputSchema = z.strictObject({
  characters: z.array(z.array(StateLayerSchema).max(4)).max(10),
  environment: z.array(StateLayerSchema).max(4).nullable(),
});

function fail(message: string): never {
  throw new ProductionApplicationError("INVALID_INPUT", message);
}

/** Sorts named layers into contract resolution order and rejects duplicates (fail closed). */
function orderedLayers<S>(entries: ReadonlyArray<{ at: string; state: S }>): { states: S[]; nameAt: (index: number) => StateLayerName } {
  const seen = new Set<string>();
  const sorted = [...entries].sort((left, right) => {
    const leftOrder = LAYER_ORDER[left.at as StateLayerName];
    const rightOrder = LAYER_ORDER[right.at as StateLayerName];
    if (leftOrder === undefined || rightOrder === undefined) fail(`Unknown state layer name; expected one of ${STATE_LAYER_NAMES.join(", ")}.`);
    return leftOrder - rightOrder;
  });
  for (const entry of sorted) {
    if (seen.has(entry.at)) fail(`Duplicate ${entry.at} state layer; each layer may appear at most once.`);
    seen.add(entry.at);
  }
  const names = sorted.map(entry => entry.at as StateLayerName);
  return { states: sorted.map(entry => entry.state), nameAt: index => {
    const name = names[index];
    if (!name) fail(`State layer index ${index} is out of range.`);
    return name;
  } };
}

/** Contract field order keeps both the stamp and the rendered block deterministic. */
const CHARACTER_FIELD_ORDER: ReadonlyArray<Extract<keyof Omit<CharacterState, "characterCanonRevisionId">, string>> =
  ["outfit", "hairState", "accessories", "carriedObjects", "condition", "agePresentation", "notes"];
const ENVIRONMENT_FIELD_ORDER: ReadonlyArray<Extract<keyof Omit<EnvironmentState, "environmentCanonRevisionId">, string>> =
  ["zone", "lighting", "timeOfDay", "weather", "persistentProps"];

function composeFields<T extends object>(
  order: ReadonlyArray<Extract<keyof T, string>>,
  resolved: Partial<T>,
  sources: Partial<Record<keyof T, number>>,
  nameAt: (index: number) => StateLayerName,
): ComposedStateField[] {
  const fields: ComposedStateField[] = [];
  for (const field of order) {
    const value = resolved[field];
    // A defined empty array is an override with no content (the default draft shape); it adds
    // nothing to the prompt or the audit stamp, so it is skipped along with absent fields.
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    fields.push({ field, value: value as string | string[], layer: nameAt(sources[field] ?? -1) });
  }
  return fields;
}

function renderFields(fields: readonly ComposedStateField[]): string {
  return fields.map(({ field, value }) => `${field}: ${Array.isArray(value) ? value.join(", ") : value}`).join("; ");
}

function composeCharacterState(layers: ReadonlyArray<StateLayerInput<Partial<CharacterState>>>): ComposedCharacterState | null {
  const { states, nameAt } = orderedLayers(layers);
  const { resolved, sources } = resolveCharacterStateWithSources(states);
  if (resolved.characterCanonRevisionId === undefined) fail("A composed character state must pin characterCanonRevisionId in its least-specific layer.");
  const fields = composeFields(CHARACTER_FIELD_ORDER, resolved, sources, nameAt);
  return fields.length === 0 ? null : { characterCanonRevisionId: resolved.characterCanonRevisionId, fields };
}

function composeEnvironmentState(layers: ReadonlyArray<StateLayerInput<Partial<EnvironmentState>>>): ComposedEnvironmentState | null {
  const { states, nameAt } = orderedLayers(layers);
  const { resolved, sources } = resolveEnvironmentStateWithSources(states);
  if (resolved.environmentCanonRevisionId === undefined) fail("A composed environment state must pin environmentCanonRevisionId in its least-specific layer.");
  const fields = composeFields(ENVIRONMENT_FIELD_ORDER, resolved, sources, nameAt);
  return fields.length === 0 ? null : { environmentCanonRevisionId: resolved.environmentCanonRevisionId, fields };
}

function renderPromptBlock(characters: readonly ComposedCharacterState[], environment: ComposedEnvironmentState | null): string {
  const lines: string[] = [];
  if (characters.length > 0) {
    lines.push("characters:");
    for (const character of characters) lines.push(`- ${character.characterCanonRevisionId}: ${renderFields(character.fields)}`);
  }
  if (environment !== null) {
    lines.push("environment:");
    lines.push(`- ${environment.environmentCanonRevisionId}: ${renderFields(environment.fields)}`);
  }
  return lines.length === 0 ? "" : [CONTINUITY_STATE_SECTION, ...lines].join("\n");
}

/**
 * Resolves the given per-character and environment state layers (each entry names its
 * inheritance layer; duplicates and unknown names fail closed) and renders the deterministic
 * continuity block. Characters are ordered by pinned canon revision id so the block — and
 * therefore every hash derived from the prompt — is stable regardless of input order. Empty
 * or contentless inputs compose to an empty block.
 */
export function composeGenerationStates(input: {
  characters: ReadonlyArray<ReadonlyArray<StateLayerInput<Partial<CharacterState>>>>;
  environment: ReadonlyArray<StateLayerInput<Partial<EnvironmentState>>> | null;
}): ComposedGenerationStates {
  const parsed = ComposeInputSchema.safeParse(input);
  if (!parsed.success) fail(`State composition input is invalid: ${parsed.error.issues[0]?.message ?? "validation failed"}.`);
  const characters = parsed.data.characters
    .map(layers => composeCharacterState(layers as ReadonlyArray<StateLayerInput<Partial<CharacterState>>>))
    .filter((state): state is ComposedCharacterState => state !== null)
    .sort((left, right) => (left.characterCanonRevisionId < right.characterCanonRevisionId ? -1 : left.characterCanonRevisionId > right.characterCanonRevisionId ? 1 : 0));
  const environment = parsed.data.environment === null ? null : composeEnvironmentState(parsed.data.environment as ReadonlyArray<StateLayerInput<Partial<EnvironmentState>>>);
  return Object.freeze({ promptBlock: renderPromptBlock(characters, environment), characters: Object.freeze(characters), environment });
}

/** Appends the continuity block as a stable trailing section; a no-op when the block is empty. */
export function appendContinuityState(prompt: string, promptBlock: string): string {
  return promptBlock.length === 0 ? prompt : `${prompt}\n\n${promptBlock}`;
}

/**
 * Snapshot stamp for the composed states, or null when nothing was composed (keeps legacy and
 * contentless snapshots byte-identical to the pre-state shape). Contract-validated so the
 * stamped shape can never drift from {@link ResolvedStatesStampSchema}.
 */
export function resolvedStatesStamp(composed: ComposedGenerationStates, sceneId: string | null): ResolvedStatesStamp | null {
  if (composed.characters.length === 0 && composed.environment === null) return null;
  return ResolvedStatesStampSchema.parse({
    version: 1,
    sceneId,
    characters: composed.characters.map(character => ({ characterCanonRevisionId: character.characterCanonRevisionId, fields: character.fields })),
    environment: composed.environment,
  });
}

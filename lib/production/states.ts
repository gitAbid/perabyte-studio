import { CharacterStateSchema, EnvironmentStateSchema, type CharacterState, type EnvironmentState } from "./contracts";
import { ProductionApplicationError } from "./errors";

/**
 * CharacterState / EnvironmentState state inheritance (CONTRACTS-FROZEN C6, spec 02 §4–§5).
 *
 * Permanent identity lives in canon; temporary appearance lives in layered production state.
 * Layers are ordered least-specific first (canon defaults -> production -> scene -> shot
 * override) and the resolver wins per FIELD, not per object: a field left `undefined` in a
 * more specific layer inherits the previous layer's value, while a present value replaces it
 * wholesale (arrays replace; they never merge, so a defined empty array is an override).
 * `null` is not a clearing mechanism and fails validation. Every layer is validated against
 * the frozen contract shape, so unknown keys and out-of-bounds values fail closed naming the
 * offending layer.
 */
const CHARACTER_STATE_FIELDS = ["characterCanonRevisionId", "outfit", "hairState", "accessories", "carriedObjects", "condition", "agePresentation", "notes"] as const;
const ENVIRONMENT_STATE_FIELDS = ["environmentCanonRevisionId", "zone", "lighting", "timeOfDay", "weather", "persistentProps"] as const;

function fail(message: string): never {
  throw new ProductionApplicationError("INVALID_INPUT", message);
}

function resolveLayers(
  schema: { partial(): { safeParse(value: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } } } },
  fields: readonly string[],
  layers: ReadonlyArray<Record<string, unknown>>,
  label: string,
): { resolved: Record<string, unknown>; sources: Record<string, number> } {
  if (!Array.isArray(layers)) fail(`${label} state inheritance requires an array of state layers.`);
  const resolved: Record<string, unknown> = {};
  const sources: Record<string, number> = {};
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    if (layer === null || typeof layer !== "object" || Array.isArray(layer)) {
      fail(`${label} state layer ${index} must be a state object.`);
    }
    const parsed = schema.partial().safeParse(layer);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail(`${label} state layer ${index} is invalid at ${issue?.path.join(".") || "unknown path"}: ${issue?.message ?? "validation failed"}.`);
    }
    for (const field of fields) {
      const value = parsed.data[field];
      if (value !== undefined) { resolved[field] = value; sources[field] = index; }
    }
  }
  return { resolved, sources };
}

/** Resolved state plus, per field, the index (least-specific layer = 0) that last supplied a defined value. */
export type ResolvedStateWithSources<T> = { resolved: Partial<T>; sources: Partial<Record<keyof T, number>> };

/**
 * Folds canon defaults -> production -> scene -> shot layers into one character state.
 * Most specific layer wins per field; `undefined` inherits. The resolved state carries
 * `characterCanonRevisionId` when any layer pins one; production call sites always lead with
 * the canon-defaults layer, which pins it.
 */
export function resolveCharacterState(layers: ReadonlyArray<Partial<CharacterState>>): Partial<CharacterState> {
  return resolveLayers(CharacterStateSchema, CHARACTER_STATE_FIELDS, layers, "Character").resolved as Partial<CharacterState>;
}

/** Same field-wise inheritance as {@link resolveCharacterState} for environment state (C6). */
export function resolveEnvironmentState(layers: ReadonlyArray<Partial<EnvironmentState>>): Partial<EnvironmentState> {
  return resolveLayers(EnvironmentStateSchema, ENVIRONMENT_STATE_FIELDS, layers, "Environment").resolved as Partial<EnvironmentState>;
}

/** {@link resolveCharacterState} plus the supplying layer index per resolved field (composition audit). */
export function resolveCharacterStateWithSources(layers: ReadonlyArray<Partial<CharacterState>>): ResolvedStateWithSources<CharacterState> {
  const { resolved, sources } = resolveLayers(CharacterStateSchema, CHARACTER_STATE_FIELDS, layers, "Character");
  return { resolved: resolved as Partial<CharacterState>, sources: sources as Partial<Record<keyof CharacterState, number>> };
}

/** {@link resolveEnvironmentState} plus the supplying layer index per resolved field (composition audit). */
export function resolveEnvironmentStateWithSources(layers: ReadonlyArray<Partial<EnvironmentState>>): ResolvedStateWithSources<EnvironmentState> {
  const { resolved, sources } = resolveLayers(EnvironmentStateSchema, ENVIRONMENT_STATE_FIELDS, layers, "Environment");
  return { resolved: resolved as Partial<EnvironmentState>, sources: sources as Partial<Record<keyof EnvironmentState, number>> };
}

import { describe, expect, it } from "vitest";
import { resolveCharacterState, resolveEnvironmentState } from "./states";

type CharacterLayers = Parameters<typeof resolveCharacterState>[0];
type EnvironmentLayers = Parameters<typeof resolveEnvironmentState>[0];

const canonCharacterLayer = {
  characterCanonRevisionId: "charrev-luna-3",
  outfit: "Travel cloak",
  hairState: "Braided",
  accessories: ["Silver pin"],
  carriedObjects: ["Brass lantern"],
  condition: ["Rested"],
  agePresentation: "Adult",
  notes: "Canon baseline",
};

const canonEnvironmentLayer = {
  environmentCanonRevisionId: "envrev-cafe-1",
  zone: "Counter nook",
  lighting: "Warm practicals",
  timeOfDay: "Morning",
  weather: "Clear",
  persistentProps: ["Espresso machine"],
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("C6 state inheritance resolvers", () => {
  it("resolves the canon layer alone to the complete character state", () => {
    expect(resolveCharacterState([canonCharacterLayer])).toEqual(canonCharacterLayer);
  });

  it("applies most-specific-wins per field across canon, production, scene, and shot layers", () => {
    const resolved = resolveCharacterState([
      canonCharacterLayer,
      { outfit: "Rain coat" },
      { hairState: "Wet braid", accessories: ["Silver pin", "Iron key"] },
      { agePresentation: "Adult, tired" },
    ]);
    expect(resolved).toEqual({
      characterCanonRevisionId: "charrev-luna-3",
      outfit: "Rain coat",
      hairState: "Wet braid",
      accessories: ["Silver pin", "Iron key"],
      carriedObjects: ["Brass lantern"],
      condition: ["Rested"],
      agePresentation: "Adult, tired",
      notes: "Canon baseline",
    });
  });

  it("inherits a field left undefined by a later layer instead of clearing it", () => {
    const resolved = resolveCharacterState([
      canonCharacterLayer,
      { outfit: "Rain coat", hairState: "Wet braid" },
      { outfit: undefined, hairState: undefined },
    ]);
    expect(resolved).toEqual({
      characterCanonRevisionId: "charrev-luna-3",
      outfit: "Rain coat",
      hairState: "Wet braid",
      accessories: ["Silver pin"],
      carriedObjects: ["Brass lantern"],
      condition: ["Rested"],
      agePresentation: "Adult",
      notes: "Canon baseline",
    });
  });

  it("lets the shot layer override a single field without disturbing the rest of the resolution", () => {
    const withoutShot = resolveCharacterState([canonCharacterLayer, { outfit: "Rain coat" }]);
    const withShot = resolveCharacterState([canonCharacterLayer, { outfit: "Rain coat" }, { notes: "Shot: glance back" }]);
    expect(withoutShot.notes).toBe("Canon baseline");
    expect(withShot).toEqual({ ...withoutShot, notes: "Shot: glance back" });
  });

  it("treats a defined empty array as an override, not an inherit", () => {
    const resolved = resolveCharacterState([canonCharacterLayer, { condition: [] }]);
    expect(resolved.condition).toEqual([]);
  });

  it("applies most-specific-wins per field across environment state layers", () => {
    const resolved = resolveEnvironmentState([
      canonEnvironmentLayer,
      { timeOfDay: "Late morning" },
      { lighting: "Overcast window light", weather: "Light rain" },
      { timeOfDay: "Golden hour" },
    ]);
    expect(resolved).toEqual({
      environmentCanonRevisionId: "envrev-cafe-1",
      zone: "Counter nook",
      lighting: "Overcast window light",
      timeOfDay: "Golden hour",
      weather: "Light rain",
      persistentProps: ["Espresso machine"],
    });
  });

  it("inherits omitted environment fields and lets a defined empty persistentProps list override", () => {
    const resolved = resolveEnvironmentState([
      canonEnvironmentLayer,
      { lighting: "Overcast window light", weather: "Light rain" },
      { weather: undefined, persistentProps: [] },
    ]);
    expect(resolved).toEqual({
      environmentCanonRevisionId: "envrev-cafe-1",
      zone: "Counter nook",
      lighting: "Overcast window light",
      timeOfDay: "Morning",
      weather: "Light rain",
      persistentProps: [],
    });
  });

  it("never mutates the input layers", () => {
    const characterLayers = deepFreeze([canonCharacterLayer, { outfit: "Rain coat" }] as CharacterLayers);
    const environmentLayers = deepFreeze([canonEnvironmentLayer, { weather: "Storm" }] as EnvironmentLayers);
    expect(() => resolveCharacterState(characterLayers)).not.toThrow();
    expect(() => resolveEnvironmentState(environmentLayers)).not.toThrow();
    expect(characterLayers[0]).toEqual(canonCharacterLayer);
    expect(environmentLayers[0]).toEqual(canonEnvironmentLayer);
  });
});

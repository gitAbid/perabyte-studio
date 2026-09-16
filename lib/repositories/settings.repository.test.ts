import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  bumpCatalogVersion,
  getCatalogVersion,
  getSelectedModel,
  getSettings,
  resetSettingsForTests,
  setSelectedModel,
  setMaskUncensored,
  setSoloCharacters,
  setStoryCharacters,
  setUncensoredEnabled,
} from "@/lib/repositories/settings.repository";

class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: new LocalStorageStub() });
  resetSettingsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSettingsForTests();
});

describe("settings repository", () => {
  it("defaults to uncensored disabled", () => {
    expect(getSettings()).toEqual(DEFAULT_USER_SETTINGS);
    expect(getSettings().uncensoredEnabled).toBe(false);
  });

  it("persists the uncensored toggle", () => {
    setUncensoredEnabled(true);
    expect(getSettings().uncensoredEnabled).toBe(true);
    const raw = window.localStorage.getItem("perabyte.settings.v1");
    expect(JSON.parse(raw as string).uncensoredEnabled).toBe(true);
  });

  it("defaults to masking uncensored content", () => {
    expect(getSettings().maskUncensored).toBe(true);
  });

  it("persists the mask toggle", () => {
    setMaskUncensored(false);
    expect(getSettings().maskUncensored).toBe(false);
    const raw = window.localStorage.getItem("perabyte.settings.v1");
    expect(JSON.parse(raw as string).maskUncensored).toBe(false);
  });

  it("stores model selections per kind and reports them back", () => {
    setSelectedModel("image", "apikey-fan:grok-imagine-image-2.0");
    setSelectedModel("video", "pollinations:flux-keyframe");
    expect(getSelectedModel("image")).toBe("apikey-fan:grok-imagine-image-2.0");
    expect(getSelectedModel("video")).toBe("pollinations:flux-keyframe");
  });

  it("merges new fields over stored settings without losing unknown ones", () => {
    window.localStorage.setItem(
      "perabyte.settings.v1",
      JSON.stringify({ uncensoredEnabled: true, futureField: 42 }),
    );
    setUncensoredEnabled(false);
    const settings = getSettings();
    expect(settings.uncensoredEnabled).toBe(false);
    expect((settings as unknown as Record<string, unknown>).futureField).toBe(42);
  });

  it("defaults the attached casts to empty", () => {
    expect(getSettings().soloCharacterIds).toEqual([]);
    expect(getSettings().storyCharacterIds).toEqual([]);
  });

  it("persists attached casts per surface and preserves order", () => {
    setSoloCharacters(["ch_a", "ch_b"]);
    setStoryCharacters(["ch_c"]);
    expect(getSettings().soloCharacterIds).toEqual(["ch_a", "ch_b"]);
    expect(getSettings().storyCharacterIds).toEqual(["ch_c"]);
    setSoloCharacters([]);
    expect(getSettings().soloCharacterIds).toEqual([]);
    expect(getSettings().storyCharacterIds).toEqual(["ch_c"]);
  });

  it("promotes a legacy single-character attach to a one-entry cast", () => {
    window.localStorage.setItem(
      "perabyte.settings.v1",
      JSON.stringify({ soloCharacterId: "ch_legacy", storyCharacterId: "" }),
    );
    resetSettingsForTests();
    const settings = getSettings();
    expect(settings.soloCharacterIds).toEqual(["ch_legacy"]);
    expect(settings.storyCharacterIds).toEqual([]);
  });

  it("bumps the catalog version on demand", () => {
    const start = getCatalogVersion();
    bumpCatalogVersion();
    expect(getCatalogVersion()).toBe(start + 1);
    bumpCatalogVersion();
    expect(getCatalogVersion()).toBe(start + 2);
  });

  it("accepts null to clear a model default", () => {
    setSelectedModel("image", "pollinations:flux");
    setSelectedModel("image", null);
    expect(getSelectedModel("image")).toBeNull();
  });
});

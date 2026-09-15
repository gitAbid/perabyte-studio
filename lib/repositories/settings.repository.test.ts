import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_SETTINGS,
  getSelectedModel,
  getSettings,
  resetSettingsForTests,
  setSelectedModel,
  setMaskUncensored,
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
});

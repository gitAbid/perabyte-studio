import { describe, expect, it } from "vitest";
import type { ModelVideoLimits } from "@/lib/domain/models";
import { allowedOptions, snapSettingsForModel } from "@/lib/render-options";

const MINIMAX: ModelVideoLimits = {
  duration: { min: 124 / 24, max: 362 / 24 },
  ratios: ["16:9", "9:16", "1:1", "4:5", "3:2"],
  resolutions: ["720p", "1080p"],
};

const GROK: ModelVideoLimits = {
  duration: { min: 1, max: 15 },
  ratios: [],
  resolutions: [],
};

describe("allowedOptions", () => {
  it("keeps every preset when limits are unknown (image models)", () => {
    const allowed = allowedOptions(undefined);
    expect(allowed.durations).toEqual(["3s", "5s", "6s", "8s", "10s", "15s"]);
    expect(allowed.aspects).toHaveLength(5);
    expect(allowed.resolutions).toHaveLength(4);
  });

  it("drops duration presets outside the model's range", () => {
    // MiniMax H3: everything under 5.167s and over 15.083s is unrenderable.
    expect(allowedOptions(MINIMAX).durations).toEqual(["6s", "8s", "10s", "15s"]);
    // Grok's 1–15s window covers every preset.
    expect(allowedOptions(GROK).durations).toEqual(["3s", "5s", "6s", "8s", "10s", "15s"]);
  });

  it("hides the aspect/resolution pickers for models without those inputs", () => {
    expect(allowedOptions(GROK).aspects).toEqual([]);
    expect(allowedOptions(GROK).resolutions).toEqual([]);
    expect(allowedOptions(MINIMAX).resolutions).toEqual(["720p", "1080p"]);
  });
});

describe("snapSettingsForModel", () => {
  it("clamps the duration into the model's range", () => {
    const patch = snapSettingsForModel(MINIMAX, {
      duration: "5s",
      aspect: "16:9",
      resolution: "1080p",
    });
    // 5s sits below MiniMax's floor; the nearest preset above is 6s.
    expect(patch.duration).toBe("6s");
    expect(patch.aspect).toBeUndefined();
    expect(patch.resolution).toBeUndefined();
  });

  it("swaps an unsupported aspect/resolution for an accepted default", () => {
    const patch = snapSettingsForModel(MINIMAX, {
      duration: "8s",
      aspect: "16:9",
      resolution: "4K",
    });
    expect(patch.resolution).toBe("1080p");
  });

  it("leaves hidden pickers' values untouched (they are ignored per-model)", () => {
    const patch = snapSettingsForModel(GROK, {
      duration: "3s",
      aspect: "4:5",
      resolution: "4K",
    });
    expect(patch).toEqual({});
  });

  it("returns an empty patch when everything already fits", () => {
    const patch = snapSettingsForModel(MINIMAX, {
      duration: "8s",
      aspect: "16:9",
      resolution: "720p",
    });
    expect(patch).toEqual({});
  });
});

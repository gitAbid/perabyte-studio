import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLoraCatalog, resetLoraCatalogCache } from "./lora-catalog";

const FIXTURE = {
  status: "success",
  data: {
    loras: [
      {
        loraId: "krea2-warm-light",
        name: "Warm Light",
        description: "Golden hour warmth",
        ui: {
          min: -10,
          max: 10,
          default: 1,
          step: 0.1,
          recommendedMin: -3,
          recommendedMax: 3,
          category: "lighting",
          nsfw: false,
          sexual: false,
          rangeLabels: { min: "Cooler & Darker", max: "Warmer & Golden" },
        },
        modelIds: ["krea2_turbo_fp8_scaled"],
      },
      {
        loraId: "broken-entry",
        ui: { category: "lighting" },
      },
    ],
    models: ["krea2_turbo_fp8_scaled"],
    constraints: { maxPerRequest: 8, minStrength: -100, maxStrength: 100 },
  },
};

function mockFetchOnce(payload: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: () => Promise.resolve(payload),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  resetLoraCatalogCache();
  vi.unstubAllGlobals();
});

describe("fetchLoraCatalog", () => {
  it("trims entries to the picker shape and drops malformed rows", async () => {
    mockFetchOnce(FIXTURE);
    const catalog = await fetchLoraCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog!.loras).toHaveLength(1);
    const entry = catalog!.loras[0];
    expect(entry.loraId).toBe("krea2-warm-light");
    expect(entry.min).toBe(-10);
    expect(entry.rangeLabels?.max).toBe("Warmer & Golden");
    expect(catalog!.models).toEqual(["krea2_turbo_fp8_scaled"]);
    expect(catalog!.maxPerRequest).toBe(8);
  });

  it("serves repeat calls from cache without refetching", async () => {
    const fetchMock = mockFetchOnce(FIXTURE);
    await fetchLoraCatalog();
    await fetchLoraCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves null on HTTP failure with no cached copy", async () => {
    mockFetchOnce({}, false);
    expect(await fetchLoraCatalog()).toBeNull();
  });

  it("falls back to the last good copy when a refresh fails", async () => {
    mockFetchOnce(FIXTURE);
    await fetchLoraCatalog();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const stale = await fetchLoraCatalog({ force: true });
    expect(stale).not.toBeNull();
    expect(stale!.loras[0].loraId).toBe("krea2-warm-light");
  });
});

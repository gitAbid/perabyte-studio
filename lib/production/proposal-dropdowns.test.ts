import { describe, expect, it } from "vitest";
import {
  firstTextEngineModelForProvider, parseTextEnginesPayload, textEngineProviderIds,
  type TextEngineOptionView,
} from "@/components/production/project-canon";

const ENGINES: TextEngineOptionView[] = [
  { providerId: "sogni", modelId: "sogni:alpha", label: "sogni:alpha — Sogni" },
  { providerId: "sogni", modelId: "sogni:beta", label: "sogni:beta — Sogni" },
  { providerId: "pollinations", modelId: "pollinations:default", label: "pollinations:default — Pollinations" },
];

describe("proposal text-engine dropdown view model", () => {
  it("parses a well-formed route payload and refuses anything else", () => {
    const payload = { engines: ENGINES };
    expect(parseTextEnginesPayload(payload)).toEqual<TextEngineOptionView[] | null>(ENGINES);

    for (const broken of [
      null,
      "engines",
      {},
      { engines: "nope" },
      { engines: [{ providerId: "sogni", modelId: "sogni:alpha" }] },
      { engines: [{ providerId: "", modelId: "m", label: "L" }] },
      { engines: [{ providerId: "sogni", modelId: "", label: "L" }] },
      { engines: [{ providerId: "sogni", modelId: "m", label: "" }] },
      { engines: [{ providerId: "sogni", modelId: "m", label: "L", mode: "text" }] },
      { engines: [], surprise: 1 },
    ]) {
      expect(parseTextEnginesPayload(broken)).toBeNull();
    }
  });

  it("dedupes provider ids in first-appearance (chain priority) order", () => {
    expect(textEngineProviderIds(ENGINES)).toEqual(["sogni", "pollinations"]);
    expect(textEngineProviderIds([])).toEqual([]);
    expect(textEngineProviderIds([{ providerId: "sogni", modelId: "m", label: "L" }])).toEqual(["sogni"]);
  });

  it("selects a provider's first listed engine and null for an unknown provider", () => {
    expect(firstTextEngineModelForProvider(ENGINES, "sogni")).toEqual(ENGINES[0]);
    expect(firstTextEngineModelForProvider(ENGINES, "pollinations")).toEqual(ENGINES[2]);
    expect(firstTextEngineModelForProvider(ENGINES, "unknown")).toBeNull();
    expect(firstTextEngineModelForProvider([], "sogni")).toBeNull();
  });
});

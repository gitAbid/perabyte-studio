import { afterEach, describe, expect, it, vi } from "vitest";
import { callJev, jevApiKey } from "@/lib/jev/client";
import {
  shouldBlock,
  triagePrompt,
  vaguenessHint,
} from "@/lib/jev/triage";

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("jev client", () => {
  it("reports unconfigured when TYPESAFE_API_KEY is absent", () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(jevApiKey()).toBeNull();
  });

  it("calls the systemone endpoint and parses typed answers", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { is_urgent: { type: "noul", noul: 0.999 } },
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await callJev("state", { is_urgent: { type: "noul", instructions: "urgent?" } });
    expect(res).not.toBeNull();
    expect(res?.answers.is_urgent).toEqual({ type: "noul", noul: 0.999 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body).model).toBe("jev-latest");
  });

  it("returns null on provider errors instead of throwing", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    expect(await callJev("s", {})).toBeNull();
  });

  it("returns null when the key is missing without calling fetch", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await callJev("s", {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("prompt triage", () => {
  it("degrades to a no-op triage when Jev is unconfigured", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const t = await triagePrompt("a cat");
    expect(t).toEqual({ unsafeProbability: null, vagueProbability: null, styleHint: null });
  });

  it("blocks only at high unsafe probability", () => {
    expect(shouldBlock({ unsafeProbability: 0.97, vagueProbability: null, styleHint: null })).toBe(true);
    expect(shouldBlock({ unsafeProbability: 0.6, vagueProbability: null, styleHint: null })).toBe(false);
    expect(shouldBlock({ unsafeProbability: null, vagueProbability: null, styleHint: null })).toBe(false);
  });

  it("hints enrichment only for confident vagueness", () => {
    expect(vaguenessHint({ unsafeProbability: null, vagueProbability: 0.9, styleHint: null })).toContain("lighting");
    expect(vaguenessHint({ unsafeProbability: null, vagueProbability: 0.4, styleHint: null })).toBe("");
    expect(vaguenessHint({ unsafeProbability: null, vagueProbability: null, styleHint: null })).toBe("");
  });

  it("parses a full triage response", async () => {
    process.env.TYPESAFE_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "jev-1",
            answers: {
              requests_unsafe: { type: "noul", noul: 0.02 },
              is_vague: { type: "noul", noul: 0.88 },
              style_family: {
                type: "choice",
                choice: "anime",
                probabilities: { anime: 0.9, photoreal: 0.05, illustration: 0.04, design: 0.01 },
                confidence: 0.91,
              },
            },
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
          { status: 200 },
        ),
      ),
    );
    const t = await triagePrompt("anime cat girl in a rainy city");
    expect(t.unsafeProbability).toBeCloseTo(0.02);
    expect(t.vagueProbability).toBeCloseTo(0.88);
    expect(t.styleHint?.choice).toBe("anime");
  });
});

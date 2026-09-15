import { afterEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetEnhancementCacheForTests,
  runPromptEnhancement,
} from "@/lib/services/enhancement.service";

/** Patch global fetch for one call; restores afterwards. */
function mockFetchOnce(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEnhancementCacheForTests();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
});

/** Point the Sogni engine at a fake key (tests that exercise it). */
function enableSogni() {
  process.env.SOGNI_API_KEY = "test-key";
  resetStudioEnvForTests();
}

const BODY = {
  prompt: "a serene mountain landscape",
  kind: "image",
  style: "Cinematic",
  stylesSupported: true,
  aspect: "16:9",
  timeOfDay: "evening",
};

describe("runPromptEnhancement", () => {
  it("returns the AI rewrite on success", async () => {
    mockFetchOnce(
      async () =>
        new Response(
          "A serene mountain landscape at dusk, layered ridgelines fading into haze, cinematic lighting.",
          { status: 200 },
        ),
    );
    const result = await runPromptEnhancement(BODY);
    expect(result.source).toBe("ai");
    expect(result.enhanced).toContain("mountain");
    expect(result.prompt).toBe(BODY.prompt);
  });

  it("falls back deterministically when the free pool is out of budget", async () => {
    mockFetchOnce(
      async () =>
        new Response(
          "The API key used for this request has reached its budget. Please raise the key budget, then try again.",
          { status: 200 },
        ),
    );
    const result = await runPromptEnhancement(BODY);
    expect(result.source).toBe("fallback");
    // The deterministic path still honours the selected style.
    expect(result.enhanced).toContain("cinematic lighting");
  });

  it("falls back when the network fails", async () => {
    mockFetchOnce(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await runPromptEnhancement({ prompt: "a quiet harbor", kind: "image" });
    expect(result.source).toBe("fallback");
    expect(result.enhanced.toLowerCase()).toContain("harbor");
  });

  it("reuses the cached AI reply for an identical request", async () => {
    const fetchMock = mockFetchOnce(
      async () => new Response("Enhanced take one.", { status: 200 }),
    );
    const first = await runPromptEnhancement({ prompt: "a red barn", kind: "image" });
    const second = await runPromptEnhancement({ prompt: "a red barn", kind: "image" });
    expect(first.enhanced).toBe("Enhanced take one.");
    expect(second.enhanced).toBe(first.enhanced);
    expect(second.source).toBe("ai");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty prompt without touching the network", async () => {
    const fetchMock = mockFetchOnce(async () => new Response("x", { status: 200 }));
    await expect(runPromptEnhancement({ prompt: "   " })).rejects.toThrow(
      /write a prompt/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clamps an unknown style to no style context instead of failing", async () => {
    mockFetchOnce(async () => new Response("Some enhanced line.", { status: 200 }));
    const result = await runPromptEnhancement({
      ...BODY,
      style: "Stale Image Style",
    });
    expect(result.source).toBe("ai");
  });

  it("lets a client abort propagate instead of falling back", async () => {
    mockFetchOnce(
      async () => new Response("late", { status: 200 }),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPromptEnhancement(BODY, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("prefers the Sogni engine when its key is configured", async () => {
    enableSogni();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      void url;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "A Sogni-rewritten harbor scene." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPromptEnhancement({ prompt: "a quiet harbor", kind: "image" });
    expect(result.source).toBe("ai");
    expect(result.enhanced).toBe("A Sogni-rewritten harbor scene.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/chat/completions");
  });

  it("falls through Sogni to Pollinations on an empty reasoning reply", async () => {
    enableSogni();
    const fetchMock = vi.fn(async () => {
      return new Response("A Pollinations-rewritten harbor scene.", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runPromptEnhancement({ prompt: "a quiet harbor", kind: "image" });
    expect(result.source).toBe("ai");
    expect(result.enhanced).toContain("Pollinations");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

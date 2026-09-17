import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import type { MediaRepository, StoredMedia } from "@/lib/repositories/media.repository";
import { isValidMediaRef, setMediaRepositoryForTests } from "@/lib/repositories/media.repository";
import {
  clearModerationRepository,
  setModerationPathForTests,
} from "@/lib/repositories/moderation.repository";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import sharp from "sharp";
import {
  classifyMediaRef,
  resetModerationServiceForTests,
  warmModeration,
} from "@/lib/services/moderation.service";

const PNG_REF = "a".repeat(64) + ".png";
const MP4_REF = "b".repeat(64) + ".mp4";
const BAD_REF = "nope.png";
const SAFE_REPLY =
  '{"sensitive":false,"category":null,"confidence":0.9,"reason":"clothed portrait"}';
const SENSITIVE_REPLY =
  '{"sensitive":true,"category":"nudity","confidence":0.85,"reason":"explicit nudity"}';

function okReply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function fakeMediaFor(ref: string): StoredMedia {
  return { ref, contentType: "image/png", bytes: Buffer.from("fake-bytes") };
}

/** In-memory stand-in for the disk media cache. */
function memoryMediaRepo(files: Record<string, StoredMedia | null>): MediaRepository {
  return {
    put: async () => {
      throw new Error("unused in moderation tests");
    },
    get: async (ref) => files[ref] ?? null,
    stat: async () => null,
    list: async () => [],
    delete: async () => {},
  };
}

let tempFiles: string[] = [];

function tempPath(name: string) {
  const p = path.join(
    os.tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tempFiles.push(p);
  return p;
}

beforeEach(() => {
  process.env.SOGNI_API_KEY = "test-key";
  setProviderConfigPathForTests(tempPath("provider-config"));
  setModerationPathForTests(tempPath("moderation"));
  setMediaRepositoryForTests(memoryMediaRepo({ [PNG_REF]: fakeMediaFor(PNG_REF) }));
  resetStudioEnvForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetModerationServiceForTests();
  setMediaRepositoryForTests(null);
  setModerationPathForTests(null);
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
  for (const p of tempFiles) fs.rmSync(p, { force: true });
  tempFiles = [];
  clearModerationRepository();
});

describe("classifyMediaRef", () => {
  it("classifies via the vision model and persists the verdict", async () => {
    const fetchMock = vi.fn(async () => okReply(SENSITIVE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const decision = await classifyMediaRef(PNG_REF);
    expect(decision.source).toBe("ai");
    expect(decision.verdict?.sensitive).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat classification from the cache without re-calling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply(SAFE_REPLY)));
    expect((await classifyMediaRef(PNG_REF)).source).toBe("ai");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("must not be called");
      }),
    );
    const again = await classifyMediaRef(PNG_REF);
    expect(again.source).toBe("cache");
    expect(again.verdict?.sensitive).toBe(false);
  });

  it("joins an in-flight classification instead of double-calling", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([classifyMediaRef(PNG_REF), classifyMediaRef(PNG_REF)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.verdict).toEqual(b.verdict);
  });

  it("falls back to static for bad refs, mp4s, and missing bytes", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    for (const ref of [BAD_REF, MP4_REF]) {
      const decision = await classifyMediaRef(ref);
      expect(decision).toEqual({ verdict: null, source: "static" });
    }
    setMediaRepositoryForTests(memoryMediaRepo({}));
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to static when the provider errors or the reply is junk", async () => {
    setMediaRepositoryForTests(
      memoryMediaRepo({
        [PNG_REF]: fakeMediaFor(PNG_REF),
        ["f".repeat(64) + ".png"]: fakeMediaFor("f".repeat(64) + ".png"),
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    vi.stubGlobal("fetch", vi.fn(async () => okReply("I cannot classify that.")));
    expect(await classifyMediaRef("f".repeat(64) + ".png")).toEqual({
      verdict: null,
      source: "static",
    });
  });

  it("does not re-call the endpoint for a ref whose classification just failed", async () => {
    const fetchMock = vi.fn(async () => new Response("gateway timeout", { status: 504 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // second ask rides the cooldown
  });

  it("opens the breaker after repeated endpoint failures and stops calling", async () => {
    const refs = [PNG_REF, "c".repeat(64) + ".png", "d".repeat(64) + ".png"];
    setMediaRepositoryForTests(
      memoryMediaRepo(Object.fromEntries(refs.map((ref) => [ref, fakeMediaFor(ref)]))),
    );
    const fetchMock = vi.fn(async () => new Response("origin timeout", { status: 524 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const ref of refs) {
      expect(await classifyMediaRef(ref)).toEqual({ verdict: null, source: "static" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Breaker is open: a fresh ref is answered instantly, without a call.
    expect(await classifyMediaRef("e".repeat(64) + ".png")).toEqual({
      verdict: null,
      source: "static",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("classifies an oversized original after resizing below the inline cap", async () => {
    // Gaussian-noise PNG: compresses poorly, so the raw bytes blow past 4MB
    // while the 1024px resize fits under it.
    const noisy = await sharp({
      create: {
        width: 2200,
        height: 1600,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
        noise: { type: "gaussian", mean: 128, sigma: 30 },
      },
    })
      .png()
      .toBuffer();
    expect(noisy.length).toBeGreaterThan(4 * 1024 * 1024);
    setMediaRepositoryForTests(
      memoryMediaRepo({ [PNG_REF]: { ref: PNG_REF, contentType: "image/png", bytes: noisy } }),
    );
    let sentUri = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse((init as RequestInit).body as string);
        sentUri = body.messages[1].content[1].image_url.url;
        return okReply(SAFE_REPLY);
      }),
    );
    const decision = await classifyMediaRef(PNG_REF);
    expect(decision.source).toBe("ai");
    expect(Buffer.from(sentUri.split(",")[1], "base64").length).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
  });

  it("falls back to static when Sogni is unconfigured or disabled", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    updateProviderConfig({ providers: { sogni: { enabled: false } } });
    resetStudioEnvForTests();
    process.env.SOGNI_API_KEY = "test-key";
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps verdicts below the confidence threshold but flags them uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okReply('{"sensitive":false,"category":null,"confidence":0.3,"reason":"unsure"}')),
    );
    const decision = await classifyMediaRef(PNG_REF);
    expect(decision.verdict?.uncertain).toBe(true);
    expect(decision.source).toBe("ai"); // persisted; policy (static fallback) is the caller's job
  });

  it("downscales oversized images to the 1024px endpoint cap", async () => {
    const big = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 120, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    setMediaRepositoryForTests(
      memoryMediaRepo({ [PNG_REF]: { ref: PNG_REF, contentType: "image/png", bytes: big } }),
    );
    let sentUri = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse((init as RequestInit).body as string);
        sentUri = body.messages[1].content[1].image_url.url;
        return okReply(SAFE_REPLY);
      }),
    );
    const decision = await classifyMediaRef(PNG_REF);
    expect(decision.source).toBe("ai");
    const match = sentUri.match(/^data:image\/png;base64,(.+)$/);
    expect(match).toBeTruthy();
    const meta = await sharp(Buffer.from(match![1], "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBeLessThanOrEqual(1024);
  });
});

describe("warmModeration", () => {
  it("warms a cache-ref URL and ignores provider URLs / junk", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    warmModeration(`/api/media?f=${PNG_REF}`);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    warmModeration("/api/media?u=https%3A%2F%2Fx");
    warmModeration(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

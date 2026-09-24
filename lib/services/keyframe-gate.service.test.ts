import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import type { MediaRepository, StoredMedia } from "@/lib/repositories/media.repository";
import { setMediaRepositoryForTests } from "@/lib/repositories/media.repository";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
} from "@/lib/repositories/provider-config.repository";
import {
  resetKeyframeGateForTests,
  scoreKeyframeRef,
} from "@/lib/services/keyframe-gate.service";

const PNG_REF = "a".repeat(64) + ".png";
const MP4_REF = "b".repeat(64) + ".mp4";
const BAD_REF = "nope.png";
const PASS_REPLY =
  '{"identity":0.9,"outfit":0.85,"location":0.95,"notes":"matches the brief"}';
const FAIL_REPLY =
  '{"identity":0.4,"outfit":0.3,"location":0.5,"notes":"wrong hair color"}';
const EXPECTATIONS = {
  identity: "Mara: red curly hair, freckles",
  outfit: "olive field jacket",
  location: "rain-soaked harbor",
};

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
      throw new Error("unused in keyframe gate tests");
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
  setMediaRepositoryForTests(memoryMediaRepo({ [PNG_REF]: fakeMediaFor(PNG_REF) }));
  resetStudioEnvForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetKeyframeGateForTests();
  setMediaRepositoryForTests(null);
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
  for (const p of tempFiles) fs.rmSync(p, { force: true });
  tempFiles = [];
});

describe("scoreKeyframeRef", () => {
  it("scores via the vision model and passes a matching keyframe", async () => {
    const fetchMock = vi.fn(async () => okReply(PASS_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const decision = await scoreKeyframeRef(PNG_REF, EXPECTATIONS);
    expect(decision.source).toBe("vision");
    expect(decision.verdict?.identity).toBe(0.9);
    expect(decision.verdict?.passed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat scoring from the cache without re-calling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply(PASS_REPLY)));
    expect((await scoreKeyframeRef(PNG_REF, EXPECTATIONS)).source).toBe("vision");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("must not be called");
      }),
    );
    const again = await scoreKeyframeRef(PNG_REF, EXPECTATIONS);
    expect(again.source).toBe("cache");
    expect(again.verdict?.passed).toBe(true);
  });

  it("treats different expectations as a different cache entry", async () => {
    const fetchMock = vi.fn(async () => okReply(PASS_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    await scoreKeyframeRef(PNG_REF, EXPECTATIONS);
    await scoreKeyframeRef(PNG_REF, { ...EXPECTATIONS, identity: "someone else entirely" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks a low-scoring keyframe failed but still returns a usable verdict", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply(FAIL_REPLY)));
    const decision = await scoreKeyframeRef(PNG_REF, EXPECTATIONS);
    expect(decision.source).toBe("vision");
    expect(decision.verdict?.passed).toBe(false);
    expect(decision.verdict?.identity).toBe(0.4);
  });

  it("is unavailable for bad refs, videos, and missing bytes", async () => {
    const fetchMock = vi.fn(async () => okReply(PASS_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    for (const ref of [BAD_REF, MP4_REF]) {
      expect(await scoreKeyframeRef(ref, EXPECTATIONS)).toEqual({
        verdict: null,
        source: "unavailable",
      });
    }
    setMediaRepositoryForTests(memoryMediaRepo({}));
    expect(await scoreKeyframeRef(PNG_REF, EXPECTATIONS)).toEqual({
      verdict: null,
      source: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable when Sogni is unconfigured or disabled", async () => {
    const fetchMock = vi.fn(async () => okReply(PASS_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    expect(await scoreKeyframeRef(PNG_REF, EXPECTATIONS)).toEqual({
      verdict: null,
      source: "unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects the cooldown when a reply is unparsable", async () => {
    const fetchMock = vi.fn(async () => okReply("I cannot score that image."));
    vi.stubGlobal("fetch", fetchMock);
    expect(await scoreKeyframeRef(PNG_REF, EXPECTATIONS)).toEqual({
      verdict: null,
      source: "unavailable",
    });
    expect(await scoreKeyframeRef(PNG_REF, EXPECTATIONS)).toEqual({
      verdict: null,
      source: "unavailable",
    });
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
      expect(await scoreKeyframeRef(ref, EXPECTATIONS)).toEqual({
        verdict: null,
        source: "unavailable",
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Breaker is open: a fresh ref is answered instantly, without a call.
    expect(await scoreKeyframeRef("e".repeat(64) + ".png", EXPECTATIONS)).toEqual({
      verdict: null,
      source: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

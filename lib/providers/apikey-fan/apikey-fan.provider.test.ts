import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedGenerationRequest } from "@/lib/domain/models";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { logger } from "@/lib/logging/logger";
import {
  apiKeyFanProvider,
  POLL_DEADLINE_MS,
} from "@/lib/providers/apikey-fan/apikey-fan.provider";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
]);
/** Structurally complete mp4 skeleton (ftyp + mdat + moov boxes). */
const MP4_BYTES = Buffer.concat([
  (() => {
    const box = Buffer.alloc(16, 0);
    box.writeUInt32BE(16, 0);
    box.write("ftyp", 4, "ascii");
    return box;
  })(),
  (() => {
    const box = Buffer.alloc(16, 0);
    box.writeUInt32BE(16, 0);
    box.write("mdat", 4, "ascii");
    return box;
  })(),
  (() => {
    const box = Buffer.alloc(16, 0);
    box.writeUInt32BE(16, 0);
    box.write("moov", 4, "ascii");
    return box;
  })(),
]);
/** What the relay serves while object storage still propagates the file. */
const MP4_STUB_BYTES = Buffer.alloc(64, 0);

function videoRequest(count: number): NormalizedGenerationRequest {
  return {
    kind: "video",
    prompt: "waves crashing",
    negativePrompt: "",
    aspect: "9:16",
    resolution: "1080p",
    durationSeconds: 5,
    count,
    seed: 42,
    safe: true,
    enhance: false,
  };
}

const videoModel = {
  id: "apikey-fan:grok-imagine-video-1.5",
  providerId: "apikey-fan",
  kind: "video" as const,
  model: "grok-imagine-video-1.5",
  label: "Grok Video 1.5",
};

beforeEach(() => {
  process.env.APIKEY_FAN_API_KEY = "sk-test-key";
  resetStudioEnvForTests();
});

afterEach(() => {
  delete process.env.APIKEY_FAN_API_KEY;
  resetStudioEnvForTests();
  vi.unstubAllGlobals();
});

describe("apikey-fan provider", () => {
  it("keeps the video poll deadline inside the route's 300s budget", () => {
    // Regression: the constant was 5_700_000 ms (95 min) while the comment
    // claimed ~6.5 min — a stuck job would hang far past maxDuration=300.
    expect(POLL_DEADLINE_MS).toBeLessThanOrEqual(240_000);
  });

  it("generates one video per requested variation (count honoured)", async () => {    const createCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          createCalls.push(url);
          return new Response(JSON.stringify({ request_id: `job_${createCalls.length}` }), {
            status: 200,
          });
        }
        if (url.includes("/videos/job_")) {
          return new Response(
            JSON.stringify({ status: "done", video: { url: "https://cdn.example/v.mp4" } }),
            { status: 200 },
          );
        }
        if (url === "https://cdn.example/v.mp4") {
          return new Response(new Uint8Array(MP4_BYTES), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const artifacts = await apiKeyFanProvider.generateVideo(
      videoRequest(2),
      videoModel,
      { logger },
    );

    expect(createCalls).toHaveLength(2);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]?.bytes?.subarray(4, 8).toString("ascii")).toBe("ftyp");
    // The provider polls every 3s; two sequential jobs take ~6-9s.
  }, 20_000);

  it("throws a clear error when the key is missing", async () => {
    delete process.env.APIKEY_FAN_API_KEY;
    resetStudioEnvForTests();
    await expect(
      apiKeyFanProvider.generateVideo(videoRequest(1), videoModel, { logger }),
    ).rejects.toMatchObject({ retryable: false, field: "model" });
  });

  it("resolves a relative content url and downloads it with the api key", async () => {
    const downloads: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          return new Response(JSON.stringify({ request_id: "job_rel" }), { status: 200 });
        }
        if (url.includes("/videos/job_rel")) {
          // Live relay behaviour: the content path is relative to the base url.
          return new Response(
            JSON.stringify({ status: "done", video: { url: "/v1/videos/abc/content" } }),
            { status: 200 },
          );
        }
        if (url === "https://apikey.fan/v1/videos/abc/content") {
          downloads.push({
            url,
            auth: (init?.headers as Record<string, string>)?.authorization,
          });
          return new Response(new Uint8Array(MP4_BYTES), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const artifacts = await apiKeyFanProvider.generateVideo(videoRequest(1), videoModel, {
      logger,
    });

    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.auth).toBe("Bearer sk-test-key");
    expect(artifacts[0]?.bytes?.equals(MP4_BYTES)).toBe(true);
  }, 20_000);

  it("re-fetches a placeholder download and fails loudly when it stays invalid", async () => {
    let contentFetches = 0;
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          return new Response(JSON.stringify({ request_id: "job_stub" }), { status: 200 });
        }
        if (url.includes("/videos/job_stub")) {
          return new Response(
            JSON.stringify({ status: "done", video: { url: "https://cdn.example/stub.mp4" } }),
            { status: 200 },
          );
        }
        if (url === "https://cdn.example/stub.mp4") {
          contentFetches += 1;
          return new Response(new Uint8Array(MP4_STUB_BYTES), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const pending = expect(
      apiKeyFanProvider.generateVideo(videoRequest(1), videoModel, { logger }),
    ).rejects.toMatchObject({ retryable: true });
    await vi.runAllTimersAsync();
    await pending;
    // Initial download + one propagation retry, then a hard failure — the
    // auth-gated url is never handed to the client as a degraded mode.
    expect(contentFetches).toBe(2);
    vi.useRealTimers();
  }, 20_000);
});

describe("continuity frame adaptive fallback", () => {
  const FRAME = { bytes: Buffer.from("frame"), contentType: "image/png" };

  const imageModel = {
    id: "apikey-fan:grok-imagine-image-2.0",
    providerId: "apikey-fan",
    kind: "image" as const,
    model: "grok-imagine-image-2.0",
    label: "Grok Imagine 2.0",
  };

  function imageReq(): NormalizedGenerationRequest {
    return {
      kind: "image",
      prompt: "a fox",
      negativePrompt: "",
      aspect: "16:9",
      resolution: "1080p",
      durationSeconds: 0,
      count: 1,
      seed: 42,
      safe: true,
      enhance: false,
    };
  }

  function frameVideoRequest(): NormalizedGenerationRequest {
    return { ...videoRequest(1), startImage: FRAME };
  }

  it("retries prompt-only when the relay rejects the video image field", async () => {
    const createBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          createBodies.push(body);
          // First call (with the image) is rejected as malformed.
          if (createBodies.length === 1) return new Response("bad request", { status: 400 });
          return new Response(JSON.stringify({ request_id: "job_fb" }), { status: 200 });
        }
        if (url.includes("/videos/job_fb")) {
          return new Response(
            JSON.stringify({ status: "done", video: { url: "https://cdn.example/v.mp4" } }),
            { status: 200 },
          );
        }
        if (url === "https://cdn.example/v.mp4") {
          return new Response(new Uint8Array(MP4_BYTES), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const artifacts = await apiKeyFanProvider.generateVideo(frameVideoRequest(), videoModel, {
      logger,
    });

    expect(createBodies).toHaveLength(2);
    expect(createBodies[0]?.image).toBeDefined();
    expect(createBodies[1]?.image).toBeUndefined();
    expect(artifacts[0]?.frameDropped).toBe(true);
  }, 20_000);

  it("keeps frameDropped unset when the image field is accepted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/videos/generations")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          expect(body.image).toEqual({
            url: `data:image/png;base64,${FRAME.bytes.toString("base64")}`,
          });
          return new Response(JSON.stringify({ request_id: "job_ok" }), { status: 200 });
        }
        if (url.includes("/videos/job_ok")) {
          return new Response(
            JSON.stringify({ status: "done", video: { url: "https://cdn.example/v.mp4" } }),
            { status: 200 },
          );
        }
        if (url === "https://cdn.example/v.mp4") {
          return new Response(new Uint8Array(MP4_BYTES), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const artifacts = await apiKeyFanProvider.generateVideo(frameVideoRequest(), videoModel, {
      logger,
    });
    expect(artifacts[0]?.frameDropped).toBeUndefined();
  }, 20_000);

  it("falls back to plain generations when edits rejects the frame", async () => {
    const imageCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/images/edits")) {
          imageCalls.push(url);
          return new Response("bad request", { status: 400 });
        }
        if (url.endsWith("/images/generations")) {
          imageCalls.push(url);
          return new Response(
            JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const artifacts = await apiKeyFanProvider.generateImage(
      { ...imageReq(), startImage: FRAME },
      imageModel,
      { logger },
    );

    expect(imageCalls).toEqual([
      expect.stringContaining("/images/edits"),
      expect.stringContaining("/images/generations"),
    ]);
    expect(artifacts[0]?.frameDropped).toBe(true);
  });
});

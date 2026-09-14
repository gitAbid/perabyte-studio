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
const MP4_BYTES = Buffer.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
]);

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
});

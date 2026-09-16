import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenerationError,
  requestGeneration,
  storyProgressPercent,
  type GenerationProgress,
} from "@/lib/generation";
import type { GenerationSettings } from "@/lib/types";

const settings: GenerationSettings = {
  kind: "image",
  aspect: "16:9",
  resolution: "1080p",
  style: "Realistic",
  duration: "5s",
  count: 1,
  seed: "",
  negativePrompt: "",
  enhance: true,
  safe: true,
  modelId: "sogni:krea2_turbo_fp8_scaled",
};

const RESULT = {
  requestId: "req_1",
  status: "completed",
  kind: "image",
  elapsedMs: 10,
  media: [{ id: "m_1", url: "/api/media?f=x", width: 1280, height: 720, seed: 1, mime: "image/png" }],
};

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestGeneration progress stream", () => {
  it("advertises NDJSON support and consumes progress lines before the result", async () => {
    const ticks: GenerationProgress[] = [];
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        { type: "progress", stage: "submitted", message: "accepted" },
        { type: "progress", stage: "rendering", message: "rendering 55%", percent: 55.4 },
        { type: "progress", stage: "downloading", message: "Finalising your render…" },
        { type: "result", ...RESULT },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestGeneration({
      settings,
      prompt: "x",
      onProgress: (progress) => ticks.push(progress),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/generate",
      expect.objectContaining({
        headers: expect.objectContaining({ accept: "application/x-ndjson, application/json" }),
      }),
    );
    expect(ticks.map((tick) => tick.percent)).toEqual([undefined, 55, undefined]);
    expect(ticks[1].message).toBe("rendering 55%");
    expect(response.requestId).toBe("req_1");
  });

  it("sends LoRA selections in the request body when set", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([{ type: "result", ...RESULT }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const loras = [
      { loraId: "mystic-x", strength: 80 },
      { loraId: "filter-bypass-2", strength: 55 },
    ];
    await requestGeneration({
      settings: { ...settings, loras },
      prompt: "x",
    });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.loras).toEqual(loras);
  });

  it("omits the loras field when no adapters are selected", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([{ type: "result", ...RESULT }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestGeneration({ settings, prompt: "x" });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.loras).toBeUndefined();
  });

  it("throws a retryable GenerationError on an error line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse([
          { type: "progress", stage: "rendering", message: "rendering 10%", percent: 10 },
          {
            type: "error",
            error: "Sogni AI could not finish this render",
            retryable: true,
          },
        ]),
      ),
    );

    const error = await requestGeneration({ settings, prompt: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).message).toContain("could not finish");
    expect((error as GenerationError).retryable).toBe(true);
  });

  it("fails when the stream ends without a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse([{ type: "progress", stage: "rendering", message: "…", percent: 1 }]),
      ),
    );

    const error = await requestGeneration({ settings, prompt: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).message).toContain("ended before the render finished");
  });

  it("handles plain JSON replies as before", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(RESULT), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    const response = await requestGeneration({ settings, prompt: "x", onProgress });

    expect(response.requestId).toBe("req_1");
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("ignores garbage lines and reassembles lines split across chunks", async () => {
    const encoder = new TextEncoder();
    const resultLine = JSON.stringify({ type: "result", ...RESULT });
    const half = Math.floor(resultLine.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"progress","message":"ok"\n')); // invalid JSON — ignored
        controller.enqueue(encoder.encode('not json at all\n')); // ignored
        controller.enqueue(encoder.encode(resultLine.slice(0, half))); // partial line, no newline yet
        controller.enqueue(encoder.encode(`${resultLine.slice(half)}\n`)); // completes it
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(stream, { headers: { "content-type": "application/x-ndjson" } }),
      ),
    );

    const response = await requestGeneration({ settings, prompt: "x" });
    expect(response.requestId).toBe("req_1");
  });
});

describe("storyProgressPercent", () => {
  it("stays indeterminate before anything is measurable", () => {
    expect(storyProgressPercent(0, 0)).toBeUndefined();
    expect(storyProgressPercent(0, 4)).toBeUndefined();
    expect(storyProgressPercent(0, 4, { stage: "rendering", message: "x" })).toBeUndefined();
  });

  it("counts finished scenes and folds in the live scene's percent", () => {
    expect(storyProgressPercent(2, 4)).toBe(50);
    expect(storyProgressPercent(2, 4, { stage: "rendering", message: "x", percent: 40 })).toBe(60);
    expect(storyProgressPercent(0, 1, { stage: "rendering", message: "x", percent: 55.4 })).toBe(55);
  });

  it("caps at 100 and ignores out-of-range input", () => {
    expect(storyProgressPercent(4, 4)).toBe(100);
    expect(storyProgressPercent(3, 4, { stage: "rendering", message: "x", percent: 200 })).toBe(100);
    expect(storyProgressPercent(-1, 4)).toBe(0);
  });
});

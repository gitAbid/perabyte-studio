import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenerationError,
  requestGeneration,
  setJobPollIntervalForTests,
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

const MEDIA = [
  { id: "m_1", url: "/api/media?f=x", width: 1280, height: 720, seed: 1, mime: "image/png" },
];

/** Job-backed client: first fetch = POST /api/jobs, then GET /api/jobs/:id
 * once per poll tick until the record is terminal. */
function jobFetchMock(
  records: Record<string, unknown>[],
  opts: { statusResponse?: unknown; initialError?: Response } = {},
) {
  let polls = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/jobs") {
      if (opts.initialError) return opts.initialError;
      return new Response(JSON.stringify({ job: { id: "job_1" } }), { status: 202 });
    }
    if (url.startsWith("/api/jobs/job_1")) {
      const record = records[polls] ?? records[records.length - 1];
      polls += 1;
      return new Response(JSON.stringify({ job: record }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchMock, pollsRef: () => polls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setJobPollIntervalForTests(2_000);
});

describe("requestGeneration (durable jobs)", () => {
  it("submits to /api/jobs and polls to completion", async () => {
    const ticks: GenerationProgress[] = [];
    const { fetchMock } = jobFetchMock([
      {
        id: "job_1",
        kind: "image",
        status: "running",
        progress: { stage: "rendering", message: "rendering 55%", percent: 55.4 },
      },
      {
        id: "job_1",
        kind: "image",
        status: "completed",
        createdAt: 1_000,
        finishedAt: 11_000,
        assetId: "a_job_1",
        result: MEDIA,
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestGeneration({
      settings,
      prompt: "x",
      onProgress: (progress) => ticks.push(progress),
    });

    // The submit body carries the full generation request (the LoRA lesson:
    // assert the serialized body, not client state).
    const submitCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/jobs",
    ) as unknown as [string, { body: string; method: string }];
    expect(submitCall[1].method).toBe("POST");
    const body = JSON.parse(submitCall[1].body);
    expect(body).toMatchObject({
      kind: "image",
      prompt: "x",
      aspect: "16:9",
      modelId: "sogni:krea2_turbo_fp8_scaled",
      enhance: true,
      safe: true,
    });

    expect(ticks.map((t) => t.message)).toEqual(["rendering 55%"]);
    expect(ticks[0].percent).toBe(55);
    expect(response.requestId).toBe("job_1");
    expect(response.media).toEqual(MEDIA);
    expect(response.assetId).toBe("a_job_1");
  });

  it("sends LoRA selections in the submit body when set", async () => {
    const { fetchMock } = jobFetchMock([
      { id: "job_1", kind: "image", status: "completed", createdAt: 1, finishedAt: 2, result: MEDIA },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const loras = [
      { loraId: "mystic-x", strength: 80 },
      { loraId: "filter-bypass-2", strength: 55 },
    ];
    await requestGeneration({ settings: { ...settings, loras }, prompt: "x" });

    const submitCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/jobs",
    ) as unknown as [string, { body: string }];
    const body = JSON.parse(submitCall[1].body);
    expect(body.loras).toEqual(loras);
  });

  it("omits the loras field when no adapters are selected", async () => {
    const { fetchMock } = jobFetchMock([
      { id: "job_1", kind: "image", status: "completed", createdAt: 1, finishedAt: 2, result: MEDIA },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await requestGeneration({ settings, prompt: "x" });

    const submitCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/jobs",
    ) as unknown as [string, { body: string }];
    expect(JSON.parse(submitCall[1].body).loras).toBeUndefined();
  });

  it("surfaces validation failures from the submit endpoint", async () => {
    const { fetchMock } = jobFetchMock([], {
      initialError: new Response(
        JSON.stringify({
          error: "Describe what you want to create before generating.",
          field: "prompt",
          retryable: false,
        }),
        { status: 400 },
      ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestGeneration({ settings, prompt: "" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).retryable).toBe(false);
    expect((error as GenerationError).message).toContain("Describe what");
  });

  it("maps a failed job to a retryable GenerationError", async () => {
    const { fetchMock } = jobFetchMock([
      {
        id: "job_1",
        kind: "image",
        status: "failed",
        error: "Sogni AI could not finish this render",
        retryable: true,
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestGeneration({ settings, prompt: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationError);
    expect((error as GenerationError).retryable).toBe(true);
    expect((error as GenerationError).message).toContain("could not finish");
  });

  it("maps a canceled job to an AbortError", async () => {
    const { fetchMock } = jobFetchMock([
      { id: "job_1", kind: "image", status: "canceled", createdAt: 1 },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const error = await requestGeneration({ settings, prompt: "x" }).catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
  });

  it("keeps polling through transient poll errors", async () => {
    setJobPollIntervalForTests(1);
    let polls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/jobs") {
        return new Response(JSON.stringify({ job: { id: "job_1" } }), { status: 202 });
      }
      polls += 1;
      if (polls <= 2) throw new Error("network blip");
      return new Response(
        JSON.stringify({
          job: {
            id: "job_1",
            kind: "image",
            status: "completed",
            createdAt: 1,
            finishedAt: 2,
            result: MEDIA,
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestGeneration({ settings, prompt: "x" });
    expect(response.media).toEqual(MEDIA);
    expect(polls).toBe(3);
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

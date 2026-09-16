import { describe, expect, it, vi } from "vitest";
import { createGoogleFormat } from "./google";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import { logger } from "@/lib/logging/logger";

const entry: CustomProviderEntry = {
  id: "gcp",
  label: "Google AI",
  format: "google",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "AIza-test",
  enabled: true,
  models: [],
};

const ctx = { logger };

const imageModel: ModelDescriptor = {
  id: "gcp:gemini-2.5-flash-image",
  providerId: "gcp",
  kind: "image",
  model: "gemini-2.5-flash-image",
  label: "Gemini Image",
};

const videoModel: ModelDescriptor = {
  id: "gcp:veo-3.1-generate-preview",
  providerId: "gcp",
  kind: "video",
  model: "veo-3.1-generate-preview",
  label: "Veo 3.1",
};

function imageRequest(overrides: Partial<NormalizedGenerationRequest> = {}): NormalizedGenerationRequest {
  return {
    kind: "image",
    prompt: "a mountain lake",
    negativePrompt: "",
    aspect: "16:9",
    resolution: "1080p",
    durationSeconds: 0,
    count: 1,
    seed: 7,
    safe: true,
    enhance: false,
    ...overrides,
  };
}

function mp4Bytes(): Buffer {
  const head = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  return Buffer.concat([head, Buffer.alloc(32), Buffer.from("00moov000000000000000000", "latin1")]);
}

interface Route {
  method: "GET" | "POST";
  path: string;
  status?: number;
  body?: unknown;
  bytes?: Buffer;
}

function fakeFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const pathname = new URL(url).pathname;
    const method = (init?.method as "GET" | "POST") ?? "GET";
    const route = routes.find((r) => r.method === method && r.path === pathname);
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    if (route.bytes) return new Response(new Uint8Array(route.bytes), { status: 200 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl, calls };
}

describe("google format — models", () => {
  it("filters to generation-capable models and classifies from metadata", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1beta/models",
        body: {
          models: [
            {
              name: "models/gemini-2.5-flash",
              displayName: "Gemini 2.5 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/veo-3.1-generate-preview",
              displayName: "Veo 3.1",
              supportedGenerationMethods: ["predictLongRunning"],
            },
            {
              name: "models/gemini-2.5-flash-image",
              displayName: "Nano Banana",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/text-embedding-004",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        },
      },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    const models = await format.listModels(entry);
    expect(models).toEqual([
      { model: "gemini-2.5-flash", label: "Gemini 2.5 Flash", kind: "text" },
      { model: "veo-3.1-generate-preview", label: "Veo 3.1", kind: "video" },
      { model: "gemini-2.5-flash-image", label: "Nano Banana", kind: "image" },
    ]);
    expect(calls[0].init?.headers).toMatchObject({ "x-goog-api-key": "AIza-test" });
  });
});

describe("google format — text", () => {
  it("completes via :generateContent with systemInstruction", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1beta/models/gemini-2.5-flash:generateContent",
        body: {
          candidates: [
            { content: { parts: [{ text: "hello " }, { text: "world" }] } },
          ],
        },
      },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.generateText!(entry, {
      userPrompt: "say hi",
      systemPrompt: "be brief",
      modelId: "gcp:gemini-2.5-flash",
    });
    expect(result.text).toBe("hello world");
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    expect(sent.contents[0].parts[0].text).toBe("say hi");
  });
});

describe("google format — images", () => {
  it("generates images from inlineData parts", async () => {
    const b64 = Buffer.from("png-bytes").toString("base64");
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1beta/models/gemini-2.5-flash-image:generateContent",
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: b64 } }],
              },
            },
          ],
        },
      },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    const artifacts = await format.generateImage!(entry, imageRequest(), imageModel, ctx);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].bytes?.toString()).toBe("png-bytes");
    expect(artifacts[0].ext).toBe("png");
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
  });

  it("sends start frames as inlineData input parts", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1beta/models/gemini-2.5-flash-image:generateContent",
        body: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/png", data: "eA==" } }] } },
          ],
        },
      },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    await format.generateImage!(
      entry,
      imageRequest({ startImage: { bytes: Buffer.from("frame"), contentType: "image/png" } }),
      imageModel,
      ctx,
    );
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.contents[0].parts).toHaveLength(2);
    expect(sent.contents[0].parts[1]).toMatchObject({ inlineData: { mimeType: "image/png" } });
  });
});

describe("google format — video (Veo)", () => {
  it("submits a predictLongRunning operation per variation", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "POST", path: "/v1beta/models/veo-3.1-generate-preview:predictLongRunning", body: { name: "operations/abc" } },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    const { ref } = await format.videoJobs!(entry).submit(
      imageRequest({ kind: "video", count: 2, durationSeconds: 8, aspect: "16:9" }),
      videoModel,
      ctx,
    );
    expect(ref).toBe("operations/abc,operations/abc");
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.parameters).toEqual({ aspectRatio: "16:9" });
    expect(sent.instances[0].prompt).toBe("a mountain lake");
  });

  it("sends start frames inside the instance", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "POST", path: "/v1beta/models/veo-3.1-generate-preview:predictLongRunning", body: { name: "operations/abc" } },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    await format.videoJobs!(entry).submit(
      imageRequest({
        kind: "video",
        startImage: { bytes: Buffer.from("frame"), contentType: "image/png" },
      }),
      videoModel,
      ctx,
    );
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.instances[0].image).toMatchObject({ mimeType: "image/png" });
  });

  it("polls operations until done and downloads the mp4", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "GET", path: "/v1beta/operations/abc", body: { done: false } },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    const running = await format.videoJobs!(entry).poll(
      "operations/abc",
      imageRequest({ kind: "video" }),
      videoModel,
      ctx,
    );
    expect(running.status).toBe("running");

    const { fetchImpl: doneFetch, calls: doneCalls } = fakeFetch([
      {
        method: "GET",
        path: "/v1beta/operations/abc",
        body: {
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: "https://storage.googleapis.com/v/abc.mp4" } }],
            },
          },
        },
      },
      { method: "GET", path: "/v/abc.mp4", bytes: mp4Bytes() },
    ]);
    const done = await createGoogleFormat(doneFetch as unknown as typeof fetch).videoJobs!(entry).poll(
      "operations/abc",
      imageRequest({ kind: "video" }),
      videoModel,
      ctx,
    );
    expect(done.status).toBe("completed");
    if (done.status === "completed") expect(done.artifacts[0].ext).toBe("mp4");
    expect(doneCalls[1].init?.headers).toMatchObject({ "x-goog-api-key": "AIza-test" });
  });

  it("reports operation errors as failed", async () => {
    const { fetchImpl } = fakeFetch([
      {
        method: "GET",
        path: "/v1beta/operations/abc",
        body: { done: true, error: { message: "safety block" } },
      },
    ]);
    const format = createGoogleFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.videoJobs!(entry).poll(
      "operations/abc",
      imageRequest({ kind: "video" }),
      videoModel,
      ctx,
    );
    expect(result).toMatchObject({ status: "failed", retryable: false });
  });
});

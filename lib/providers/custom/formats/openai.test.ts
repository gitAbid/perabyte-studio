import { describe, expect, it, vi } from "vitest";
import { createOpenAiFormat, resolveOpenAiBase } from "./openai";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import { logger } from "@/lib/logging/logger";
import { ProviderError } from "@/lib/providers/types";

const entry: CustomProviderEntry = {
  id: "relay",
  label: "My Relay",
  format: "openai",
  baseUrl: "https://relay.example/v1",
  apiKey: "sk-x",
  enabled: true,
  models: [],
};

const ctx = { logger };

const imageModel: ModelDescriptor = {
  id: "relay:grok-imagine-image",
  providerId: "relay",
  kind: "image",
  model: "grok-imagine-image",
  label: "Grok Imagine Image",
};

const videoModel: ModelDescriptor = {
  id: "relay:grok-imagine-video",
  providerId: "relay",
  kind: "video",
  model: "grok-imagine-video",
  label: "Grok Imagine Video",
};

function imageRequest(overrides: Partial<NormalizedGenerationRequest> = {}): NormalizedGenerationRequest {
  return {
    kind: "image",
    prompt: "a red apple",
    negativePrompt: "",
    aspect: "16:9",
    resolution: "1080p",
    durationSeconds: 0,
    count: 1,
    seed: 42,
    safe: true,
    enhance: false,
    ...overrides,
  };
}

function mp4Bytes(): Buffer {
  const head = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, // size + "ftyp"
    0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const tail = Buffer.from("00moov0000000000000000000000000000", "latin1");
  return Buffer.concat([head, Buffer.alloc(32), tail]);
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
    if (route.bytes) {
      return new Response(new Uint8Array(route.bytes), { status: 200 });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl, calls };
}

describe("resolveOpenAiBase", () => {
  it("keeps an existing /v1 and appends when missing", () => {
    expect(resolveOpenAiBase("https://relay.example/v1")).toBe("https://relay.example/v1");
    expect(resolveOpenAiBase("https://relay.example")).toBe("https://relay.example/v1");
    expect(resolveOpenAiBase("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(resolveOpenAiBase("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
  });
});

describe("openai format — models and text", () => {
  it("lists models with kind guesses", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1/models",
        body: { data: [{ id: "gpt-image-1" }, { id: "sora-2" }, { id: "grok-4.5" }] },
      },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const models = await format.listModels(entry);
    expect(models).toEqual([
      { model: "gpt-image-1", kind: "image" },
      { model: "sora-2", kind: "video" },
      { model: "grok-4.5", kind: "text" },
    ]);
    expect(calls[0].url).toBe("https://relay.example/v1/models");
  });

  it("appends /v1 for bases without a version segment", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "GET", path: "/v1/models", body: { data: [] } },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    await format.listModels({ ...entry, baseUrl: "http://localhost:11434" });
    expect(calls[0].url).toBe("http://localhost:11434/v1/models");
  });

  it("completes text via chat/completions", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: { choices: [{ message: { content: "  a shiny apple  " } }] },
      },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.generateText!(entry, {
      userPrompt: "make this better",
      systemPrompt: "you rewrite prompts",
      modelId: "grok-4.5",
    });
    expect(result).toEqual({ text: "a shiny apple", model: "grok-4.5", provider: "relay" });
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent.messages).toEqual([
      { role: "system", content: "you rewrite prompts" },
      { role: "user", content: "make this better" },
    ]);
  });

  it("strips a provider prefix from text model ids", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: { choices: [{ message: { content: "ok" } }] },
      },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    await format.generateText!(entry, { userPrompt: "hi", modelId: "relay:grok-4.5" });
    expect(JSON.parse(calls[0].init!.body as string).model).toBe("grok-4.5");
  });
});

describe("openai format — images", () => {
  it("generates images with size mapping and b64 artifacts", async () => {
    const b64 = Buffer.from("png-bytes").toString("base64");
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1/images/generations",
        body: { data: [{ b64_json: b64, revised_prompt: "better" }] },
      },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const artifacts = await format.generateImage!(entry, imageRequest(), imageModel, ctx);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].bytes?.toString()).toBe("png-bytes");
    expect(artifacts[0].ext).toBe("png");
    expect(artifacts[0].revisedPrompt).toBe("better");
    expect(artifacts[0].seed).toBe(42);
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent).toMatchObject({ model: "grok-imagine-image", prompt: "a red apple", n: 1, size: "1280x720" });
  });

  it("folds the negative prompt into the image request", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "POST", path: "/v1/images/generations", body: { data: [{ b64_json: "eA==" }] } },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    await format.generateImage!(
      entry,
      imageRequest({ negativePrompt: "blurry" }),
      imageModel,
      ctx,
    );
    expect(JSON.parse(calls[0].init!.body as string).prompt).toBe("a red apple. Avoid: blurry.");
  });

  it("sends start frames to /images/edits and degrades on 400", async () => {
    const startImage = {
      bytes: Buffer.from("frame"),
      contentType: "image/png",
    };
    const { fetchImpl, calls } = fakeFetch([
      { method: "POST", path: "/v1/images/edits", status: 400, body: { error: "no" } },
      {
        method: "POST",
        path: "/v1/images/generations",
        body: { data: [{ b64_json: Buffer.from("ok").toString("base64") }] },
      },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const artifacts = await format.generateImage!(
      entry,
      imageRequest({ startImage }),
      imageModel,
      ctx,
    );
    expect(artifacts[0].frameDropped).toBe(true);
    expect(calls[0].url).toContain("/images/edits");
    expect(JSON.parse(calls[0].init!.body as string).image.url).toContain("data:image/png;base64,");
    expect(calls[1].url).toContain("/images/generations");
  });

  it("retries without size when the payload is rejected", async () => {
    let attempt = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const sent = JSON.parse(init!.body as string);
      if (new URL(url).pathname === "/v1/images/generations") {
        attempt += 1;
        if ("size" in sent) return new Response(JSON.stringify({ error: "bad size" }), { status: 400 });
        return new Response(
          JSON.stringify({ data: [{ b64_json: Buffer.from("ok").toString("base64") }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const artifacts = await format.generateImage!(entry, imageRequest(), imageModel, ctx);
    expect(artifacts).toHaveLength(1);
    expect(attempt).toBe(2);
  });
});

describe("openai format — video", () => {
  it("submits one relay job per variation", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "POST", path: "/v1/videos/generations", body: { request_id: "req-1" } },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const { ref } = await format.videoJobs!(entry).submit(
      imageRequest({ kind: "video", count: 2, durationSeconds: 5 }),
      videoModel,
      ctx,
    );
    expect(ref).toBe("req-1,req-1");
    expect(calls).toHaveLength(2);
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent).toMatchObject({ model: "grok-imagine-video", duration: 5 });
  });

  it("falls back to the Sora shape on 404 and flags dropped frames", async () => {
    const startImage = { bytes: Buffer.from("frame"), contentType: "image/png" };
    const { fetchImpl, calls } = fakeFetch([
      { method: "POST", path: "/v1/videos/generations", status: 404, body: {} },
      { method: "POST", path: "/v1/videos", body: { id: "sora-9" } },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const { ref } = await format.videoJobs!(entry).submit(
      imageRequest({ kind: "video", startImage }),
      videoModel,
      ctx,
    );
    expect(ref).toBe("sora-9~f");
    expect(calls[1].url).toContain("/v1/videos");
    const sent = JSON.parse(calls[1].init!.body as string);
    expect(sent.seconds).toBe("5");
  });

  it("polls relay-shaped jobs and downloads the mp4", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1/videos/req-1",
        body: { status: "done", video: { url: "/v1/videos/req-1/content" } },
      },
      { method: "GET", path: "/v1/videos/req-1/content", bytes: mp4Bytes() },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.videoJobs!(entry).poll("req-1", imageRequest({ kind: "video" }), videoModel, ctx);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.artifacts[0].ext).toBe("mp4");
      expect(result.artifacts[0].bytes).toBeInstanceOf(Buffer);
    }
    expect(calls[1].url).toBe("https://relay.example/v1/videos/req-1/content");
  });

  it("polls Sora-shaped jobs via the content endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { method: "GET", path: "/v1/videos/sora-9", body: { status: "completed" } },
      { method: "GET", path: "/v1/videos/sora-9/content", bytes: mp4Bytes() },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.videoJobs!(entry).poll("sora-9", imageRequest({ kind: "video" }), videoModel, ctx);
    expect(result.status).toBe("completed");
    expect(calls[1].url).toBe("https://relay.example/v1/videos/sora-9/content");
  });

  it("keeps running on intermediate states", async () => {
    const { fetchImpl } = fakeFetch([
      { method: "GET", path: "/v1/videos/req-1", body: { status: "processing" } },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.videoJobs!(entry).poll("req-1", imageRequest({ kind: "video" }), videoModel, ctx);
    expect(result).toMatchObject({ status: "running" });
  });

  it("reports failed jobs", async () => {
    const { fetchImpl } = fakeFetch([
      { method: "GET", path: "/v1/videos/req-1", body: { status: "failed" } },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.videoJobs!(entry).poll("req-1", imageRequest({ kind: "video" }), videoModel, ctx);
    expect(result).toMatchObject({ status: "failed", retryable: false });
  });

  it("marks artifacts whose start frame was dropped", async () => {
    const { fetchImpl } = fakeFetch([
      {
        method: "GET",
        path: "/v1/videos/sora-9",
        body: { status: "done", video: { url: "https://relay.example/v1/videos/sora-9/content" } },
      },
      { method: "GET", path: "/v1/videos/sora-9/content", bytes: mp4Bytes() },
    ]);
    const format = createOpenAiFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.videoJobs!(entry).poll(
      "sora-9~f",
      imageRequest({ kind: "video" }),
      videoModel,
      ctx,
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.artifacts[0].frameDropped).toBe(true);
    }
  });
});

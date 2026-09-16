import { describe, expect, it, vi } from "vitest";
import { createAnthropicFormat } from "./anthropic";
import type { CustomProviderEntry } from "@/lib/repositories/provider-config.repository";

const entry: CustomProviderEntry = {
  id: "claude",
  label: "Claude Direct",
  format: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-test",
  enabled: true,
  models: [],
};

interface Route {
  method: "GET" | "POST";
  path: string;
  status?: number;
  body?: unknown;
}

function fakeFetch(routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const pathname = new URL(url).pathname;
    const method = (init?.method as "GET" | "POST") ?? "GET";
    const route = routes.find((r) => r.method === method && r.path === pathname);
    if (!route) return new Response(JSON.stringify({}), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl, calls };
}

describe("anthropic format", () => {
  it("is text-only", () => {
    const format = createAnthropicFormat();
    expect(format.capabilities).toEqual({ image: false, video: false, text: true });
    expect(format.generateImage).toBeUndefined();
    expect(format.videoJobs).toBeUndefined();
  });

  it("lists models as text with display names", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "GET",
        path: "/v1/models",
        body: {
          data: [
            { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" },
            { id: "claude-haiku-4" },
          ],
        },
      },
    ]);
    const format = createAnthropicFormat(fetchImpl as unknown as typeof fetch);
    const models = await format.listModels(entry);
    expect(models).toEqual([
      { model: "claude-sonnet-4", label: "Claude Sonnet 4", kind: "text" },
      { model: "claude-haiku-4", kind: "text" },
    ]);
    expect(calls[0].init?.headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });
  });

  it("completes via /v1/messages", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          content: [
            { type: "text", text: "better prompt" },
            { type: "other", text: "ignored" },
          ],
        },
      },
    ]);
    const format = createAnthropicFormat(fetchImpl as unknown as typeof fetch);
    const result = await format.generateText!(entry, {
      userPrompt: "improve this",
      systemPrompt: "you rewrite prompts",
      modelId: "claude:claude-sonnet-4",
      maxTokens: 512,
    });
    expect(result).toEqual({
      text: "better prompt",
      model: "claude-sonnet-4",
      provider: "claude",
    });
    const sent = JSON.parse(calls[0].init!.body as string);
    expect(sent).toMatchObject({
      model: "claude-sonnet-4",
      max_tokens: 512,
      system: "you rewrite prompts",
      messages: [{ role: "user", content: "improve this" }],
    });
  });
});

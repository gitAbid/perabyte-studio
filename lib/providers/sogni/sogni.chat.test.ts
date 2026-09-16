import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { MODERATION_SYSTEM_PROMPT } from "@/lib/domain/moderation";
import { sogniChat } from "@/lib/providers/sogni/sogni.chat";
import { sogniTextComplete, DEFAULT_SOGNI_TEXT_MODEL } from "@/lib/providers/sogni/sogni.text";
import { sogniVisionComplete, SOGNI_VISION_MODEL } from "@/lib/providers/sogni/sogni.vision";
import { ProviderError } from "@/lib/providers/types";

function okReply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
}

beforeEach(() => {
  process.env.SOGNI_API_KEY = "test-key";
  resetStudioEnvForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
});

describe("sogniChat (text path via sogniTextComplete)", () => {
  it("sends the OpenAI-style body and returns the reply", async () => {
    const fetchMock = vi.fn(async () => okReply("a better prompt"));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await sogniTextComplete("make this better");
    expect(reply).toBe("a better prompt");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_SOGNI_TEXT_MODEL);
    expect(body.messages[1].content).toBe("make this better");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-key" });
  });
});

describe("sogniVisionComplete", () => {
  it("sends the rubric + image as a base64 data-URI part", async () => {
    const fetchMock = vi.fn(async () =>
      okReply('{"sensitive":false,"category":null,"confidence":0.9,"reason":"clothed"}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reply = await sogniVisionComplete(
      "Classify this image for an 18+ content gate. Reply with JSON only.",
      { bytes: Buffer.from("fake-png"), contentType: "image/png" },
    );
    expect(reply).toContain("sensitive");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(SOGNI_VISION_MODEL);
    expect(body.messages[0].content).toBe(MODERATION_SYSTEM_PROMPT);
    const parts = body.messages[1].content;
    expect(parts[0]).toEqual({ type: "text", text: expect.any(String) });
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("maps HTTP failures to retryable ProviderErrors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await expect(
      sogniVisionComplete("classify", { bytes: Buffer.from("x"), contentType: "image/png" }),
    ).rejects.toMatchObject({ name: "ProviderError", retryable: true });
  });

  it("reports unconfigured Sogni as non-retryable", async () => {
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    await expect(sogniChat(SOGNI_VISION_MODEL, "hi")).rejects.toBeInstanceOf(ProviderError);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import {
  runWriterAction,
  WriterServiceError,
} from "@/lib/services/writer.service";

let tempConfigFile: string | null = null;

/** Point the Sogni engine at a fake key so it leads the default chain. */
function enableSogni() {
  process.env.SOGNI_API_KEY = "test-key";
  resetStudioEnvForTests();
}

beforeEach(() => {
  tempConfigFile = path.join(
    os.tmpdir(),
    `writer-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  setProviderConfigPathForTests(tempConfigFile);
  enableSogni();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProviderConfigForTests();
  if (tempConfigFile) {
    fs.rmSync(tempConfigFile, { force: true });
    tempConfigFile = null;
  }
  setProviderConfigPathForTests(null);
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
});

/** Sogni-shaped fetch stub (OpenAI chat JSON); reply text rotates per call. */
function stubReplies(replies: string[]) {
  let call = 0;
  const fetchMock = vi.fn((..._args: unknown[]) => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
        status: 200,
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Pollinations-shaped stub: its GET returns plain text, not chat JSON. */
function stubTextReplies(replies: string[]) {
  let call = 0;
  const fetchMock = vi.fn((..._args: unknown[]) => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return Promise.resolve(new Response(reply, { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SPLIT_JSON = JSON.stringify({ title: "The Chase", scenes: ["s1", "s2", "s3"] });

describe("writer service", () => {
  it("writes a story through the engine chain", async () => {
    stubReplies(["Once upon a rainy night…"]);
    const result = await runWriterAction({
      action: "write",
      brief: { idea: "a neon chase", sceneCount: 3 },
    });
    expect(result).toMatchObject({
      text: "Once upon a rainy night…",
      provider: "sogni",
    });
  });

  it("falls through to the next engine when the first fails", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((..._args: unknown[]) => {
        call += 1;
        if (call === 1) return Promise.resolve(new Response("nope", { status: 503 }));
        // Pollinations is the second engine and replies plain text.
        return Promise.resolve(new Response("recovered", { status: 200 }));
      }),
    );
    const result = await runWriterAction({
      action: "enhance",
      draft: "draft text",
      instruction: "make it darker",
    });
    expect(result).toMatchObject({ text: "recovered" });
  });

  it("retries split once with a stricter instruction before failing", async () => {
    const fetchMock = stubReplies(["not json at all", SPLIT_JSON]);
    const result = await runWriterAction({
      action: "split",
      draft: "prose to split",
      sceneCount: 3,
    });
    expect(result).toMatchObject({ title: "The Chase", scenes: ["s1", "s2", "s3"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requests a larger output budget for split than the 700-token default", async () => {
    const fetchMock = stubReplies([SPLIT_JSON]);
    await runWriterAction({ action: "split", draft: "prose", sceneCount: 3 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
  });

  it("surfaces a retryable error when every engine fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((..._args: unknown[]) =>
        Promise.resolve(new Response("down", { status: 503 })),
      ),
    );
    await expect(
      runWriterAction({ action: "write", brief: { idea: "x" } }),
    ).rejects.toBeInstanceOf(WriterServiceError);
  });

  it("validates the body before spending the engine", async () => {
    await expect(runWriterAction({ action: "write", brief: { idea: "" } })).rejects.toThrow(
      /idea/i,
    );
    await expect(
      runWriterAction({ action: "bogus" } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/action/i);
  });

  it("honours the tasks.writer pick (engine receives the model)", async () => {
    updateProviderConfig({ tasks: { writer: "pollinations:default" } });
    const fetchMock = stubTextReplies(["pol story"]);
    const result = await runWriterAction({ action: "write", brief: { idea: "x" } });
    expect(result.provider).toBe("pollinations");
    expect(result.model).toBe("default");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("pollinations");
  });
});

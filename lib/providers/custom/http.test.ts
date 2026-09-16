import { describe, expect, it, vi } from "vitest";
import { httpJson } from "./http";
import { ProviderError } from "@/lib/providers/types";

const target = {
  baseUrl: "https://relay.example/v1",
  apiKey: "sk-test",
  label: "My Relay",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("httpJson", () => {
  it("sends bearer auth, JSON body, and returns parsed JSON", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://relay.example/v1/models");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      expect(init!.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ model: "x" });
      return jsonResponse(200, { ok: true });
    });

    const result = await httpJson<{ ok: boolean }>(
      target,
      { method: "POST", path: "/models", body: { model: "x" } },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true });
  });

  it("retries rate limits on POST and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "slow down" }))
      .mockResolvedValueOnce(jsonResponse(200, { done: 1 }));

    const result = await httpJson<{ done: number }>(
      target,
      { method: "POST", path: "/videos/generations", body: {} },
      fetchImpl,
    );
    expect(result.done).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a plain 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad" }));

    await expect(
      httpJson(target, { method: "POST", path: "/x", body: {} }, fetchImpl),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 401 to a key-rejected message without retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "nope" }));

    await expect(httpJson(target, { path: "/models" }, fetchImpl)).rejects.toThrow(
      /API key was rejected/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps network failures to an unreachable error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      httpJson(target, { path: "/models", retries: 1 }, fetchImpl),
    ).rejects.toThrow(/could not reach My Relay/);
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init!.signal as AbortSignal;
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    await expect(
      httpJson(target, { path: "/models", signal: controller.signal }, fetchImpl),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

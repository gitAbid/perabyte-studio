import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProductionApplicationError } from "./errors";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "./http";

const schema = z.strictObject({ name: z.string() });
const request = (body: string, headers: HeadersInit = {}) => new Request("https://studio.example/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("production HTTP boundary", () => {
  it("requires a same-host Origin for mutations", () => {
    expect(() => assertSameOriginMutation(request("{}", { origin: "https://studio.example" }))).not.toThrow();
    expect(() => assertSameOriginMutation(request("{}"))).toThrow(ProductionApplicationError);
    expect(() => assertSameOriginMutation(request("{}", { origin: "https://evil.example" }))).toThrow(ProductionApplicationError);
  });

  it("uses the validated Host authority when the framework rewrites the request URL", () => {
    const req = new Request("http://next-internal-host/api/production/projects", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3190",
        host: "127.0.0.1:3190",
        "x-forwarded-host": "attacker.example",
      },
    });
    expect(() => assertSameOriginMutation(req)).not.toThrow();
  });

  it("rejects mismatched or malformed Host authorities and non-origin Origin values", () => {
    const check = (host: string, origin = "https://studio.example") =>
      assertSameOriginMutation(new Request("https://internal.invalid/api", {
        method: "POST", headers: { host, origin },
      }));
    expect(() => check("other.example")).toThrow(ProductionApplicationError);
    expect(() => check("studio.example/evil")).toThrow(ProductionApplicationError);
    expect(() => check("user@studio.example")).toThrow(ProductionApplicationError);
    expect(() => check("studio.example", "https://studio.example/path")).toThrow(ProductionApplicationError);
    expect(() => check("studio.example", "https://user@studio.example")).toThrow(ProductionApplicationError);
    expect(() => check("studio.example", "https://evil.example")).toThrow(ProductionApplicationError);
  });

  it("keeps HTTPS comparison and plain Request URL fallback intact", () => {
    expect(() => assertSameOriginMutation(new Request("https://studio.example/api", {
      method: "POST", headers: { host: "studio.example", origin: "https://studio.example" },
    }))).not.toThrow();
    expect(() => assertSameOriginMutation(request("{}", { origin: "https://studio.example" }))).not.toThrow();
  });

  it("parses strict DTOs and rejects malformed or declared oversized JSON", async () => {
    await expect(readProductionJson(request('{"name":"ok"}'), schema)).resolves.toEqual({ name: "ok" });
    await expect(readProductionJson(request('{"name":"ok","extra":1}'), schema)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readProductionJson(request("{"), schema)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readProductionJson(request('{"name":"ok"}', { "content-length": "100" }), schema, { maxBytes: 20 })).rejects.toMatchObject({ status: 413 });
  });

  it("bounds actual streamed bytes when Content-Length is absent", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"name":"')); controller.enqueue(new TextEncoder().encode("x".repeat(100))); controller.close(); } });
    const req = new Request("https://studio.example/api", { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(readProductionJson(req, schema, { maxBytes: 20 })).rejects.toMatchObject({ status: 413 });
  });

  it("maps stable errors and sanitizes internal failures", async () => {
    const expectedStatuses = { INVALID_INPUT: 400, UNKNOWN_REFERENCE: 404, STALE_REVISION: 409, APPROVAL_REQUIRED: 428, CAPABILITY_MISMATCH: 422, BUDGET_BLOCKED: 403, WORKER_OFFLINE: 503, SUBMISSION_UNKNOWN: 409, MEDIA_UNAVAILABLE: 422, QC_BLOCKED: 422, INTERNAL_ERROR: 500 } as const;
    for (const [code, status] of Object.entries(expectedStatuses) as [keyof typeof expectedStatuses, number][]) {
      expect(productionErrorResponse(new ProductionApplicationError(code, "Known"), "req-1").status).toBe(status);
    }
    expect(productionErrorResponse(new ProductionApplicationError("UNKNOWN_REFERENCE", "Unknown"), "req-1", { unknownReferenceStatus: 422 }).status).toBe(422);
    const actionable = productionErrorResponse(new ProductionApplicationError("INVALID_INPUT", "Bad field", { field: "name", action: "Choose a name", details: { maxLength: 80 } }), "req-ctx");
    await expect(actionable.json()).resolves.toMatchObject({ requestId: "req-ctx", error: { code: "INVALID_INPUT", field: "name", action: "Choose a name", details: { maxLength: 80 } } });
    const response = productionErrorResponse(new Error("/private/path secret-token"), "req-2");
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).toContain("INTERNAL_ERROR");
    expect(body).not.toContain("private");
    expect(body).not.toContain("secret-token");
    expect(getRequestId(request("{}", { "x-request-id": "client-id" }))).toBe("client-id");
  });
});

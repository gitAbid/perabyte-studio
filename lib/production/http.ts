import { randomUUID } from "node:crypto";
import { ProductionApplicationError, ProductionErrorEnvelopeSchema, type ProductionErrorCode } from "./errors";
import type { JsonValue } from "./contracts";
import { z } from "zod";

export const DEFAULT_PRODUCTION_JSON_LIMIT = 2 * 1024 * 1024;
const INTERNAL_MESSAGE = "An unexpected server error occurred.";

export function getRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && supplied.length <= 200 ? supplied : randomUUID();
}

export function assertSameOriginMutation(request: Request): void {
  const origin = request.headers.get("origin");
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") throw new Error("Unsupported protocol");
  } catch {
    throw new ProductionApplicationError("INVALID_INPUT", "Invalid request URL");
  }

  let requestOrigin = requestUrl.origin;
  const host = request.headers.get("host");
  if (host !== null) {
    // Next may rewrite request.url to an internal pathname before invoking a
    // route handler. Host is the request authority; forwarded headers are
    // intentionally ignored because they are client-controlled at this boundary.
    if (!host || /[\\/?#@,\s\u0000-\u001f\u007f]/.test(host)) {
      throw new ProductionApplicationError("INVALID_INPUT", "Invalid request Host header");
    }
    let hostUrl: URL;
    try {
      hostUrl = new URL(`${requestUrl.protocol}//${host}/`);
      if (hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash) throw new Error("Invalid authority");
      // Reject authority syntax that URL silently normalizes, such as an empty
      // port delimiter, while allowing case and default-port normalization.
      if (host.endsWith(":")) throw new Error("Invalid port");
    } catch {
      throw new ProductionApplicationError("INVALID_INPUT", "Invalid request Host header");
    }
    requestOrigin = hostUrl.origin;
  }

  let suppliedOrigin: URL | undefined;
  try {
    if (origin) suppliedOrigin = new URL(origin);
  } catch {
    // Handled uniformly as a missing/invalid same-origin header below.
  }
  if (!origin || !suppliedOrigin || (suppliedOrigin.protocol !== "http:" && suppliedOrigin.protocol !== "https:") ||
      suppliedOrigin.username || suppliedOrigin.password || suppliedOrigin.origin !== origin || origin !== requestOrigin) {
    throw new ProductionApplicationError("INVALID_INPUT", "Mutation request must have a same-origin Origin header");
  }
}

export async function readProductionJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_PRODUCTION_JSON_LIMIT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive safe integer");
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new ProductionApplicationError("INVALID_INPUT", "Invalid Content-Length");
    if (Number(length) > maxBytes) throw tooLarge();
  }
  if (!request.body) throw new ProductionApplicationError("INVALID_INPUT", "Request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let parsedJson: unknown;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProductionApplicationError("INVALID_INPUT", "Request body must contain valid JSON");
  }
  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) throw new ProductionApplicationError("INVALID_INPUT", "Request body does not match the expected shape", { details: { issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String).join("."), code: issue.code })) as JsonValue[] } });
  return parsed.data;
}

function tooLarge(): ProductionApplicationError & { status: number } {
  return Object.assign(new ProductionApplicationError("INVALID_INPUT", "Request body exceeds the allowed size"), { status: 413 });
}

const statuses: Record<ProductionErrorCode, number> = {
  INTERNAL_ERROR: 500,
  INVALID_INPUT: 400,
  UNKNOWN_REFERENCE: 404,
  STALE_REVISION: 409,
  APPROVAL_REQUIRED: 428,
  CAPABILITY_MISMATCH: 422,
  BUDGET_BLOCKED: 403,
  WORKER_OFFLINE: 503,
  SUBMISSION_UNKNOWN: 409,
  MEDIA_UNAVAILABLE: 422,
  QC_BLOCKED: 422,
};

export function productionErrorResponse(
  error: unknown,
  requestId: string = randomUUID(),
  options: { unknownReferenceStatus?: 404 | 422 } = {},
): Response {
  const known = error instanceof ProductionApplicationError;
  const envelope = known
    ? error.toEnvelope(requestId)
    : ProductionErrorEnvelopeSchema.parse({ error: { code: "INTERNAL_ERROR", message: INTERNAL_MESSAGE, retryable: false }, requestId });
  const status = !known
    ? 500
    : (error as ProductionApplicationError & { status?: number }).status ??
      (error.code === "UNKNOWN_REFERENCE" ? options.unknownReferenceStatus ?? statuses[error.code] : statuses[error.code]);
  return Response.json(envelope, { status, headers: { "cache-control": "no-store" } });
}

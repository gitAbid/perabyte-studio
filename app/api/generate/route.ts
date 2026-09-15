import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  GenerationServiceError,
  runGeneration,
} from "@/lib/services/generation.service";

export const runtime = "nodejs";
/**
 * Render budgets are configurable (Settings → Render timeouts, default
 * 10 min per video clip); self-hosted runtimes have no hard cap, and hosted
 * platforms clamp this to the plan maximum.
 */
export const maxDuration = 600;

const log = logger.child({ route: "api/generate" });

/**
 * Thin controller: parse → service → response. All logic lives in the service.
 *
 * Clients that send `accept: application/x-ndjson` get a streamed reply:
 * `{"type":"progress",…}` lines while the render runs, then one
 * `{"type":"result",…}` or `{"type":"error",…}` line. Everyone else gets the
 * original single JSON response.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }

  const wantsStream = (request.headers.get("accept") ?? "").includes("application/x-ndjson");
  if (wantsStream) return streamGeneration(body, request.signal);

  try {
    const response = await runGeneration(body, {
      signal: request.signal,
      logger: log,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, request.signal);
  }
}

/** Stream progress lines, then the final result or error as NDJSON. */
function streamGeneration(body: Record<string, unknown>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (line: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // Client disconnected mid-stream; stop writing, service abort follows.
          closed = true;
        }
      };

      try {
        const response = await runGeneration(body, {
          signal,
          logger: log,
          onProgress: (progress) => send({ type: "progress", ...progress }),
        });
        send({ type: "result", ...response });
      } catch (error) {
        if ((error as Error)?.name === "AbortError" || signal.aborted) {
          log.info("generation cancelled by client");
        } else if (error instanceof GenerationServiceError) {
          log.warn("generation rejected", {
            message: error.message,
            field: error.field,
            status: error.status,
          });
          send({
            type: "error",
            error: error.message,
            field: error.field,
            retryable: error.retryable,
            ...(error.pending ? { pending: true } : {}),
          });
        } else {
          log.error("generation failed unexpectedly", { error });
          send({ type: "error", error: "Something went wrong while generating.", retryable: true });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime after a client disconnect.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(error: unknown, signal: AbortSignal): NextResponse {
  if ((error as Error)?.name === "AbortError" || signal.aborted) {
    log.info("generation cancelled by client");
    return new NextResponse(null, { status: 499 });
  }
  if (error instanceof GenerationServiceError) {
    log.warn("generation rejected", {
      message: error.message,
      field: error.field,
      status: error.status,
    });
    return NextResponse.json(
      {
        error: error.message,
        field: error.field,
        retryable: error.retryable,
        ...(error.pending ? { pending: true } : {}),
      },
      { status: error.status },
    );
  }
  log.error("generation failed unexpectedly", { error });
  return NextResponse.json(
    { error: "Something went wrong while generating.", retryable: true },
    { status: 500 },
  );
}

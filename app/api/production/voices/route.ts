import { VoicesStoreV1Schema, loadVoicesStore, mergeVoicesStore, saveVoicesStore } from "@/lib/voices/server-store";
import { assertSameOriginMutation, getRequestId, productionErrorResponse } from "@/lib/production/http";
import { ProductionApplicationError } from "@/lib/production/errors";

/**
 * Server voice library + bindings (C16, spec 12). GET returns the server
 * store; PUT (same-origin) adopts a client snapshot — the one-time localStorage
 * migration path — by merging it into the server store (server rows win voice
 * conflicts, latest binding wins per character). Bindings never touch character
 * canon: recasting is a voices-store row, never a CanonRevision write.
 */

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const store = await loadVoicesStore();
    return Response.json({ store }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const raw: unknown = await request.json().catch(() => null);
    const parsed = VoicesStoreV1Schema.safeParse(raw);
    if (!parsed.success) {
      throw new ProductionApplicationError("INVALID_INPUT", "Voice store snapshot does not match the expected shape.", {
        action: "Reload the voices page and try again.",
        retryable: false,
      });
    }
    const server = await loadVoicesStore();
    const merged = mergeVoicesStore(server, parsed.data);
    await saveVoicesStore(merged);
    return Response.json({ store: merged }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

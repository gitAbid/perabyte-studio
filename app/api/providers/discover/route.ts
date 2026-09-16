import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { ProviderError } from "@/lib/providers/types";
import { discoverProviderModels, type DiscoverInput } from "@/lib/providers/custom/discovery.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/providers/discover" });

/**
 * Server-side model discovery for custom providers. Runs with the stored
 * key when `{id}` is given (or an explicit key for an unsaved provider) so
 * the browser never needs the credential — and the key never comes back.
 */
export async function POST(request: Request) {
  let body: DiscoverInput | null = null;
  try {
    body = (await request.json()) as DiscoverInput;
  } catch {
    // falls through to the validation error below
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(
      { error: "Invalid discovery payload.", field: "format" },
      { status: 400 },
    );
  }
  try {
    const result = await discoverProviderModels(body);
    log.info("models discovered", {
      id: body.id ?? null,
      count: result.models.length,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProviderError) {
      const status = error.field === "apiKey" || error.field === "baseUrl" ? 400 : 502;
      log.warn("discovery failed", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status },
      );
    }
    log.error("discovery failed unexpectedly", { error });
    return NextResponse.json({ error: "Could not reach the provider." }, { status: 500 });
  }
}

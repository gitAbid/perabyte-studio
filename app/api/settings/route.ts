import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import {
  applyProviderSettingsUpdate,
  getProviderSettings,
  ProviderSettingsError,
} from "@/lib/services/provider-settings.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/settings" });

/**
 * Full provider inventory for the settings page. Raw API keys never leave the
 * server: GET reports only the source and a masked tail, PUT is write-only.
 */
export async function GET() {
  return NextResponse.json(getProviderSettings(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function PUT(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // falls through to the validation error below
  }
  try {
    const payload = applyProviderSettingsUpdate(body);
    log.info("provider settings updated");
    return NextResponse.json(payload, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ProviderSettingsError) {
      log.warn("provider settings rejected", { message: error.message, field: error.field });
      return NextResponse.json(
        { error: error.message, field: error.field },
        { status: error.status },
      );
    }
    log.error("provider settings update failed", { error });
    return NextResponse.json({ error: "Could not save settings." }, { status: 500 });
  }
}

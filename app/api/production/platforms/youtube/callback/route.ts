import { resolveYouTubeConfig } from "@/lib/services/production/platforms/youtube";
import { fetchYouTubeTransport, loadUploads, saveUploads } from "@/lib/services/production/platforms/youtube";
import { resolveProductionDataDir } from "@/lib/production/runtime";
import { getRequestId, productionErrorResponse } from "@/lib/production/http";

// OAuth redirect target: exchanges the authorization code and persists the
// refresh token (0600, machine-local). OAuth failure NEVER marks any
// publication complete — the settings page just shows the connect state.

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const url = new URL(request.url);
    const config = resolveYouTubeConfig();
    if (!config) return Response.redirect(`${url.origin}/settings?section=budget&youtube=not-configured`, 302);
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) {
      return Response.redirect(`${url.origin}/settings?section=budget&youtube=denied`, 302);
    }
    const tokens = await fetchYouTubeTransport.exchangeCode(config, code, `${url.origin}/api/production/platforms/youtube/callback`);
    const dataDir = resolveProductionDataDir();
    const uploads = await loadUploads(dataDir);
    await saveUploads(dataDir, { ...uploads, refreshToken: tokens.refreshToken ?? uploads.refreshToken });
    return Response.redirect(`${url.origin}/settings?section=budget&youtube=connected`, 302);
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

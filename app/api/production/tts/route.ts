import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalMediaVault } from "@/lib/media/production/vault";
import { resolveProductionDataDir } from "@/lib/production/runtime";
import { AssetSchema, ImportProvenanceSchema, RightsStatusSchema } from "@/lib/production/contracts";
import { getTtsAdapter } from "@/lib/providers/production/tts-adapter";
import { createEdgeTtsAdapter } from "@/lib/providers/production/edge-tts";
import { ProductionApplicationError } from "@/lib/production/errors";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "@/lib/production/http";
import { withProductionStore } from "@/lib/production/runtime";
import { DeliveryPresetSchema } from "@/lib/production/contracts";
import { z } from "zod";

/**
 * TTS line generation (C18, spec 12 §8): synthesizes ONE speech line through
 * the active adapter and imports the result into the vault through the SAME
 * service the manual import path uses — generated narration gets identical
 * bookkeeping (spec acceptance). A missing/unavailable adapter is an honest
 * BUDGET-less CAPABILITY error, never a fake control: the audio page shows
 * Generate only when GET reports available.
 */

export const runtime = "nodejs";

const SynthesizeSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  voiceId: z.string().trim().min(1).max(200).optional(),
  delivery: DeliveryPresetSchema,
  source: z.string().trim().min(1).max(200),
  speed: z.number().finite().min(0.5).max(2).optional(),
});

let adapterPromise: Promise<ReturnType<typeof createEdgeTtsAdapter>> | null = null;
function activeAdapter() {
  const registered = getTtsAdapter();
  if (registered) return registered;
  if (!adapterPromise) adapterPromise = Promise.resolve(createEdgeTtsAdapter());
  return adapterPromise;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    const adapter = await Promise.resolve(activeAdapter()).catch(() => null);
    return Response.json(
      { available: adapter?.available() === true, adapterId: adapter?.id ?? null },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const command = await readProductionJson(request, SynthesizeSchema);
    const adapter = await Promise.resolve(activeAdapter()).catch(() => null);
    if (!adapter || !adapter.available()) {
      throw new ProductionApplicationError("CAPABILITY_MISMATCH", "No voice engine is available on this machine.", {
        action: "Import a recording for this line instead — import stays first-class.",
        retryable: false,
      });
    }
    const result = await adapter.synthesize({
      text: command.text,
      voiceId: command.voiceId ?? "",
      delivery: command.delivery,
      ...(command.speed !== undefined ? { speed: command.speed } : {}),
    });
    const dataDir = resolveProductionDataDir(process.env, process.cwd());
    const vault = new LocalMediaVault({ root: join(dataDir, "media") });
    const provenance = ImportProvenanceSchema.parse({
      source: `tts:${command.source}:${result.adapterVersion}`,
      rightsAttestation: "Generated locally by the studio's built-in voice engine for this line; the line text is the creator's own.",
      actorId: "local_creator",
      createdAt: Date.now(),
    });
    const rightsStatus = RightsStatusSchema.parse("creator_attested");
    const media = await vault.putStream(Readable.from(Buffer.from(result.audio)), {
      mime: "audio/mpeg", sourceKind: "upload", rightsStatus, maxBytes: 50 * 1024 * 1024,
    });
    const asset = AssetSchema.parse({ ...media.asset, rightsStatus, importProvenance: provenance });
    await withProductionStore((store) => store.transaction((tx) => tx.insertAsset({ ...media, asset })));
    return Response.json({ asset, created: true, adapterId: adapter.id }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

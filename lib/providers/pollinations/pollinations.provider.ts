import type { ModelDescriptor } from "@/lib/domain/models";
import { buildModelId } from "@/lib/domain/models";
import type {
  GeneratedArtifact,
  ImageProvider,
  ProviderContext,
  VideoProvider,
} from "@/lib/providers/types";
import type { NormalizedGenerationRequest } from "@/lib/domain/models";
import { buildMediaUrl, randomSeed, type RenderRequest } from "@/lib/renderer";
import { after } from "next/server";

/**
 * Keyless fallback provider wrapping the original Pollinations render path.
 * Its URLs are deterministic (same prompt + seed ⇒ same render), so results
 * are served straight from the provider through the existing `/api/media`
 * proxy instead of being downloaded into the cache.
 *
 * Video on this provider is the legacy behaviour: a still keyframe rendered
 * as an image, presented by the UI as an animated preview.
 */
const PROVIDER_ID = "pollinations";

const FLUX_IMAGE: ModelDescriptor = {
  id: buildModelId(PROVIDER_ID, "flux"),
  providerId: PROVIDER_ID,
  kind: "image",
  model: "flux",
  label: "Flux",
  hint: "free demo",
  // No separate uncensored mode: safe=true merely keeps the provider's
  // checker on, so this model always renders behind it.
  uncensored: false,
};

const FLUX_VIDEO: ModelDescriptor = {
  id: buildModelId(PROVIDER_ID, "flux-keyframe"),
  providerId: PROVIDER_ID,
  kind: "video",
  model: "flux",
  label: "Flux keyframe",
  hint: "free demo · still frame",
  uncensored: false,
};

function toRenderRequest(request: NormalizedGenerationRequest): RenderRequest {
  return {
    kind: request.kind,
    // The style preset is folded into the prompt by the service layer.
    prompt: request.prompt,
    style: "",
    aspect: request.aspect,
    resolution: request.resolution,
    negativePrompt: request.negativePrompt,
    enhance: request.enhance,
    // Pollinations has no separate "uncensored" mode; safe=true simply keeps
    // the provider's safety checker on.
    safe: request.safe ? true : false,
  };
}

async function warm(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { accept: "image/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) return false;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return false;
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

function buildArtifacts(request: NormalizedGenerationRequest): GeneratedArtifact[] {
  const base = request.seed ?? randomSeed();
  return Array.from({ length: request.count }, (_, index) => {
    const seed = request.count === 1 ? base : base + index * 977;
    const url = buildMediaUrl(toRenderRequest(request), seed);
    return {
      bytes: null,
      url,
      ext: "jpg",
      seed,
      // No image input exists on this provider — frames are always dropped.
      ...(request.startImage ? { frameDropped: true } : {}),
    };
  });
}

/** Shared fan-out: build deterministic URLs, warm the primary inline. */
async function generate(request: NormalizedGenerationRequest, ctx: ProviderContext): Promise<GeneratedArtifact[]> {
  const artifacts = buildArtifacts(request);
  const [primary, ...extras] = artifacts;

  ctx.onProgress?.({
    stage: "rendering",
    message: "Rendering on the free demo provider — this can take a few seconds…",
  });

  // The provider renders on first request and then serves from cache. Warming
  // the primary inline means the browser's own request is a cache hit; extras
  // are warmed after the response (the provider 429s parallel renders).
  const prewarmed = primary ? await warm(primary.url as string, 45_000) : false;
  if (primary) primary.prewarmed = prewarmed;
  ctx.logger.debug("pollinations primary warmed", { prewarmed, count: artifacts.length });

  if (extras.length) {
    after(async () => {
      for (const extra of extras) {
        const ok = await warm(extra.url as string, 75_000);
        if (!ok) break;
      }
    });
  }
  return artifacts;
}

export const pollinationsProvider: ImageProvider & VideoProvider = {
  id: PROVIDER_ID,
  label: "Pollinations",
  isConfigured: () => true,

  listImageModels: () => [FLUX_IMAGE],

  generateImage: (request, _model, ctx) => generate(request, ctx),

  listVideoModels: () => [FLUX_VIDEO],
  generateVideo: (request, _model, ctx) => generate({ ...request, kind: "video" }, ctx),
};

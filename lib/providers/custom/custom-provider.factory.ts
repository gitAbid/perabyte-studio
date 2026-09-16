import type {
  GeneratedArtifact,
  ImageProvider,
  JobPollResult,
  JobProvider,
  ProviderContext,
  VideoProvider,
} from "@/lib/providers/types";
import { ProviderError } from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { CustomModelEntry, CustomProviderEntry } from "@/lib/repositories/provider-config.repository";
import { ASPECTS, RESOLUTIONS, type AspectKey, type ResolutionKey } from "@/lib/constants";
import { getStudioEnv } from "@/lib/config/env";
import { driveJobToDeadline } from "@/lib/providers/job-drive";
import { formatFor } from "./formats";
import type { ProviderFormat } from "./formats/types";
import { newImageRef, parkImage, takeParkedImage } from "./parked-images";

/**
 * Adapter factory: a stored custom-provider entry becomes a first-class
 * generation provider. The shape deliberately mirrors `apiKeyFanProvider` —
 * sync image calls park their artifacts for the executor, video runs through
 * the durable submit/poll pair of the entry's wire format.
 */
export function createCustomProvider(
  entry: CustomProviderEntry,
  format: ProviderFormat = formatFor(entry.format),
): ImageProvider & VideoProvider & JobProvider {
  function descriptorsOf(kind: "image" | "video"): ModelDescriptor[] {
    return entry.models
      .filter((model) => model.kind === kind && model.enabled)
      .map((model) => descriptorFor(entry, model));
  }

  return {
    id: entry.id,
    label: entry.label,

    isConfigured() {
      // OpenAI-shaped servers are often keyless (Ollama, LM Studio, vLLM);
      // Google and Anthropic always require a key.
      return entry.enabled && (entry.apiKey !== null || entry.format === "openai");
    },

    listImageModels: () => descriptorsOf("image"),
    listVideoModels: () => descriptorsOf("video"),

    async generateImage(
      request: NormalizedGenerationRequest,
      model: ModelDescriptor,
      ctx: ProviderContext,
    ): Promise<GeneratedArtifact[]> {
      if (!format.generateImage) {
        throw new ProviderError(
          `${entry.label} (${entry.format}) does not support image generation.`,
          { retryable: false, field: "model" },
        );
      }
      return format.generateImage(entry, request, model, ctx);
    },

    async generateVideo(
      request: NormalizedGenerationRequest,
      model: ModelDescriptor,
      ctx: ProviderContext,
    ): Promise<GeneratedArtifact[]> {
      if (!format.videoJobs) {
        throw new ProviderError(
          `${entry.label} (${entry.format}) does not support video generation.`,
          { retryable: false, field: "model" },
        );
      }
      return driveJobToDeadline({
        provider: this,
        providerLabel: entry.label,
        request,
        model,
        ctx,
        kind: "video",
        deadlineMs: getStudioEnv().videoRenderDeadlineMs,
      });
    },

    async submitJob(
      request: NormalizedGenerationRequest,
      model: ModelDescriptor,
      ctx: ProviderContext,
    ): Promise<{ ref: string }> {
      if (request.kind === "video") {
        if (!format.videoJobs) {
          throw new ProviderError(
            `${entry.label} (${entry.format}) does not support video generation.`,
            { retryable: false, field: "model" },
          );
        }
        return format.videoJobs(entry).submit(request, model, ctx);
      }
      // Images are one synchronous call — complete "at submit"; the artifacts
      // park in memory for the executor's first poll. A restart loses the
      // parking spot, reported as a retryable failure (same as apikey-fan).
      const artifacts = await this.generateImage(request, model, ctx);
      const ref = newImageRef(entry.id);
      parkImage(ref, artifacts);
      return { ref };
    },

    async pollJob(
      ref: string,
      request: NormalizedGenerationRequest,
      model: ModelDescriptor,
      ctx: ProviderContext,
    ): Promise<JobPollResult> {
      if (ref.startsWith("cimg_")) {
        const parked = takeParkedImage(ref);
        if (!parked) {
          return {
            status: "failed",
            retryable: true,
            message:
              "The server restarted while this render was in flight and the result could not be retrieved. Please re-run it.",
          };
        }
        return { status: "completed", artifacts: parked };
      }
      if (!format.videoJobs) {
        return {
          status: "failed",
          retryable: false,
          message: `${entry.label} (${entry.format}) does not support video generation.`,
        };
      }
      return format.videoJobs(entry).poll(ref, request, model, ctx);
    },

    async cancelJob(ref: string): Promise<void> {
      // The wire formats expose no cancel endpoint today; letting the job
      // finish unretrieved matches the apikey-fan behavior.
      void ref;
    },
  };
}

function descriptorFor(entry: CustomProviderEntry, model: CustomModelEntry): ModelDescriptor {
  const base: ModelDescriptor = {
    id: `${entry.id}:${model.model}`,
    providerId: entry.id,
    kind: model.kind === "video" ? "video" : "image",
    model: model.model,
    label: model.label ?? model.model,
    stylesSupported: true,
    costTier: "key-credits",
    frameInput: { start: true, end: false },
  };
  if (model.kind === "video") {
    base.videoLimits = {
      duration: { min: 1, max: 15 },
      ratios: Object.keys(ASPECTS) as AspectKey[],
      resolutions: Object.keys(RESOLUTIONS) as ResolutionKey[],
    };
  }
  return base;
}

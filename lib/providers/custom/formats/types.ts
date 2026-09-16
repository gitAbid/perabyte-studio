import type {
  GeneratedArtifact,
  JobPollResult,
  ProviderContext,
  TextGenerationRequest,
  TextGenerationResult,
} from "@/lib/providers/types";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type {
  CustomProviderEntry,
  CustomProviderFormat,
} from "@/lib/repositories/provider-config.repository";

/**
 * One model reported by a provider's model listing, with a kind guess.
 * `off` = the classifier could not place it; the user decides in Settings.
 */
export interface DiscoveredModel {
  model: string;
  label?: string;
  kind: "image" | "video" | "text" | "off";
}

/**
 * Async video pair for formats whose video API is job-based. `ref` is the
 * provider's own job id — the durable executor resolves the owning provider
 * through the registry by model id, so refs need no provider prefix.
 */
export interface VideoJobPair {
  submit(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<{ ref: string }>;
  poll(
    ref: string,
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<JobPollResult>;
}

/**
 * Wire-format strategy for user-registered providers. Each format knows how
 * to list models and translate the neutral generation contracts onto its
 * API shape. Formats implement only what the wire actually supports —
 * anthropic, for instance, carries no image/video capability.
 */
export interface ProviderFormat {
  readonly id: CustomProviderFormat;
  readonly label: string;
  readonly capabilities: { image: boolean; video: boolean; text: boolean };
  listModels(cfg: CustomProviderEntry): Promise<DiscoveredModel[]>;
  generateImage?(
    cfg: CustomProviderEntry,
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]>;
  videoJobs?(cfg: CustomProviderEntry): VideoJobPair;
  generateText?(
    cfg: CustomProviderEntry,
    request: TextGenerationRequest,
  ): Promise<TextGenerationResult>;
}

import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { Logger } from "@/lib/logging/logger";

/**
 * Provider contracts (Strategy). A provider implements only the capability
 * it actually has — Interface Segregation — and everything downstream
 * (services, routes, UI) depends on these abstractions, never on a concrete
 * provider. Adding a provider means adding an adapter and registering it;
 * no existing code changes.
 */
export interface ProviderContext {
  logger: Logger;
  signal?: AbortSignal;
}

/**
 * Raw output of one provider call, before persistence. Either `bytes`
 * (inline b64 / downloaded file) or `url` (provider-hosted link) is set.
 */
export interface GeneratedArtifact {
  bytes: Buffer | null;
  url: string | null;
  /** Hint extension; the media repository sniffs real types from bytes. */
  ext: string;
  seed: number;
  revisedPrompt?: string;
  /** True when this artifact was already produced before the provider call
   * resolved (Pollinations inline warming) — surfaced as `prewarmed`. */
  prewarmed?: boolean;
}

export interface ImageProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  listImageModels(): ModelDescriptor[];
  generateImage(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]>;
}

export interface VideoProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  listVideoModels(): ModelDescriptor[];
  generateVideo(
    request: NormalizedGenerationRequest,
    model: ModelDescriptor,
    ctx: ProviderContext,
  ): Promise<GeneratedArtifact[]>;
}

export type GenerationProvider = ImageProvider | VideoProvider;

/** Provider failure mapped onto the API's `{ error, field, retryable }` contract. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly field?: string;
  readonly status?: number;

  constructor(
    message: string,
    options?: { retryable?: boolean; field?: string; status?: number },
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options?.retryable ?? true;
    this.field = options?.field;
    this.status = options?.status;
  }
}

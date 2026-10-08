import { z } from "zod";
import { JsonValueSchema, NonEmptyTextSchema, type JsonValue } from "./contracts";

export const ProductionErrorCodeSchema = z.enum([
  "INTERNAL_ERROR",
  "INVALID_INPUT",
  "UNKNOWN_REFERENCE",
  "STALE_REVISION",
  "APPROVAL_REQUIRED",
  "CAPABILITY_MISMATCH",
  "BUDGET_BLOCKED",
  "WORKER_OFFLINE",
  "SUBMISSION_UNKNOWN",
  "MEDIA_UNAVAILABLE",
  "QC_BLOCKED",
]);
export type ProductionErrorCode = z.infer<typeof ProductionErrorCodeSchema>;

export const ProductionErrorDetailsSchema = z.record(z.string(), JsonValueSchema);
export const ProductionErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ProductionErrorCodeSchema,
    message: NonEmptyTextSchema.max(4000),
    field: z.string().max(200).optional(),
    shotId: z.string().max(200).optional(),
    retryable: z.boolean(),
    action: z.string().max(1000).optional(),
    details: ProductionErrorDetailsSchema.optional(),
  }),
  requestId: z.string().min(1).max(200),
});
export type ProductionErrorEnvelope = z.infer<typeof ProductionErrorEnvelopeSchema>;

export class ProductionApplicationError extends Error {
  readonly code: ProductionErrorCode;
  readonly retryable: boolean;
  readonly field?: string;
  readonly shotId?: string;
  readonly action?: string;
  readonly details?: Record<string, JsonValue>;

  constructor(
    code: ProductionErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      field?: string;
      shotId?: string;
      action?: string;
      details?: Record<string, JsonValue>;
    } = {},
  ) {
    super(message);
    this.name = "ProductionApplicationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.field = options.field;
    this.shotId = options.shotId;
    this.action = options.action;
    this.details = options.details;
  }

  toEnvelope(requestId: string): ProductionErrorEnvelope {
    return ProductionErrorEnvelopeSchema.parse({
      error: {
        code: this.code,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
        ...(this.shotId ? { shotId: this.shotId } : {}),
        retryable: this.retryable,
        ...(this.action ? { action: this.action } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
      requestId,
    });
  }
}

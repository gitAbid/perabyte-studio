import type { ModelDescriptor } from "@/lib/domain/models";

export type ReferencePolicy = "best-effort" | "strict";

export interface RequestedReferenceInputs {
  start: boolean;
  end: boolean;
  contextCount: number;
}

export interface ReferenceCapabilityViolation {
  field: "startImage" | "endImage" | "referenceImage";
  message: string;
}

/** Pure preflight for references against the model that will actually render. */
export function validateReferenceCapabilities(
  model: ModelDescriptor,
  requested: RequestedReferenceInputs,
): ReferenceCapabilityViolation[] {
  const violations: ReferenceCapabilityViolation[] = [];
  if (requested.start && !model.frameInput?.start) {
    violations.push({
      field: "startImage",
      message: "The selected model cannot use a start frame.",
    });
  }
  if (requested.end && !model.frameInput?.end) {
    violations.push({
      field: "endImage",
      message: "The selected model cannot use an end frame.",
    });
  }

  const context = model.contextImages;
  if (requested.contextCount > 0 && !context) {
    violations.push({
      field: "referenceImage",
      message: "The selected model cannot use context reference images.",
    });
  } else if (context) {
    // Edit-class adapters may place the start frame in the same contextImages
    // array, so it consumes one of that model's slots.
    const total = requested.contextCount + (requested.start && model.frameInput?.start ? 1 : 0);
    if (total < context.min) {
      violations.push({
        field: "referenceImage",
        message: `The selected model requires at least ${context.min} context image${context.min === 1 ? "" : "s"}.`,
      });
    }
    if (total > context.max) {
      violations.push({
        field: "referenceImage",
        message: `The selected model accepts at most ${context.max} context images${requested.start ? " including the start frame" : ""}.`,
      });
    }
  }
  return violations;
}

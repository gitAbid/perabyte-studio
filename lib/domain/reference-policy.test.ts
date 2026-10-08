import { describe, expect, it } from "vitest";
import type { ModelDescriptor } from "@/lib/domain/models";
import { validateReferenceCapabilities } from "@/lib/domain/reference-policy";

const promptOnly: ModelDescriptor = {
  id: "provider:t2v", providerId: "provider", kind: "video", model: "t2v", label: "T2V",
};
const contextual: ModelDescriptor = {
  id: "provider:edit", providerId: "provider", kind: "image", model: "edit", label: "Edit",
  frameInput: { start: true, end: false },
  contextImages: { min: 1, max: 2 },
};

describe("validateReferenceCapabilities", () => {
  it("returns field-specific unsupported input violations", () => {
    expect(validateReferenceCapabilities(promptOnly, { start: true, end: true, contextCount: 1 }))
      .toEqual([
        { field: "startImage", message: "The selected model cannot use a start frame." },
        { field: "endImage", message: "The selected model cannot use an end frame." },
        { field: "referenceImage", message: "The selected model cannot use context reference images." },
      ]);
  });

  it("counts the start frame against the model context capacity", () => {
    expect(validateReferenceCapabilities(contextual, { start: true, end: false, contextCount: 2 }))
      .toEqual([{ field: "referenceImage", message: "The selected model accepts at most 2 context images including the start frame." }]);
  });

  it("rejects too few required context images", () => {
    expect(validateReferenceCapabilities(contextual, { start: false, end: false, contextCount: 0 }))
      .toEqual([{ field: "referenceImage", message: "The selected model requires at least 1 context image." }]);
  });
});

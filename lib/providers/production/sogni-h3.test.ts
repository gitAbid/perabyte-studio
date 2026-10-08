import { describe, expect, it } from "vitest";
import { acknowledgeH3Transport, h3ModeForModel, h3FrameCountLegal, checkH3Request, mapH3InputFields, timedKeyframesStatus, timedKeyframesSupported } from "./sogni-h3";

describe("Sogni H3 compatibility", () => {
  it("distinguishes first/last frame modes from Ref2VA and never infers R2V for FastH3", () => {
    expect(h3ModeForModel("minimax-h3-fl2va-fp8_i2v")).toBe("FL2VA");
    expect(h3ModeForModel("minimax-h3-fl2va-fp8_flf2v")).toBe("FLF2V");
    expect(h3ModeForModel("minimax-h3-ref2va-fp8_r2v")).toBe("Ref2VA");
    expect(h3ModeForModel("minimax-h3-fastvideo-int8_i2v_turbo")).toBe("FL2VA");
    expect(h3ModeForModel("minimax-h3-fastvideo-int8_i2v_turbo")).not.toBe("Ref2VA");
  });
  it("enforces 124 + 17n frame grid through 362", () => {
    expect(h3FrameCountLegal(124)).toBe(true);
    expect(h3FrameCountLegal(141)).toBe(true);
    expect(h3FrameCountLegal(142)).toBe(false);
    expect(h3FrameCountLegal(362)).toBe(true);
    expect(h3FrameCountLegal(363)).toBe(false);
  });
  it("enforces Ref2VA context image capacity without truncation", () => {
    const check = checkH3Request({ modelId: "minimax-h3-ref2va-fp8_r2v", startFrame: false, contextImages: 10, contextVideos: 0, contextAudios: 0, frameCount: 124, sdkVersion: "5.49.0" });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/capacity/i);
    const valid = checkH3Request({ modelId: "minimax-h3-ref2va-fp8_r2v", startFrame: false, contextImages: 9, contextVideos: 0, contextAudios: 0, frameCount: 124, sdkVersion: "5.49.0" });
    expect(valid.ok).toBe(true);
  });
  it("maps FL2VA end-only and two-endpoint requests to the SDK endpoint fields", () => {
    const endOnly = checkH3Request({ modelId: "minimax-h3-fl2va-fp8_i2v", startFrame: false, endFrame: true, contextImages: 0, contextVideos: 0, contextAudios: 0, frameCount: 124, sdkVersion: "5.49.0" });
    expect(endOnly.ok).toBe(true);
    expect(mapH3InputFields("minimax-h3-fl2va-fp8_i2v", [{ assetId: "last", role: "end_frame", required: true }])[0]).toMatchObject({ state: "mapped", providerField: "referenceImageEnd" });
    expect(mapH3InputFields("minimax-h3-fl2va-fp8_i2v", [
      { assetId: "first", role: "start_frame", required: true },
      { assetId: "last", role: "end_frame", required: true },
    ]).map(({ state, providerField }) => ({ state, providerField }))).toEqual([
      { state: "mapped", providerField: "referenceImage" },
      { state: "mapped", providerField: "referenceImageEnd" },
    ]);
  });
  it("rejects frame-anchor semantics on Ref2VA and preserves explicit context slot order", () => {
    const check = checkH3Request({ modelId: "minimax-h3-ref2va-fp8_r2v", startFrame: true, contextImages: 0, contextVideos: 0, contextAudios: 0, frameCount: 124, sdkVersion: "5.49.0" });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/frame.anchor/i);
    const mapped = mapH3InputFields("minimax-h3-ref2va-fp8_r2v", [
      { assetId: "anchor", role: "start_frame", required: true },
      { assetId: "picture-1", role: "context_image", required: true },
      { assetId: "picture-2", role: "context_image", required: true },
    ]);
    expect(mapped.map(({ state, providerField }) => ({ state, providerField }))).toEqual([
      { state: "rejected", providerField: null },
      { state: "mapped", providerField: "referenceImage" },
      { state: "mapped", providerField: "contextImages" },
    ]);
  });
  it("blocks timed keyframes until installed SDK support is verified", () => {
    expect(timedKeyframesSupported("5.49.0")).toBe(false);
    expect(timedKeyframesSupported("5.58.0")).toBe(true);
    expect(timedKeyframesSupported("5.58.0-beta.1")).toBe(false);
    expect(timedKeyframesSupported("unknown")).toBe(false);
    expect(timedKeyframesStatus("unknown")).toBe(null);
  });
  it("keeps conflicting resolutions unknown and rejects endpoint anchors on Ref2VA", () => {
    expect(checkH3Request({ modelId: "minimax-h3-ref2va-fp8_r2v", startFrame: true, endFrame: true, contextImages: 0, contextVideos: 0, contextAudios: 0, frameCount: 124, sdkVersion: "5.49.0" }).reason).toMatch(/end-frame/i);
    expect(checkH3Request({ modelId: "minimax-h3-fl2va-fp8_i2v", startFrame: true, contextImages: 0, contextVideos: 0, contextAudios: 0, frameCount: 124, sdkVersion: "5.49.0", requestedResolution: "2K", knownResolution: "1080p" }).reason).toMatch(/conflicting/i);
  });
  it("records field mapping separately from transport acknowledgement and visual adherence", () => {
    const inputs = mapH3InputFields("minimax-h3-fl2va-fp8_i2v", [
      { assetId: "anchor-1", role: "start_frame", required: true },
      { assetId: "ref-2", role: "canon_reference", required: true },
    ]);
    expect(inputs[0]).toMatchObject({ state: "mapped", providerField: "referenceImage" });
    expect(inputs[1]).toMatchObject({ state: "rejected", providerField: null });
    const receipt = { version: 1 as const, id: "receipt-1", jobId: "job-1", capabilityProvenance: "live_catalog" as const, capabilityObservedAt: 1, inputs, createdAt: 1 };
    const acknowledged = acknowledgeH3Transport(receipt, true);
    expect(acknowledged.inputs[0].state).toBe("acknowledged");
    expect(acknowledged.inputs[1].state).toBe("rejected");
    expect(JSON.stringify(acknowledged)).not.toMatch(/visual adherence: true/i);
  });
  it("keeps every required reference visible and rejects overflow explicitly", () => {
    const inputs = Array.from({ length: 10 }, (_, index) => ({ assetId: `ref-${index}`, role: "context_image", required: true }));
    const mapped = mapH3InputFields("minimax-h3-ref2va-fp8_r2v", inputs);
    expect(mapped).toHaveLength(10);
    expect(mapped.slice(0, 9).every((input) => input.state === "mapped")).toBe(true);
    expect(mapped[9]).toMatchObject({ required: true, state: "rejected", disclosedOmission: expect.stringMatching(/capacity/i) });
  });
});

import { describe, expect, it } from "vitest";
import { APPROVAL_CHECKLISTS, approvalCommandId } from "./approval";
import { hashCanonicalJson } from "./hash";

describe("production approval checklist requirements", () => {
  it("exposes the frozen required checklist IDs for every target kind", () => {
    expect(APPROVAL_CHECKLISTS).toEqual({
      canon: {
        character: ["identity", "wardrobe", "style", "reference_rights"],
        location: ["location", "style", "reference_rights"],
        prop: ["props", "style", "reference_rights"],
        style: ["style", "reference_rights"],
      },
      story: ["protagonist_goal", "cause_consequence_order", "earned_resolution", "plot_fidelity", "spoken_lines"],
      shotplan: ["beat_coverage", "spoken_lines", "canon_bindings", "duration_format", "plot_fidelity"],
      animatic: ["beat_coverage", "spoken_lines", "timing", "duration_format", "continuity"],
      anchor: ["identity", "wardrobe", "location", "props", "framing"],
      take: ["identity", "wardrobe", "location", "props", "intended_action", "motion_camera", "artifacts"],
      audio: ["spoken_lines", "intelligibility", "voice_consistency", "cue_timing", "music_sfx_rights", "no_truncation", "balance"],
    });
  });

  it("derives command IDs from the frozen operation and project key tuple", () => {
    const expected = `approval:${hashCanonicalJson({ schemaVersion: 1, operation: "human_approval", projectId: "project-a", idempotencyKey: "command-a" })}`;
    expect(approvalCommandId("project-a", "command-a")).toBe(expected);
  });
});

import { describe, expect, it } from "vitest";
import {
  GATE_PASS_THRESHOLD,
  gateInstruction,
  parseGateReply,
} from "@/lib/domain/keyframe-gate";

describe("parseGateReply", () => {
  it("parses a clean score with notes", () => {
    const score = parseGateReply(
      JSON.stringify({ identity: 0.9, outfit: 0.8, location: 0.7, notes: "matches the brief" }),
    );
    expect(score).toEqual({ identity: 0.9, outfit: 0.8, location: 0.7, notes: "matches the brief" });
  });

  it("parses fenced and prose-wrapped JSON", () => {
    const fenced = '```json\n{"identity":0.85,"outfit":0.9,"location":0.8,"notes":"ok"}\n```';
    expect(parseGateReply(fenced)?.identity).toBe(0.85);
    const prose = 'Sure! {"identity":0.85,"outfit":0.9,"location":0.8} hope that helps';
    expect(parseGateReply(prose)?.location).toBe(0.8);
  });

  it("returns null for junk or a missing identity score", () => {
    expect(parseGateReply("not json at all")).toBeNull();
    expect(parseGateReply('{"outfit":0.9,"location":0.9}')).toBeNull(); // no identity
    expect(parseGateReply('{"identity":"high","outfit":0.9,"location":0.9}')).toBeNull();
    expect(parseGateReply('{"identity":null,"outfit":0.9,"location":0.9}')).toBeNull();
  });

  it("accepts numeric-string scores", () => {
    const score = parseGateReply('{"identity":"0.9","outfit":"0.8","location":"0.7"}');
    expect(score?.identity).toBe(0.9);
    expect(score?.outfit).toBe(0.8);
    expect(score?.location).toBe(0.7);
  });

  it("clamps every score into 0..1", () => {
    const score = parseGateReply(
      JSON.stringify({ identity: 1.5, outfit: -0.2, location: 2, notes: "r".repeat(500) }),
    );
    expect(score?.identity).toBe(1);
    expect(score?.outfit).toBe(0);
    expect(score?.location).toBe(1);
    expect(score?.notes).toHaveLength(300);
  });

  it("defaults outfit and location to the identity score when absent", () => {
    expect(parseGateReply('{"identity":0.8,"notes":"person only"}')).toEqual({
      identity: 0.8,
      outfit: 0.8,
      location: 0.8,
      notes: "person only",
    });
    // A terse reply without notes stays a valid SceneScore.
    expect(parseGateReply('{"identity":0.8}')).toEqual({ identity: 0.8, outfit: 0.8, location: 0.8 });
  });
});

describe("gateInstruction", () => {
  it("embeds every expectation into the rubric", () => {
    const instruction = gateInstruction({
      identity: "Mara: late 20s, red curly hair, freckles",
      outfit: "olive field jacket",
      location: "rain-soaked harbor at dusk",
    });
    expect(instruction).toContain("Mara: late 20s, red curly hair, freckles");
    expect(instruction).toContain("olive field jacket");
    expect(instruction).toContain("rain-soaked harbor at dusk");
    expect(instruction).toContain("JSON");
  });

  it("scores absent outfit and location expectations as 1", () => {
    const instruction = gateInstruction({ identity: "Mara: red curly hair" });
    expect(instruction).toContain("no outfit was specified");
    expect(instruction).toContain("no location was specified");
  });
});

describe("GATE_PASS_THRESHOLD", () => {
  it("is the documented pass mark", () => {
    expect(GATE_PASS_THRESHOLD).toBe(0.7);
  });
});

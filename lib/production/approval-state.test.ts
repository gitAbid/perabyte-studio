import { describe, expect, it } from "vitest";
import { deriveApprovalState } from "./approval-state";

type DeriveInput = Parameters<typeof deriveApprovalState>[0];

const approved = { decision: "approved" } as const;
const rejected = { decision: "rejected" } as const;

describe("C8 approval state derivation", () => {
  it("derives approved only from an explicit approved decision", () => {
    expect(deriveApprovalState({ approval: approved })).toBe("approved");
  });

  it("keeps approved when a recommendation timestamp is also present", () => {
    expect(deriveApprovalState({ approval: approved, recommendedAt: 5_000 })).toBe("approved");
  });

  it("resets to draft on a rejected approval even when a recommendation exists", () => {
    expect(deriveApprovalState({ approval: rejected })).toBe("draft");
    expect(deriveApprovalState({ approval: rejected, recommendedAt: 5_000 })).toBe("draft");
  });

  it("derives recommended from recommendedAt alone", () => {
    expect(deriveApprovalState({ recommendedAt: 5_000 })).toBe("recommended");
  });

  it("falls back to draft when nothing is set", () => {
    expect(deriveApprovalState({})).toBe("draft");
    expect(deriveApprovalState({ approval: null })).toBe("draft");
    expect(deriveApprovalState({ recommendedAt: null })).toBe("draft");
    expect(deriveApprovalState({ approval: null, recommendedAt: null })).toBe("draft");
  });

  it("resets to draft on the rejected flag even when a recommendation exists", () => {
    expect(deriveApprovalState({ rejected: true })).toBe("draft");
    expect(deriveApprovalState({ rejected: true, recommendedAt: 5_000 })).toBe("draft");
  });

  it("never derives approved without an explicit approval record", () => {
    const consumptionShaped: DeriveInput[] = [
      {},
      { recommendedAt: 5_000 },
      { rejected: true, recommendedAt: 5_000 },
      { approval: null, recommendedAt: 5_000 },
    ];
    for (const input of consumptionShaped) {
      expect(deriveApprovalState(input), JSON.stringify(input)).not.toBe("approved");
    }
  });
});

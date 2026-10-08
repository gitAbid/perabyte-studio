import { describe, expect, it } from "vitest";
import { WorkspaceIsolationError, assertResolvedRefsWithinWorkspace } from "./workspace-isolation";

// Admission evidence: the workspace's own canon selections (C2) plus the optional allowances
// (pinned production snapshot ids and explicit per-job user picks). Allowed set = their union.
const workspace = {
  id: "workspace-1",
  characterCanonIds: ["char-canon-luna"],
  environmentCanonIds: ["env-canon-cafe"],
  styleCanonIds: ["style-canon-noir"],
};
const allowance = {
  productionSnapshot: ["charrev-luna-3", "envrev-cafe-1", "stylerev-noir-1"],
  explicitUserPicks: ["asset-prop-pocketwatch"],
};

function isolationFailureOf(resolvedReferenceIds: string[]): WorkspaceIsolationError {
  try {
    assertResolvedRefsWithinWorkspace(resolvedReferenceIds, workspace, allowance);
  } catch (error) {
    if (error instanceof WorkspaceIsolationError) return error;
    throw error;
  }
  throw new Error(`Expected the resolved references [${resolvedReferenceIds.join(", ")}] to fail workspace isolation`);
}

describe("C9 workspace isolation admission", () => {
  it("passes when every resolved ref sits in the selection, snapshot, or explicit picks", () => {
    expect(() =>
      assertResolvedRefsWithinWorkspace(
        ["char-canon-luna", "env-canon-cafe", "style-canon-noir", "charrev-luna-3", "envrev-cafe-1", "stylerev-noir-1", "asset-prop-pocketwatch"],
        workspace,
        allowance,
      ),
    ).not.toThrow();
  });

  it("passes for an empty resolved reference list", () => {
    expect(() => assertResolvedRefsWithinWorkspace([], workspace, allowance)).not.toThrow();
  });

  it("passes when a ref is only in the snapshot or the picks and not in the workspace selection", () => {
    expect(() => assertResolvedRefsWithinWorkspace(["stylerev-noir-1"], workspace, allowance)).not.toThrow();
    expect(() => assertResolvedRefsWithinWorkspace(["asset-prop-pocketwatch"], workspace, allowance)).not.toThrow();
  });

  it("throws WorkspaceIsolationError naming the offending id and that the job was not enqueued", () => {
    const error = isolationFailureOf(["charrev-luna-3", "asset-rogue-global"]);
    expect(error).toBeInstanceOf(Error);
    expect(error.offendingIds).toEqual(["asset-rogue-global"]);
    expect(error.message).toMatch(/asset-rogue-global/);
    expect(error.message).toMatch(/not enqueued/);
  });

  it("names every offending id, deduplicated in input order, when several refs fall outside", () => {
    const error = isolationFailureOf(["charrev-luna-3", "asset-rogue-global", "asset-rogue-import", "asset-rogue-global"]);
    expect(error.offendingIds).toEqual(["asset-rogue-global", "asset-rogue-import"]);
    expect(error.message).toMatch(/asset-rogue-global/);
    expect(error.message).toMatch(/asset-rogue-import/);
  });

  it("does not accept a ref that merely resembles an allowed one", () => {
    expect(isolationFailureOf(["charrev-luna-4"]).offendingIds).toEqual(["charrev-luna-4"]);
    expect(isolationFailureOf(["envrev-cafe-1-extra"]).offendingIds).toEqual(["envrev-cafe-1-extra"]);
  });
});

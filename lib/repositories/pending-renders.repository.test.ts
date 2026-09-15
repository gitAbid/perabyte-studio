import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPendingRender,
  listPendingRenders,
  removePendingRender,
  resetPendingRendersForTests,
  setPendingRendersPathForTests,
  updatePendingRender,
} from "./pending-renders.repository";

describe("pending-renders.repository", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pending-renders-test-"));
    setPendingRendersPathForTests(join(dir, "pending.json"));
  });

  afterEach(() => {
    setPendingRendersPathForTests(null);
    resetPendingRendersForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds, lists, updates and removes records", () => {
    const record = addPendingRender({
      provider: "sogni",
      kind: "video",
      modelId: "m",
      prompt: "p",
      clientTag: "s_1:sc_2",
    });
    expect(record.status).toBe("detached");
    expect(listPendingRenders()).toHaveLength(1);

    updatePendingRender(record.id, {
      status: "recovered",
      media: { url: "/api/media?f=x.mp4", mime: "video/mp4" },
    });
    expect(listPendingRenders()[0].status).toBe("recovered");
    expect(listPendingRenders()[0].media?.mime).toBe("video/mp4");

    removePendingRender(record.id);
    expect(listPendingRenders()).toHaveLength(0);
  });

  it("persists across cache resets, like a server reload", () => {
    const record = addPendingRender({
      provider: "sogni",
      kind: "image",
      modelId: "m",
      prompt: "p",
    });
    resetPendingRendersForTests();
    expect(listPendingRenders().map((r) => r.id)).toEqual([record.id]);
  });

  it("drops a malformed file to an empty registry", () => {
    writeFileSync(join(dir, "pending.json"), "{broken", "utf-8");
    resetPendingRendersForTests();
    expect(listPendingRenders()).toEqual([]);
  });

  it("keeps unrelated fields intact when updating one record", () => {
    const a = addPendingRender({ provider: "sogni", kind: "video", modelId: "m", prompt: "a" });
    const b = addPendingRender({
      provider: "apikey-fan",
      kind: "video",
      modelId: "m",
      prompt: "b",
      clientTag: "s_9:sc_1",
    });

    markFailedViaUpdate(b.id);

    const records = listPendingRenders();
    expect(records.find((r) => r.id === a.id)?.status).toBe("detached");
    expect(records.find((r) => r.id === b.id)?.status).toBe("failed");
    expect(records.find((r) => r.id === b.id)?.clientTag).toBe("s_9:sc_1");
  });

  function markFailedViaUpdate(id: string) {
    updatePendingRender(id, { status: "failed", note: "relay job expired" });
  }
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { putStoryAsset, storyExistsOnServer } from "@/lib/story/records";
import type { Asset } from "@/lib/types";

const story: Asset = {
  id: "s_test_1",
  kind: "story",
  title: "test",
  prompt: "a fox",
  url: "",
  variants: [],
  settings: { kind: "image" } as Asset["settings"],
  createdAt: 1,
  favorite: false,
  mode: "Story Mode",
  scenes: [
    { id: "sc_1", prompt: "a fox", url: null, status: "queued", kind: "image" },
  ],
  meta: { continuity: true, running: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("putStoryAsset", () => {
  it("POSTs the asset serialized as JSON to /api/assets", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ asset: story }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ok = await putStoryAsset(story);

    expect(ok).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ];
    expect(call[0]).toBe("/api/assets");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ id: "s_test_1", kind: "story" });
  });

  it("returns false when the service rejects the record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    await expect(putStoryAsset(story)).resolves.toBe(false);
  });

  it("returns false when the service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(putStoryAsset(story)).resolves.toBe(false);
  });
});

describe("storyExistsOnServer", () => {
  it("returns true when the story record exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ story }), { status: 200 })),
    );
    await expect(storyExistsOnServer("s_test_1")).resolves.toBe(true);
  });

  it("returns false only on a definitive 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(storyExistsOnServer("s_gone")).resolves.toBe(false);
  });

  it("treats a server error as indeterminate (not missing)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    await expect(storyExistsOnServer("s_test_1")).resolves.toBe(true);
  });

  it("treats an outage as indeterminate (not missing)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(storyExistsOnServer("s_test_1")).resolves.toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { loadVoicesStore, mergeVoicesStore, resolveVoicesStorePath, saveVoicesStore } from "./server-store";
import type { VoicesStoreV1 } from "./read-model";

const store: VoicesStoreV1 = {
  version: 1,
  voices: [{ id: "voice-1", name: "narrator", origin: "vault", mime: "audio/wav", byteSize: 128, durationSeconds: 2.5, rightsStatus: "creator_attested", source: "studio import", importedAt: 10 }],
  bindings: { "char-luna": { voiceId: "voice-1", locked: true, boundAt: 20 } },
};

describe("server voice store (C16)", () => {
  it("round-trips a store through the JSON file", async ({}) => {
    const dataDir = `.studio-test-voices-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await saveVoicesStore(store, { dataDir });
    const loaded = await loadVoicesStore({ dataDir });
    expect(loaded).toEqual(store);
  });

  it("reads an empty store when no file exists and fails closed on a corrupt file", async () => {
    const dataDir = `.studio-test-voices-empty-${Date.now()}`;
    expect(await loadVoicesStore({ dataDir })).toEqual({ version: 1, voices: [], bindings: {} });
    await saveVoicesStore(store, { dataDir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolveVoicesStorePath({ dataDir }), "{ not json");
    const corrupt = await loadVoicesStore({ dataDir });
    expect(corrupt).toEqual({ version: 1, voices: [], bindings: {} });
  });

  it("merges a browser snapshot: server rows win on voice conflict, latest binding wins per character", () => {
    const remote: VoicesStoreV1 = {
      version: 1,
      voices: [
        { id: "voice-1", name: "STALE browser copy", origin: "browser", mime: "audio/wav", byteSize: null, durationSeconds: null, rightsStatus: "creator_attested", source: "browser", importedAt: 1 },
        { id: "voice-2", name: "fresh browser voice", origin: "browser", mime: "audio/mpeg", byteSize: null, durationSeconds: null, rightsStatus: "creator_attested", source: "browser", importedAt: 2 },
      ],
      bindings: { "char-luna": { voiceId: "voice-2", locked: false, boundAt: 99 }, "char-other": { voiceId: "voice-2", locked: true, boundAt: 3 } },
    };
    const merged = mergeVoicesStore(store, remote);
    expect(merged.voices.find((voice) => voice.id === "voice-1")?.name).toBe("narrator");
    expect(merged.voices.map((voice) => voice.id).sort()).toEqual(["voice-1", "voice-2"]);
    expect(merged.bindings["char-luna"]).toEqual({ voiceId: "voice-2", locked: false, boundAt: 99 });
    expect(merged.bindings["char-other"]?.voiceId).toBe("voice-2");
  });
});

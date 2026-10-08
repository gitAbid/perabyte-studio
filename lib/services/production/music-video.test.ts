import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openProductionStore, type SqliteProductionStore } from "../../repositories/production/sqlite";
import { analyzeSections, createMusicVideoStory, sectionTargetFrames } from "./music-video";
import { createProject } from "./revisions";

function storeFixture(): SqliteProductionStore {
  return openProductionStore({ dataDir: mkdtempSync(join(tmpdir(), "mvm-")) });
}

const sha = (seed: string) => seed.padEnd(64, "0").slice(0, 64);

function songFixture(store: SqliteProductionStore, projectId: string, overrides: { rightsStatus?: string; audioSamples?: number | null; mime?: string } = {}) {
  const asset = {
    version: 1 as const,
    id: "song-asset-1",
    kind: "audio" as const,
    mime: overrides.mime ?? "audio/mpeg",
    byteSize: 1000,
    audioSamples: overrides.audioSamples === undefined ? 48_000 * 90 : overrides.audioSamples, // 90 s
    sourceKind: "upload" as const,
    sourceJobId: null,
    vaultRef: "fixtures/song.mp3",
    sha256: sha("song"),
    width: null,
    height: null,
    frames: null,
    fps: null,
    rightsStatus: (overrides.rightsStatus ?? "creator_attested") as "creator_attested",
    importProvenance: { source: "studio import", rightsAttestation: "own song", actorId: "local_creator", createdAt: 1 },
    createdAt: 1,
  };
  store.transaction((tx) => tx.insertAsset({ asset, verifiedAt: 1, checksumVerified: true }));
  return asset;
}

function projectFixture(store: SqliteProductionStore): { projectId: string; canonIds: string[] } {
  const project = createProject(store, { name: "MVM Fixture", profileId: "storybook-short-v1" }, { idFactory: () => `proj-${Math.random().toString(36).slice(2, 8)}` });
  store.transaction((tx) => {
    tx.insertCanonRevision({ version: 1, id: "rev-loc", entityId: "stage", entityKind: "location", revision: 1, description: "A neon stage", attributes: {}, referenceAssetIds: [], contentHash: sha("loc"), createdAt: 1 });
    tx.insertCanonRevision({ version: 1, id: "rev-style", entityId: "look", entityKind: "style", revision: 1, description: "Neon wash", attributes: {}, referenceAssetIds: [], contentHash: sha("style"), createdAt: 1 });
    tx.compareAndSetProject({ ...project, activeCanonRevisionIds: ["rev-loc", "rev-style"], saveVersion: project.saveVersion + 1 }, project.saveVersion);
  });
  return { projectId: project.id, canonIds: ["rev-loc", "rev-style"] };
}

describe("music video mode (spec 18, M6-3)", () => {
  it("splits the song into deterministic sections and derives song-driven frame counts", () => {
    const sections = analyzeSections(90_000, 6, "Neon rain intro");
    expect(sections.map((section) => section.durationMs)).toEqual([15_000, 15_000, 15_000, 15_000, 15_000, 15_000]);
    expect(sections[0]!.label).toBe("Neon rain intro");
    expect(sections[0]!.startMs).toBe(0);
    expect(sections[5]!.startMs).toBe(75_000);
    expect(sectionTargetFrames(sections[0]!)).toBe(24 * 15);
  });

  it("creates an ORDINARY story revision whose beats are the sections (no separate model)", () => {
    const store = storeFixture();
    const { projectId, canonIds } = projectFixture(store);
    songFixture(store, projectId);
    const result = createMusicVideoStory(store, {
      projectId, expectedStoryRevisionId: null, songAssetId: "song-asset-1", sectionCount: 4, canonRevisionIds: canonIds,
    });
    expect(result.songDurationMs).toBe(90_000);
    expect(result.sections).toHaveLength(4);
    expect(result.storyRevision.beats.map((beat) => beat.action)).toEqual(["Section 1", "Section 2", "Section 3", "Section 4"]);
    expect(result.storyRevision.beats.every((beat) => beat.narration === "" && beat.dialogue.length === 0)).toBe(true);
    expect(result.targetFrames).toEqual([540, 540, 540, 540]);
    store.close();
  });

  it("manual section markers replace the analysis wholesale", () => {
    const store = storeFixture();
    const { projectId, canonIds } = projectFixture(store);
    songFixture(store, projectId);
    const result = createMusicVideoStory(store, {
      projectId, expectedStoryRevisionId: null, songAssetId: "song-asset-1",
      sections: [{ label: "Intro", durationMs: 10_000 }, { label: "Drop", durationMs: 20_000 }],
      canonRevisionIds: canonIds,
    });
    expect(result.sections.map((section) => [section.label, section.startMs])).toEqual([["Intro", 0], ["Drop", 10_000]]);
    expect(result.targetFrames).toEqual([240, 480]);
    store.close();
  });

  it("refuses undeclared rights and unmeasurable audio, and enforces story-version currency", () => {
    const store = storeFixture();
    const { projectId, canonIds } = projectFixture(store);
    songFixture(store, projectId, { rightsStatus: "unknown" });
    expect(() => createMusicVideoStory(store, { projectId, expectedStoryRevisionId: null, songAssetId: "song-asset-1", sectionCount: 3, canonRevisionIds: canonIds }))
      .toThrowError(/rights are undeclared/);
    const unmeasured = { ...store.read.getAsset("song-asset-1")!, id: "song-asset-2", rightsStatus: "licensed" as const, audioSamples: null };
    store.transaction((tx) => tx.insertAsset({ asset: unmeasured, verifiedAt: 1, checksumVerified: true }));
    expect(() => createMusicVideoStory(store, { projectId, expectedStoryRevisionId: null, songAssetId: "song-asset-2", sectionCount: 3, canonRevisionIds: canonIds }))
      .toThrowError(/no decoded duration/);
    expect(() => createMusicVideoStory(store, { projectId, expectedStoryRevisionId: "story-gone", songAssetId: "song-asset-1", sectionCount: 3, canonRevisionIds: canonIds }))
      .toThrowError(/stale/);
    store.close();
  });
});

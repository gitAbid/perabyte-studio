import { describe, expect, it } from "vitest";
import {
  AssetSchema, AudioMixRevisionSchema, StoryRevisionSchema, type Asset, type AudioCue,
  type ProjectReadModel, type StoryRevision,
} from "./contracts";
import { buildAudioCue } from "./audio";
import {
  clampCueDraft, DEFAULT_MIX_SETTINGS, deriveCueSaveReadiness, deriveMixCatalog,
  deriveStaleNarrationNotices, deriveTimelineView, deriveUploadOutcome, rightsStatusOptions,
  samplesToDisplayTime, type CatalogEntry, type CueDraft, type SaveReadinessContext,
} from "@/components/production/audio";

/* Fixtures are parsed through the accepted zod schemas so the tests cannot drift from the contracts. */
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const asset = (overrides: Partial<Asset> = {}): Asset => AssetSchema.parse({
  version: 1, id: `audio-asset-${SHA_A}`, sha256: SHA_A, mime: "audio/wav", byteSize: 192_044, vaultRef: "vault_ref_1",
  width: null, height: null, frames: null, fps: null, audioSamples: 48_000, sourceKind: "upload", sourceJobId: null,
  rightsStatus: "creator_attested",
  importProvenance: { source: "Local studio session", rightsAttestation: "Recorded by the creator.", actorId: "local_creator", createdAt: 1 },
  createdAt: 1, ...overrides,
});
const story = (id: string, narration: string): StoryRevision => StoryRevisionSchema.parse({
  version: 1, id, projectId: "proj_1", parentRevisionId: null, scriptText: narration,
  beats: [
    { id: "beat_opening", action: "The window opens.", narration, dialogue: [{ characterId: "ch_ada", text: "Hello there." }], order: 0 },
    { id: "beat_closing", action: "The film closes.", narration: "The narrator closes the film.", dialogue: [], order: 1 },
  ],
  canonRevisionIds: [], contentHash: SHA_B, createdAt: 1,
});
const mixRevision = (cues: AudioCue[], storyRevisionId = "story_v1"): ReturnType<typeof AudioMixRevisionSchema.parse> => AudioMixRevisionSchema.parse({
  version: 1, id: "audio-mix-x", projectId: "proj_1", storyRevisionId, cues,
  mixSettings: { ...DEFAULT_MIX_SETTINGS }, contentHash: SHA_B, createdAt: 1,
});
const cue = (overrides: Partial<AudioCue>): AudioCue => ({
  id: "cue_a", assetId: `audio-asset-${SHA_A}`, sourceStartSample: 0, sourceEndSample: 48_000, timelineStartSample: 0,
  gainDb: 0, role: "narration", scriptSegmentId: "beat_opening", sourceText: "The narrator opens the film.",
  sourceRights: "creator_attested", ...overrides,
});
const draft = (overrides: Partial<CueDraft> & { key: string }): CueDraft => ({
  fromMixId: null, assetId: `audio-asset-${SHA_A}`, role: "narration", timelineStartSample: 0, sourceStartSample: 0,
  sourceEndSample: 48_000, gainDb: 0, scriptSegmentId: "beat_opening", sourceText: "The narrator opens the film.",
  sourceRights: "creator_attested", delivery: "auto" as const, voiceId: null, ...overrides,
});
const sessionCatalog = (assets: Asset[]): CatalogEntry[] => deriveMixCatalog(null, assets);
const context = (overrides: Partial<SaveReadinessContext> = {}): SaveReadinessContext => ({
  projectId: "proj_1", activeStoryRevisionId: "story_v1", audioMixVersion: 0, storyRevision: story("story_v1", "The narrator opens the film."),
  animaticTotalSamples: null, ...overrides,
});

describe("C10-PRE upload outcome is fail-closed (never blank-success)", () => {
  const goodAsset = asset();

  it("accepts a 2xx response only when the body parses as an Asset", () => {
    const outcome = deriveUploadOutcome(201, { asset: goodAsset });
    expect(outcome.phase).toBe("ready");
    if (outcome.phase === "ready") expect(outcome.asset.id).toBe(goodAsset.id);
    expect(deriveUploadOutcome(200, { asset: goodAsset }).phase).toBe("ready");
  });

  it("fails a 400 INVALID_INPUT envelope with code, message and requestId", () => {
    const outcome = deriveUploadOutcome(400, { error: { code: "INVALID_INPUT", message: "A multipart form with one media file and source/rights fields is required.", retryable: false }, requestId: "req-400" });
    expect(outcome.phase).toBe("failed");
    if (outcome.phase === "failed") {
      expect(outcome.message).toContain("INVALID_INPUT");
      expect(outcome.message).toContain("requestId req-400");
      expect(outcome.message.length).toBeGreaterThan(20);
    }
  });

  it("maps 413 and 422 MEDIA_UNAVAILABLE to actionable text", () => {
    const oversize = deriveUploadOutcome(413, { error: { code: "INVALID_INPUT", message: "Media upload exceeds the allowed size.", retryable: false }, requestId: "req-413" });
    expect(oversize.phase).toBe("failed");
    if (oversize.phase === "failed") {
      expect(oversize.message).toContain("INVALID_INPUT");
      expect(oversize.message).toContain("requestId req-413");
      expect(oversize.message).toMatch(/100 ?MB|size|smaller/i);
    }
    const undecodable = deriveUploadOutcome(422, { error: { code: "MEDIA_UNAVAILABLE", message: "Uploaded media could not be decoded and verified.", retryable: false }, requestId: "req-422" });
    expect(undecodable.phase).toBe("failed");
    if (undecodable.phase === "failed") {
      expect(undecodable.message).toContain("MEDIA_UNAVAILABLE");
      expect(undecodable.message).toContain("requestId req-422");
      expect(undecodable.message).toMatch(/48|WAV|PCM/i);
    }
  });

  it("fails a network failure sentinel and an unparseable 200 body without an asset", () => {
    const network = deriveUploadOutcome(null, undefined);
    expect(network.phase).toBe("failed");
    if (network.phase === "failed") expect(network.message).toMatch(/network error/i);
    for (const body of [undefined, "ok", {}, { asset: null }, { asset: { id: "nope" } }]) {
      const outcome = deriveUploadOutcome(200, body);
      expect(outcome.phase).toBe("failed");
      if (outcome.phase === "failed") expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it("offers exactly the three rights statuses the import route accepts", () => {
    expect([...rightsStatusOptions]).toEqual(["creator_attested", "licensed", "public_domain"]);
  });
});

describe("C10-PRE cue placement, trim and gain derive a valid save command", () => {
  const baseDrafts = (): CueDraft[] => [
    draft({ key: "draft-1", role: "narration", scriptSegmentId: "beat_opening", sourceText: "The narrator opens the film.", sourceEndSample: 48_000 }),
    draft({ key: "draft-2", role: "music", scriptSegmentId: null, sourceText: null, timelineStartSample: 48_000, sourceStartSample: 0, sourceEndSample: 24_000, gainDb: -3 }),
  ];
  const readyContext = context();

  it("derives a command whose cues pass the accepted buildAudioCue", () => {
    const result = deriveCueSaveReadiness(baseDrafts(), sessionCatalog([asset()]), readyContext);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.projectId).toBe("proj_1");
      expect(result.command.expectedAudioVersion).toBe(0);
      expect(result.command.expectedStoryRevisionId).toBe("story_v1");
      expect(result.command.mixSettings).toEqual(DEFAULT_MIX_SETTINGS);
      expect(result.command.cues).toHaveLength(2);
      result.command.cues.forEach((cueInput, ordinal) => {
        expect(() => buildAudioCue({ ...cueInput, assetAudioSamples: 48_000 }, ordinal)).not.toThrow();
        expect(Object.keys(cueInput)).not.toContain("id");
      });
    }
  });

  it("accepts gain boundaries -60 and 12 and rejects 12.5", () => {
    for (const gainDb of [-60, 12]) {
      const result = deriveCueSaveReadiness(baseDrafts().map((row) => ({ ...row, gainDb })), sessionCatalog([asset()]), readyContext);
      expect(result.ok).toBe(true);
    }
    const rejected = deriveCueSaveReadiness(baseDrafts().map((row) => ({ ...row, gainDb: 12.5 })), sessionCatalog([asset()]), readyContext);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issues.some((issue) => issue.kind === "GAIN" && /-60 and 12/.test(issue.message))).toBe(true);
  });

  it("clamps a trim so source start stays before source end within the asset samples", () => {
    const clamped = clampCueDraft(draft({ key: "d", sourceStartSample: 47_000, sourceEndSample: 99_000 }), 48_000);
    expect(clamped.sourceStartSample).toBeLessThan(clamped.sourceEndSample);
    expect(clamped.sourceEndSample).toBe(48_000);
    const reversed = clampCueDraft(draft({ key: "d", sourceStartSample: 47_999, sourceEndSample: 47_999 }), 48_000);
    expect(reversed.sourceStartSample).toBe(47_999);
    expect(reversed.sourceEndSample).toBe(48_000);
  });

  it("keeps a recovered-asset draft inside its known maximum and rejects new cues on recovered assets", () => {
    const recovered: CatalogEntry[] = [{ assetId: `audio-asset-${SHA_A}`, asset: null, provenance: null, maxKnownSamples: 24_000, sourceRights: "creator_attested" }];
    const continuation = deriveCueSaveReadiness([draft({ key: "draft-1", fromMixId: "cue_a", sourceEndSample: 24_000, role: "music", scriptSegmentId: null, sourceText: null })], recovered, readyContext);
    expect(continuation.ok).toBe(true);
    const extended = deriveCueSaveReadiness([draft({ key: "draft-1", fromMixId: "cue_a", sourceEndSample: 96_000, role: "music", scriptSegmentId: null, sourceText: null })], recovered, readyContext);
    expect(extended.ok).toBe(false);
    if (!extended.ok) expect(extended.issues.map((issue) => issue.message).join(" ")).toContain("24000");
    const fresh = deriveCueSaveReadiness([draft({ key: "draft-1", fromMixId: null, role: "music", scriptSegmentId: null, sourceText: null, sourceEndSample: 24_000 })], recovered, readyContext);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.issues.some((issue) => issue.kind === "MISSING_ASSET")).toBe(true);
  });

  it("is deterministic for identical inputs", () => {
    const first = deriveCueSaveReadiness(baseDrafts(), sessionCatalog([asset()]), readyContext);
    const second = deriveCueSaveReadiness(baseDrafts(), sessionCatalog([asset()]), readyContext);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("C10-PRE duration overflow is actionable", () => {
  it("blocks a source end beyond the asset samples, naming the cue and both counts", () => {
    const result = deriveCueSaveReadiness([draft({ key: "draft-9", sourceEndSample: 96_000, role: "music", scriptSegmentId: null, sourceText: null })], sessionCatalog([asset()]), context());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.kind === "SOURCE_RANGE");
      expect(issue?.cueKey).toBe("draft-9");
      expect(issue?.message).toContain("96000");
      expect(issue?.message).toContain("48000");
      expect(issue?.message).toContain("2.000s");
      expect(issue?.message).toContain("1.000s");
    }
  });

  it("blocks one sample past the animatic bound and passes exactly at it", () => {
    const animatic = context({ animaticTotalSamples: 48_000 });
    const atBound = deriveCueSaveReadiness([draft({ key: "draft-1", role: "music", scriptSegmentId: null, sourceText: null, timelineStartSample: 0, sourceEndSample: 48_000 })], sessionCatalog([asset()]), animatic);
    expect(atBound.ok).toBe(true);
    const past = deriveCueSaveReadiness([draft({ key: "draft-1", role: "music", scriptSegmentId: null, sourceText: null, timelineStartSample: 1, sourceEndSample: 48_000 })], sessionCatalog([asset()]), animatic);
    expect(past.ok).toBe(false);
    if (!past.ok) {
      const issue = past.issues.find((entry) => entry.kind === "OVERFLOW");
      expect(issue?.cueKey ?? "").toMatch(/^cue-/);
      expect(issue?.message).toContain("48001");
      expect(issue?.message).toContain("48000");
      expect(issue?.message.match(/\d+\.\d{3}s/g)?.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("does not evaluate the animatic tier without an animatic", () => {
    const result = deriveCueSaveReadiness([draft({ key: "draft-1", role: "music", scriptSegmentId: null, sourceText: null, timelineStartSample: 5_000_000, sourceEndSample: 48_000 })], sessionCatalog([asset()]), context({ animaticTotalSamples: null }));
    expect(result.ok).toBe(true);
  });

  it("renders sample counts as integer seconds with three fractional digits", () => {
    expect(samplesToDisplayTime(0)).toBe("0.000s");
    expect(samplesToDisplayTime(48_000)).toBe("1.000s");
    expect(samplesToDisplayTime(48_001)).toBe("1.001s");
    expect(samplesToDisplayTime(72_000)).toBe("1.500s");
    expect(samplesToDisplayTime(96_000)).toBe("2.000s");
    expect(samplesToDisplayTime(168_000)).toBe("3.500s");
  });
});

describe("C10-PRE stale narration is visible and alignment reuses the accepted validator", () => {
  const alignedCue = cue({});
  const currentMix = mixRevision([alignedCue]);

  it("names both revisions when the mix is pinned to a previous story revision", () => {
    const readModel = { schemaVersion: 2, dependencyIssues: [], audioMixRevision: mixRevision([alignedCue], "story_v1"), storyRevision: story("story_v2", "A rewritten opening line.") } as unknown as ProjectReadModel;
    const notices = deriveStaleNarrationNotices(readModel);
    const pinned = notices.find((notice) => notice.code === "MIX_STORY_PINNED");
    expect(pinned?.message).toContain("audio-mix-x");
    expect(pinned?.message).toContain("story_v1");
    expect(pinned?.message).toContain("story_v2");
    expect(notices.some((notice) => notice.code === "STALE_STORY")).toBe(true);
  });

  it("deduplicates audio dependency issues into ordered notices", () => {
    const issue = { targetKind: "audio", targetId: "audio-mix-x", dependencyKind: "story", pinnedDependencyId: "story_v1", activeDependencyId: "story_v2", code: "STORY_CHANGED" };
    const readModel = { schemaVersion: 2, dependencyIssues: [issue, issue], audioMixRevision: null, storyRevision: story("story_v2", "Rewritten.") } as unknown as ProjectReadModel;
    const notices = deriveStaleNarrationNotices(readModel);
    const dependencyRows = notices.filter((notice) => notice.code === "DEPENDENCY");
    expect(dependencyRows).toHaveLength(1);
    expect(dependencyRows[0]?.message).toContain("Audio mix audio-mix-x is stale");
  });

  it("surfaces UNKNOWN_SEGMENT and TEXT_DRIFT per cue", () => {
    const staleMix = mixRevision([
      cue({ id: "cue_null", scriptSegmentId: null }),
      cue({ id: "cue_ghost", scriptSegmentId: "beat_ghost" }),
      cue({ id: "cue_drift", sourceText: "One drifted character." }),
    ], "story_v1");
    const readModel = { schemaVersion: 2, dependencyIssues: [], audioMixRevision: staleMix, storyRevision: story("story_v1", "The narrator opens the film.") } as unknown as ProjectReadModel;
    const notices = deriveStaleNarrationNotices(readModel);
    expect(notices.filter((notice) => notice.code === "UNKNOWN_SEGMENT").map((notice) => notice.cueId)).toEqual(["cue_null", "cue_ghost"]);
    expect(notices.find((notice) => notice.code === "TEXT_DRIFT")?.cueId).toBe("cue_drift");
  });

  it("returns no notices for a fully aligned current mix", () => {
    const readModel = { schemaVersion: 2, dependencyIssues: [], audioMixRevision: currentMix, storyRevision: story("story_v1", "The narrator opens the film.") } as unknown as ProjectReadModel;
    expect(deriveStaleNarrationNotices(readModel)).toEqual([]);
  });

  it("returns ALIGNMENT issues for drifting save drafts", () => {
    const result = deriveCueSaveReadiness([draft({ key: "draft-1", sourceText: "The narrator opens the film!" })], sessionCatalog([asset()]), context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.kind === "ALIGNMENT" && issue.cueKey !== null)).toBe(true);
  });
});

describe("C10-PRE catalog, provenance display and timeline view degrade honestly", () => {
  const recoveredCue = cue({ id: "cue_r", assetId: `audio-asset-${SHA_B}`, sourceEndSample: 24_000, role: "music", scriptSegmentId: null, sourceText: null, timelineStartSample: 48_000 });

  it("unions session assets with active-mix cue assets and marks recovery provenance null", () => {
    const session = asset();
    expect(deriveMixCatalog(null, [session])).toEqual([
      { assetId: session.id, asset: session, provenance: "session", maxKnownSamples: 48_000, sourceRights: "creator_attested" },
    ]);
    const catalog = deriveMixCatalog({ audioMixRevision: mixRevision([recoveredCue]) } as unknown as ProjectReadModel, [session]);
    expect(catalog).toHaveLength(2);
    const recovered = catalog.find((entry) => entry.assetId === `audio-asset-${SHA_B}`);
    expect(recovered).toEqual({ assetId: `audio-asset-${SHA_B}`, asset: null, provenance: null, maxKnownSamples: 24_000, sourceRights: "creator_attested" });
    const merged = deriveMixCatalog({ audioMixRevision: mixRevision([recoveredCue, cue({ id: "cue_s", timelineStartSample: 1_000 })]) } as unknown as ProjectReadModel, [session]);
    expect(merged.find((entry) => entry.assetId === session.id)?.provenance).toBe("session");
    expect(merged).toHaveLength(2);
  });

  it("serializes the active mix in stable order with the session provenance per row", () => {
    const session = asset();
    const view = deriveTimelineView(mixRevision([recoveredCue, cue({ id: "cue_s", timelineStartSample: 1_000 })]), deriveMixCatalog(null, [session]));
    expect(view?.rows.map((row) => row.id)).toEqual(["cue_s", "cue_r"]);
    expect(view?.totalEndSample).toBe(72_000);
    expect(view?.rows.find((row) => row.id === "cue_r")?.provenance).toBe("recovered");
    expect(view?.rows.find((row) => row.id === "cue_s")?.provenance).toBe("session");
  });

  it("degrades to no timeline view for a mix that violates the accepted overlap policy", () => {
    const overlapping = mixRevision([
      cue({ id: "cue_a", role: "narration" }),
      cue({ id: "cue_b", role: "dialogue", scriptSegmentId: null, sourceText: null }),
    ]);
    expect(deriveTimelineView(overlapping, [])).toBeNull();
    expect(deriveTimelineView(null, [])).toBeNull();
  });
});

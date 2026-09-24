import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type { GeneratedArtifact, ImageProvider, JobPollResult } from "@/lib/providers/types";
import { logger } from "@/lib/logging/logger";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
} from "@/lib/repositories/provider-config.repository";
import { setAssetsPathForTests } from "@/lib/repositories/assets.repository";
import {
  getStoriesRepository,
  putStoryRepository,
  setStoriesPathForTests,
} from "@/lib/repositories/stories.repository";
import {
  putCharacterRepository,
  setCharactersPathForTests,
} from "@/lib/repositories/characters.repository";
import {
  putLocationRepository,
  setLocationsPathForTests,
} from "@/lib/repositories/locations.repository";
import { setJobsPathForTests, type JobRecord } from "@/lib/repositories/jobs.repository";
import { DEFAULT_CHARACTER_SPEC } from "@/lib/character";
import { JobExecutor } from "@/lib/jobs/executor";

/**
 * Keyframe absorb (k_ tags): the executor's gate → retry → animate decision
 * loop, with the frame exporter and the vision gate stubbed at the module
 * boundary — the absorb decisions under test are orchestration.
 */

const FRAME_REF = `${"a".repeat(60)}1234.png`;

const frameServer = vi.hoisted(() => ({
  deriveEndFrameRefServerSide: vi.fn(async () => `${"a".repeat(60)}1234.png`),
}));
vi.mock("@/lib/media/frame-server", () => frameServer);

type StoredScore = { identity: number; outfit: number; location: number; passed?: boolean };
const gate = vi.hoisted(() => ({
  scoreKeyframeRef: vi.fn(
    async (_ref: unknown, _expectations: unknown): Promise<{ verdict: Record<string, unknown> | null; source: string }> => ({
      verdict: { identity: 0.95, outfit: 0.9, location: 0.9, passed: true },
      source: "vision",
    }),
  ),
}));
vi.mock("@/lib/services/keyframe-gate.service", () => gate);

const advance = vi.hoisted(() => ({
  advanceStoryChain: vi.fn(async () => undefined),
  advanceSceneAfterKeyframe: vi.fn(async () => undefined),
  storyCast: (story: { meta?: { characterIds?: unknown } }) => {
    const ids = Array.isArray(story.meta?.characterIds) ? (story.meta!.characterIds as string[]) : [];
    const rows = (ids.includes("ch_1")
      ? [{
          id: "ch_1",
          name: "Mara",
          spec: { ...DEFAULT_CHARACTER_SPEC, age: 30 },
          identity: { front: `${"b".repeat(60)}aaaa.png` },
          createdAt: 1,
          updatedAt: 1,
        }]
      : []);
    return rows;
  },
}));
vi.mock("@/lib/story/server-runner", () => advance);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const MEDIA = [
  { id: "m_1", url: "/api/media?f=fake.png", width: 640, height: 640, seed: 42, mime: "image/png" },
];

function artifact(): GeneratedArtifact {
  return { bytes: PNG, url: null, ext: "png", seed: 42 };
}

function makeJob(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_kf",
    provider: "sogni",
    kind: "image",
    modelId: "sogni:qwen_image_edit_2511",
    request: { kind: "image", prompt: "kf" },
    status: "queued",
    clientTag: "k_s_kf:sc1",
    createdAt: 1,
    ...over,
  };
}

function anchorStory(): void {
  putCharacterRepository({
    id: "ch_1",
    name: "Mara",
    spec: { ...DEFAULT_CHARACTER_SPEC, age: 30 },
    identity: { front: `${"b".repeat(60)}aaaa.png` },
    createdAt: 1,
    updatedAt: 1,
  });
  putLocationRepository({
    id: "loc_1",
    name: "Rooftop bar",
    description: "neon rooftop",
    ref: `${"c".repeat(60)}bbbb.png`,
    createdAt: 1,
    updatedAt: 1,
  });
  putStoryRepository({
    id: "s_kf",
    kind: "story",
    title: "KF",
    prompt: "s",
    url: "",
    variants: [],
    settings: { kind: "video", aspect: "16:9", resolution: "1080p", style: "none", duration: "5s", count: 1, seed: "", negativePrompt: "", enhance: false },
    createdAt: 0,
    favorite: false,
    mode: "Story Mode",
    scenes: [
      {
        id: "sc1",
        prompt: "she waits",
        url: null,
        status: "generating",
        kind: "video",
        state: { locationId: "loc_1", characters: [{ id: "ch_1" }] },
      },
    ],
    meta: { continuity: true, running: true, characterIds: ["ch_1"] },
    world: { baseSeed: 424242, locationIds: ["loc_1"] },
  });
}

function executor(): JobExecutor {
  const fakeProvider = {
    id: "sogni",
    label: "Fake",
    isConfigured: () => true,
    listImageModels: () => [],
    submitJob: async () => ({ ref: "ref_1" }),
    pollJob: async (): Promise<JobPollResult> => ({ status: "completed", artifacts: [artifact()] }),
    cancelJob: async () => {},
  } as unknown as ImageProvider;
  return new JobExecutor({
    pollIntervalMs: 1,
    sleepImpl: () => Promise.resolve(),
    now: () => 1_000_000,
    autoRecover: false,
    prepareImpl: async () =>
      ({
        normalized: { kind: "image", prompt: "kf" } as NormalizedGenerationRequest,
        provider: fakeProvider,
        model: { id: "sogni:edit", label: "Edit" } as ModelDescriptor,
        swapped: false,
        framesActive: false,
        hadStartImage: false,
        log: logger,
      }) as never,
    persistImpl: async () => MEDIA,
  });
}

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-kf-"));
  setJobsPathForTests(path.join(dir, "jobs.json"));
  setProviderConfigPathForTests(path.join(dir, "settings.json"));
  setAssetsPathForTests(path.join(dir, "assets.json"));
  setStoriesPathForTests(path.join(dir, "stories.json"));
  setCharactersPathForTests(path.join(dir, "characters.json"));
  setLocationsPathForTests(path.join(dir, "locations.json"));
  resetProviderConfigForTests();
  anchorStory();
});

afterEach(() => {
  for (const off of [setJobsPathForTests, setAssetsPathForTests, setStoriesPathForTests, setCharactersPathForTests, setLocationsPathForTests, setProviderConfigPathForTests]) {
    off(null);
  }
  resetProviderConfigForTests();
});

async function settled(jobId: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const job = await import("@/lib/repositories/jobs.repository").then((m) => m.getJobsRepository(jobId));
    if (job?.status === "completed" || job?.status === "failed") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${jobId} never settled`);
}

describe("keyframe absorb (k_ tags)", () => {
  it("stores the keyframe ref and advances to the scene render on a passing gate", async () => {
    const h = executor();
    h.enqueue(makeJob());
    await settled("job_kf");
    const scene = getStoriesRepository("s_kf")?.scenes?.[0];
    expect(scene?.keyframeRef).toBe(FRAME_REF);
    expect((scene?.score as StoredScore | undefined)?.passed ?? true).toBe(true);
    // The gate ran with the composed expectations (cast + location).
    expect(gate.scoreKeyframeRef).toHaveBeenCalledTimes(1);
    const expectations = gate.scoreKeyframeRef.mock.calls[0]?.[1] as { identity: string };
    expect(expectations.identity).toContain("30-year-old");
    expect(advance.advanceSceneAfterKeyframe).toHaveBeenCalledWith("s_kf", "sc1");
  });

  it("re-rolls on a failing gate: clears the ref, bumps attempts, re-advances", async () => {
    gate.scoreKeyframeRef.mockResolvedValueOnce({
      verdict: { identity: 0.2, outfit: 0.2, location: 0.3, passed: false },
      source: "vision",
    });
    const h = executor();
    h.enqueue(makeJob());
    await settled("job_kf");
    const scene = getStoriesRepository("s_kf")?.scenes?.[0];
    expect(scene?.keyframeRef).toBeUndefined();
    expect(scene?.attempts).toBe(1);
    expect((scene?.score as StoredScore | undefined)?.passed).toBe(false);
    expect(advance.advanceStoryChain).toHaveBeenCalledWith("s_kf");
    expect(advance.advanceSceneAfterKeyframe).not.toHaveBeenCalled();
  });

  it("accepts a failing gate once attempts are exhausted (flags, animates anyway)", async () => {
    putStoryRepository({
      ...getStoriesRepository("s_kf")!,
      scenes: [
        {
          ...getStoriesRepository("s_kf")!.scenes![0],
          attempts: 2,
        },
      ],
    });
    gate.scoreKeyframeRef.mockResolvedValueOnce({
      verdict: { identity: 0.2, outfit: 0.2, location: 0.3, passed: false },
      source: "vision",
    });
    const h = executor();
    h.enqueue(makeJob());
    await settled("job_kf");
    const scene = getStoriesRepository("s_kf")?.scenes?.[0];
    // The last keyframe is kept — it is the best available — and the chain animates.
    expect(scene?.keyframeRef).toBe(FRAME_REF);
    expect((scene?.score as StoredScore | undefined)?.passed).toBe(false);
    expect(advance.advanceSceneAfterKeyframe).toHaveBeenCalledWith("s_kf", "sc1");
  });

  it("accepts without scoring when the gate is unavailable", async () => {
    gate.scoreKeyframeRef.mockResolvedValueOnce({ verdict: null, source: "unavailable" });
    const h = executor();
    h.enqueue(makeJob());
    await settled("job_kf");
    const scene = getStoriesRepository("s_kf")?.scenes?.[0];
    expect(scene?.keyframeRef).toBe(FRAME_REF);
    expect(advance.advanceSceneAfterKeyframe).toHaveBeenCalled();
  });
});

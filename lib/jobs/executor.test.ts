import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelDescriptor, NormalizedGenerationRequest } from "@/lib/domain/models";
import type {
  GeneratedArtifact,
  ImageProvider,
  JobPollResult,
  JobProvider,
} from "@/lib/providers/types";
import type { Logger } from "@/lib/logging/logger";
import { logger } from "@/lib/logging/logger";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import { setAssetsPathForTests } from "@/lib/repositories/assets.repository";
import { setStoriesPathForTests } from "@/lib/repositories/stories.repository";
import { setModerationPathForTests } from "@/lib/repositories/moderation.repository";
import {
  getJobsRepository,
  putJobRepository,
  setJobsPathForTests,
  type JobRecord,
} from "@/lib/repositories/jobs.repository";
import { GenerationServiceError } from "@/lib/services/generation.service";
import { JobExecutor, JOB_CAP_MS } from "@/lib/jobs/executor";
import type { PreparedGeneration } from "@/lib/services/generation.service";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const MEDIA = [
  {
    id: "m_1",
    url: "/api/media?f=fake.png",
    width: 1920,
    height: 1080,
    seed: 42,
    mime: "image/png",
  },
];

function artifact(): GeneratedArtifact {
  return { bytes: PNG, url: null, ext: "png", seed: 42 };
}

function request(): NormalizedGenerationRequest {
  return {
    kind: "image",
    prompt: "a fox",
    negativePrompt: "",
    aspect: "16:9",
    resolution: "1080p",
    durationSeconds: 0,
    count: 1,
    seed: 42,
    safe: true,
    enhance: false,
  };
}

/** The prepared pipeline result the executor would get from the real service. */
function prepared(provider: unknown): PreparedGeneration {
  return {
    normalized: request(),
    provider: provider as ImageProvider,
    model: { id: "sogni:krea2_turbo_fp8_scaled", label: "Krea" } as ModelDescriptor,
    swapped: false,
    framesActive: false,
    hadStartImage: false,
    log: logger,
  };
}

function makeJob(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    provider: "sogni",
    kind: "image",
    modelId: "sogni:krea2_turbo_fp8_scaled",
    request: { kind: "image", prompt: "a fox", aspect: "16:9", resolution: "1080p" },
    status: "queued",
    createdAt: 1,
    ...over,
  };
}

interface Harness {
  executor: JobExecutor;
  polls: { shifts: JobPollResult[]; calls: number; throwFrom: number | null };
  providerEvents: { cancels: number; submits: number };
  inline: { images: number };
  clock: { value: number; advance: (ms: number) => void };
  media: typeof MEDIA;
}

function harness(opts: {
  pollShifts?: JobPollResult[];
  pollThrowsFrom?: number | null;
  pollAdvancesClockMs?: number;
  inlineProvider?: boolean;
}): Harness {
  const polls = {
    shifts: opts.pollShifts ?? [],
    calls: 0,
    throwFrom: opts.pollThrowsFrom ?? null,
  };
  const providerEvents = { cancels: 0, submits: 0 };
  const inline = { images: 0 };
  const clock = {
    value: 1_000_000,
    advance: (ms: number) => {
      clock.value += ms;
    },
  };

  const fakeProvider: Record<string, unknown> = {
    id: "sogni",
    label: "Fake",
    isConfigured: () => true,
    listImageModels: () => [],
    generateImage: async () => {
      inline.images += 1;
      return [artifact()];
    },
  };
  if (!opts.inlineProvider) {
    fakeProvider.submitJob = async () => {
      providerEvents.submits += 1;
      return { ref: "ref_1" };
    };
    fakeProvider.pollJob = async (): Promise<JobPollResult> => {
      if (polls.throwFrom !== null && polls.calls >= polls.throwFrom) {
        clock.advance(opts.pollAdvancesClockMs ?? 60_000);
        throw new Error("relay unreachable");
      }
      polls.calls += 1;
      clock.advance(opts.pollAdvancesClockMs ?? 0);
      return polls.shifts.shift() ?? { status: "running" };
    };
    fakeProvider.cancelJob = async () => {
      providerEvents.cancels += 1;
    };
  }

  const executor = new JobExecutor({
    pollIntervalMs: 1,
    sleepImpl: () => Promise.resolve(),
    now: () => clock.value,
    autoRecover: false,
    prepareImpl: async () => prepared(fakeProvider),
    persistImpl: async () => MEDIA,
  });
  return { executor, polls, providerEvents, inline, clock, media: MEDIA };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-"));
  setJobsPathForTests(path.join(dir, "jobs.json"));
  setProviderConfigPathForTests(path.join(dir, "settings.json"));
  // Absorption writes assets/stories/moderation during these tests — point
  // them at the temp dir too, or fake rows leak into the live .studio.
  setAssetsPathForTests(path.join(dir, "assets.json"));
  setStoriesPathForTests(path.join(dir, "stories.json"));
  setModerationPathForTests(path.join(dir, "moderation.json"));
  resetProviderConfigForTests();
});

afterEach(() => {
  setJobsPathForTests(null);
  setAssetsPathForTests(null);
  setStoriesPathForTests(null);
  setModerationPathForTests(null);
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
});

async function settled(jobId: string, statuses: string[]): Promise<void> {
  // Real sleeps so stalled poll promises (real timers in the fakes) get the
  // wall time they need; bounded well above every stall in these tests.
  for (let i = 0; i < 400; i += 1) {
    const job = getJobsRepository(jobId);
    if (job && statuses.includes(job.status)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job ${jobId} never reached ${statuses.join("|")}`);
}

describe("job executor", () => {
  it("serialized lanes run one job at a time, FIFO", async () => {
    // Each job's poll chain: one running tick, then completion. Because the
    // lane is busy until job A finishes, job B's submit can only happen after.
    let firstSettled = false;
    // Custom provider that records ordering.
    const providerEvents2 = { submits: 0 };
    const clock = {
      value: 1_000_000,
      advance: (ms: number) => {
        clock.value += ms;
      },
    };
    const results: JobPollResult[][] = [
      [{ status: "completed", artifacts: [artifact()] }],
      [{ status: "completed", artifacts: [artifact()] }],
    ];
    const fakeProvider = {
      id: "sogni",
      label: "Fake",
      isConfigured: () => true,
      listImageModels: () => [],
      generateImage: async () => [artifact()],
      submitJob: async () => {
        providerEvents2.submits += 1;
        return { ref: `ref_${providerEvents2.submits}` };
      },
      pollJob: async (): Promise<JobPollResult> => {
        if (!firstSettled) {
          // First job stalls until the test observes it running.
          await new Promise((r) => setTimeout(r, 20));
          firstSettled = true;
        }
        clock.advance(1);
        return results.shift()?.shift() ?? { status: "running" };
      },
      cancelJob: async () => {},
    };
    const executor = new JobExecutor({
      pollIntervalMs: 1,
      sleepImpl: () => Promise.resolve(),
      now: () => clock.value,
      autoRecover: false,
      prepareImpl: async () => prepared(fakeProvider),
      persistImpl: async () => MEDIA,
    });
    const bStatusAtSubmit: (string | undefined)[] = [];
    const originalSubmit = fakeProvider.submitJob;
    fakeProvider.submitJob = async () => {
      bStatusAtSubmit.push(getJobsRepository("b")?.status);
      return originalSubmit();
    };
    executor.enqueue(makeJob("a"));
    executor.enqueue(makeJob("b"));
    await settled("a", ["completed"]);
    await settled("b", ["completed"]);
    // B must still be queued when B's own submit starts? No — B's submit IS
    // the start. The ordering proof: at A's submit B was queued.
    expect(bStatusAtSubmit[0]).toBe("queued");
    expect(providerEvents2.submits).toBe(2);
    expect(getJobsRepository("a")?.result).toEqual(MEDIA);
    expect(getJobsRepository("b")?.result).toEqual(MEDIA);
  });

  it("job path: submit persists the ref, completion persists media", async () => {
    const h = harness({
      pollShifts: [{ status: "completed", artifacts: [artifact()] }],
    });
    h.executor.enqueue(makeJob("j1"));
    await settled("j1", ["completed"]);
    const job = getJobsRepository("j1");
    expect(job?.providerRef).toBe("ref_1");
    expect(job?.result).toEqual(MEDIA);
    expect(job?.finishedAt).toBeTypeOf("number");
    expect(h.providerEvents.submits).toBe(1);
  });

  it("inline path: non-job providers run under the cap without refs", async () => {
    const h = harness({ inlineProvider: true });
    h.executor.enqueue(makeJob("i1"));
    await settled("i1", ["completed"]);
    const job = getJobsRepository("i1");
    expect(job?.providerRef).toBeUndefined();
    expect(job?.result).toEqual(MEDIA);
    expect(h.inline.images).toBe(1);
  });

  it("cancelling a running job exits the loop and cancels the provider job", async () => {
    const h = harness({ pollShifts: [] }); // never settles on its own
    h.executor.enqueue(makeJob("r1"));
    await settled("r1", ["running"]);
    h.executor.cancel("r1");
    await settled("r1", ["canceled"]);
    await new Promise((r) => setImmediate(r));
    expect(h.providerEvents.cancels).toBe(1);
    expect(getJobsRepository("r1")?.status).toBe("canceled");
  });

  it("cancelling a queued job removes it from the lane untouched", async () => {
    const h = harness({
      pollShifts: [{ status: "completed", artifacts: [artifact()] }],
    });
    h.executor.enqueue(makeJob("q1"));
    h.executor.enqueue(makeJob("q2"));
    h.executor.cancel("q2");
    await settled("q1", ["completed"]);
    expect(getJobsRepository("q2")?.status).toBe("canceled");
    expect(h.providerEvents.submits).toBe(1); // only q1 ran
  });

  it("provider-reported failure marks the job failed with the provider's retryability", async () => {
    const h = harness({
      pollShifts: [{ status: "failed", retryable: false, message: "prompt rejected" }],
    });
    h.executor.enqueue(makeJob("f1"));
    await settled("f1", ["failed"]);
    expect(getJobsRepository("f1")).toMatchObject({
      status: "failed",
      retryable: false,
      error: "prompt rejected",
    });
  });

  it("repeated poll errors trip the staleness limit as retryable", async () => {
    // staleness 60s → trips after 120s of failed polls (each +100s clock).
    updateProviderConfig({ renderTimeouts: { staleness: 60 } });
    const h = harness({ pollThrowsFrom: 0, pollAdvancesClockMs: 100_000 });
    h.executor.enqueue(makeJob("s1"));
    await settled("s1", ["failed"]);
    const job = getJobsRepository("s1");
    expect(job?.status).toBe("failed");
    expect(job?.retryable).toBe(true);
    expect(job?.error).toContain("staleness");
  });

  it("the absolute cap fires before staleness when configured wide", async () => {
    updateProviderConfig({ renderTimeouts: { staleness: 1800 } }); // 2× = 3600s
    // Each failed poll advances 10 min; the 30 min image cap trips first.
    const h = harness({ pollThrowsFrom: 0, pollAdvancesClockMs: 600_000 });
    h.executor.enqueue(makeJob("c1"));
    await settled("c1", ["failed"]);
    const job = getJobsRepository("c1");
    expect(job?.status).toBe("failed");
    expect(job?.retryable).toBe(true);
    expect(job?.error).toContain("30-minute limit");
    expect(JOB_CAP_MS.image).toBe(30 * 60_000);
  });

  it("recover re-enters queued jobs into lanes and finishes them", async () => {
    putJobRepository(makeJob("rec1", { status: "queued" }));
    const h = harness({
      pollShifts: [{ status: "completed", artifacts: [artifact()] }],
    });
    h.executor.recover();
    await settled("rec1", ["completed"]);
    expect(getJobsRepository("rec1")?.result).toEqual(MEDIA);
  });

  it("recover re-attaches a running job from its persisted ref", async () => {
    putJobRepository(
      makeJob("rec2", {
        status: "running",
        providerRef: "proj_restart",
        startedAt: 500,
      }),
    );
    const h = harness({
      pollShifts: [{ status: "completed", artifacts: [artifact()] }],
    });
    h.executor.recover();
    await settled("rec2", ["completed"]);
    expect(h.providerEvents.submits).toBe(0); // resumed, not re-submitted
    expect(getJobsRepository("rec2")?.result).toEqual(MEDIA);
  });

  it("recover fails a running job that has no ref (unresumable)", async () => {
    putJobRepository(makeJob("rec3", { status: "running", startedAt: 500 }));
    const h = harness({});
    h.executor.recover();
    await settled("rec3", ["failed"]);
    const job = getJobsRepository("rec3");
    expect(job?.retryable).toBe(true);
    expect(job?.error).toContain("restarted");
    expect(h.providerEvents.submits).toBe(0);
  });

  it("a GenerationServiceError in prepare fails the job non-retryably", async () => {
    const executor = new JobExecutor({
      pollIntervalMs: 1,
      sleepImpl: () => Promise.resolve(),
      autoRecover: false,
      prepareImpl: async () => {
        throw new GenerationServiceError("That model is not supported.", {
          field: "model",
          retryable: false,
        });
      },
      persistImpl: async () => MEDIA,
    });
    executor.enqueue(makeJob("p1"));
    await settled("p1", ["failed"]);
    expect(getJobsRepository("p1")).toMatchObject({
      status: "failed",
      retryable: false,
      error: "That model is not supported.",
    });
  });
});

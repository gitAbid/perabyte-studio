import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getJobsRepository,
  listActiveJobsRepository,
  listJobsRepository,
  patchJobRepository,
  putJobRepository,
  removeJobsRepository,
  setJobsPathForTests,
} from "@/lib/repositories/jobs.repository";
import type { JobRecord } from "@/lib/repositories/jobs.repository";

function makeJob(id: string, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    provider: "sogni",
    kind: "image",
    modelId: "sogni:krea2_turbo_fp8_scaled",
    request: {
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
    },
    status: "queued",
    createdAt: 1,
    ...over,
  };
}

let file: string;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-repo-"));
  file = path.join(tmp, "jobs.json");
  setJobsPathForTests(file);
});

describe("jobs repository", () => {
  it("persists a job and reads it back with refs and media intact", () => {
    const job = makeJob("job_1", {
      status: "completed",
      providerRef: "proj_abc",
      clientTag: "s_story1:sc1",
      result: [
        {
          id: "m_1",
          url: "/api/media?f=abc.png",
          width: 1920,
          height: 1080,
          seed: 42,
          mime: "image/png",
        },
      ],
      effectiveModelId: "sogni:krea2_turbo_fp8_scaled",
      frameUsed: true,
    });
    putJobRepository(job);
    setJobsPathForTests(null);
    setJobsPathForTests(file);
    const loaded = getJobsRepository("job_1");
    expect(loaded?.providerRef).toBe("proj_abc");
    expect(loaded?.result?.[0].url).toBe("/api/media?f=abc.png");
    expect(loaded?.frameUsed).toBe(true);
  });

  it("patches in place (status transitions, heartbeats via progress)", () => {
    putJobRepository(makeJob("job_1"));
    patchJobRepository("job_1", {
      status: "running",
      startedAt: 5,
      progress: { stage: "rendering", message: "50%", percent: 50 },
    });
    const job = getJobsRepository("job_1");
    expect(job?.status).toBe("running");
    expect(job?.progress?.percent).toBe(50);
  });

  it("lists active jobs (queued + running) newest first", () => {
    putJobRepository(makeJob("a", { status: "queued", createdAt: 1 }));
    putJobRepository(makeJob("b", { status: "running", createdAt: 2 }));
    putJobRepository(makeJob("c", { status: "completed", createdAt: 3 }));
    putJobRepository(makeJob("d", { status: "failed", createdAt: 4 }));
    expect(listActiveJobsRepository().map((j) => j.id)).toEqual(["b", "a"]);
  });

  it("removes by id and reports the count", () => {
    putJobRepository(makeJob("a"));
    putJobRepository(makeJob("b"));
    expect(removeJobsRepository(["a", "zz"])).toBe(1);
    expect(listJobsRepository().map((j) => j.id)).toEqual(["b"]);
  });

  it("drops malformed rows on load instead of throwing", () => {
    putJobRepository(makeJob("ok"));
    const rows = JSON.parse(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(
      file,
      JSON.stringify([...rows, { id: 7 }, null, { status: "queued" }]),
    );
    setJobsPathForTests(null);
    setJobsPathForTests(file);
    expect(listJobsRepository().map((j) => j.id)).toEqual(["ok"]);
  });
});

import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { getRecord } from "@/lib/services/records.service";
import { toSummary } from "@/lib/jobs/jobs.service";
import { listActiveJobsRepository } from "@/lib/repositories/jobs.repository";
import {
  cancelStoryRun,
  cancelStoryScene,
  mutateStoryScenes,
  requeueStoryScene,
  startStoryRun,
  type StoryRunInput,
} from "@/lib/story/server-runner";

export const runtime = "nodejs";

const log = logger.child({ route: "api/stories/[id]" });

/**
 * Story run controls (Phase C). POST ?action=
 * - generate — start (or resume) the server-side run. Body may carry the
 *   current picker state (`settingsPatch`); prompts and seeds are composed
 *   server-side by the runner.
 * - cancel   — stop the run and cancel its in-flight jobs.
 * - rerun    — re-queue one settled scene (?sceneId=); the chain advances
 *              only while a run is active.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const action = new URL(request.url).searchParams.get("action");
  const sceneId = new URL(request.url).searchParams.get("sceneId") ?? undefined;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    if (action === "generate") {
      const input: StoryRunInput = {
        ...(body.settingsPatch && typeof body.settingsPatch === "object"
          ? { settingsPatch: body.settingsPatch as StoryRunInput["settingsPatch"] }
          : {}),
      };
      const story = await startStoryRun(id, input);
      log.info("story generate requested", { storyId: id });
      return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "cancel") {
      const story = await cancelStoryRun(id);
      if (!story) {
        return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
      }
      return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "mutate") {
      // Scene-level edits (add/remove/move/edit/continuity) are applied
      // server-side as read-modify-write — the console never patches the
      // record from stale client state while a run may be mutating it.
      const story = await mutateStoryScenes(id, body as unknown as Parameters<typeof mutateStoryScenes>[1]);
      if (!story) {
        return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
      }
      return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "rerun") {
      if (!sceneId) {
        return NextResponse.json({ error: "Missing sceneId.", retryable: false }, { status: 400 });
      }
      const story = await requeueStoryScene(id, sceneId);
      if (!story) {
        return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
      }
      return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json({ error: "Unsupported action.", retryable: false }, { status: 400 });
  } catch (error) {
    const message = (error as Error)?.message ?? "The story run could not be started.";
    log.warn("story action failed", { storyId: id, action, message });
    return NextResponse.json({ error: message, retryable: false }, { status: 400 });
  }
}

/**
 * GET — the story plus its live run state: active jobs for this story
 * (clientTag `s_<id>:<sceneId>`) so the console can show per-scene
 * progress without holding anything open.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const story = getRecord(id);
  if (!story || story.kind !== "story") {
    return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
  }
  const prefix = `${id}:`;
  const jobs = listActiveJobsRepository()
    .filter((job) => job.clientTag?.startsWith(prefix))
    .map((job) => ({ ...toSummary(job), sceneId: job.clientTag?.slice(prefix.length) }));
  return NextResponse.json({ story, jobs }, { headers: { "cache-control": "no-store" } });
}

/** DELETE ?sceneId= cancel one scene (queued/generating). */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sceneId = new URL(request.url).searchParams.get("sceneId");
  if (!sceneId) {
    return NextResponse.json({ error: "Missing sceneId.", retryable: false }, { status: 400 });
  }
  const story = await cancelStoryScene(id, sceneId);
  if (!story) {
    return NextResponse.json({ error: "Story not found.", retryable: false }, { status: 404 });
  }
  return NextResponse.json({ story }, { headers: { "cache-control": "no-store" } });
}

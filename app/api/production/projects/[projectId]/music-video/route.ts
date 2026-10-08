import { createMusicVideoStory, CreateMusicVideoStoryCommandSchema } from "@/lib/services/production/music-video";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "@/lib/production/http";
import { withProductionStore } from "@/lib/production/runtime";
import { IdSchema } from "@/lib/production/contracts";
import { ProductionApplicationError } from "@/lib/production/errors";

type Context = { params: Promise<{ projectId: string }> };

// M6-3 (spec 18): song sections become ORDINARY story beats through the shared
// story service; narration timing is bypassed by construction and no separate
// media stack exists. The response carries the section table + per-section
// frame counts so the storyboard stage consumes song-driven timing.

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, CreateMusicVideoStoryCommandSchema);
    if (command.projectId !== projectId) throw new ProductionApplicationError("INVALID_INPUT", "Route project ID does not match command project ID");
    const result = await withProductionStore((store) => createMusicVideoStory(store, command));
    return Response.json(
      { storyRevisionId: result.storyRevision.id, sections: result.sections, targetFrames: result.targetFrames, songDurationMs: result.songDurationMs },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

import { resolveFirstChainTextProvider } from "@/lib/services/production/text-chain-provider";
import { recordGeneration } from "@/lib/services/production/metrics";
import { ProductionApplicationError } from "@/lib/production/errors";
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from "@/lib/production/http";
import { withProductionStore } from "@/lib/production/runtime";
import { IdSchema } from "@/lib/production/contracts";
import { z } from "zod";

/**
 * Publish metadata proposal (M5-5, spec 15): one text-engine call drafts
 * title/description/hashtags/chapters from the project's own story. The
 * proposal is ALWAYS a draft — the publish page drops it into the editable
 * fields and the creator owns every word before the package ships
 * (spec acceptance: "Metadata remains editable before publishing").
 */

export const runtime = "nodejs";

const ProposalSchema = z.strictObject({
  projectId: IdSchema,
});

const MetadataOutputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  hashtags: z.string().trim().max(500),
  chapters: z.string().trim().max(5000),
});

export async function POST(request: Request, context: Context): Promise<Response> {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    await readProductionJson(request, ProposalSchema);
    const provider = resolveFirstChainTextProvider();
    if (!provider) {
      throw new ProductionApplicationError("CAPABILITY_MISMATCH", "No text engine is enabled, so metadata can't be drafted.", {
        action: "Enable a text engine in Settings → Providers, or write the metadata by hand.",
        retryable: false,
      });
    }
    const context_ = await withProductionStore((store) => {
      const project = store.read.getProject(projectId);
      if (!project) throw new ProductionApplicationError("UNKNOWN_REFERENCE", "Project not found");
      const story = project.activeStoryRevisionId ? store.read.getStoryRevision(project.activeStoryRevisionId) : null;
      return { name: project.name, script: story?.scriptText.slice(0, 6000) ?? "", beats: story?.beats.map((beat) => beat.action) ?? [] };
    });
    const model = provider.listTextModels()[0];
    const generated = await provider.generateText({
      systemPrompt: "You draft publish metadata for short films. Reply with ONLY a JSON object — no prose, no code fence.",
      userPrompt: [
        'Draft publish metadata for this film as JSON with exactly these keys:',
        '{"title": string (max 100 chars, no clickbait), "description": string (2-4 sentences), "hashtags": string (space-separated #tags, max 8), "chapters": string (one "0:00 Name" line per beat, first must be 0:00)}',
        "",
        `Film name: ${context_.name}`,
        context_.beats.length > 0 ? `Beats in order:\n${context_.beats.map((beat, index) => `${index + 1}. ${beat}`).join("\n")}` : "",
        context_.script ? `Script excerpt:\n${context_.script}` : "",
      ].filter(Boolean).join("\n\n"),
      ...(model ? { modelId: model.id } : {}),
    });
    const jsonText = generated.text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, "$1");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new ProductionApplicationError("INVALID_INPUT", "The text engine returned metadata that wasn't valid JSON.", { action: "Try again, or write the metadata by hand.", retryable: true });
    }
    const metadata = MetadataOutputSchema.safeParse(parsed);
    if (!metadata.success) {
      throw new ProductionApplicationError("INVALID_INPUT", `The drafted metadata was missing required fields: ${metadata.error.issues[0]?.message ?? "unknown"}`, { action: "Try again, or write the metadata by hand.", retryable: true });
    }
    try {
      await withProductionStore((store) => {
        recordGeneration(store, { projectId, kind: "story_proposal_completed", dims: { assetKind: "metadata" } });
        return null;
      });
    } catch {
      // Metrics are best-effort by contract; the proposal still ships.
    }
    return Response.json({ metadata: metadata.data, providerId: provider.id }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return productionErrorResponse(error, requestId);
  }
}

type Context = { params: Promise<{ projectId: string }> };

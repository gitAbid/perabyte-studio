import { createHash, randomUUID } from 'node:crypto';
import type { CanonRevision } from '../../production/contracts';
import { IdSchema } from '../../production/contracts';
import { ProductionApplicationError, type ProductionErrorCode } from '../../production/errors';
import { hashCanonicalJson } from '../../production/hash';
import type { H3FrameGrid } from '../../production/animatic';
import {
  CreateStoryProposalCommandSchema, StoryProposalResultSchema, parseScriptSpeech, planSpeechChunks,
  proposalIssue, validateChunkOutput, validateStoryboardProposal,
  type CanonRef, type ProposalIssue, type ProposalKind, type ProposedBeat, type ProposedShot,
  type SpeechChunk, type StoryProposalResult, type TextPlannerChunkOutput,
} from '../../production/proposals';
import type { ProductionStore } from '../../repositories/production/ports';
import { isTextProvider, type TextProvider } from '../../providers/types';
import { planTextChunk, type PlannerCanonEntry } from '../../providers/production/text-planner';

/**
 * I02-PRE proposal orchestration. Proposals are read-only editable drafts:
 * the service never opens a write transaction, never calls the budget
 * service and never creates revisions, approvals, jobs or media. Acceptance
 * remains a separate human act through the existing CAS gates.
 */
export interface StoryProposalServiceOptions {
  now?: () => number;
  idFactory?: () => string;
  maxShots?: number;
  plannerMaxOutputTokens?: number;
  frameGrid?: H3FrameGrid | null;
}

type ChunkPlanOutcome =
  | { kind: 'ok'; output: TextPlannerChunkOutput; rawText: string }
  | { kind: 'invalid'; errors: string[]; rawText: string | null }
  | { kind: 'provider_failed'; message: string }
  | { kind: 'model_limit'; message: string };

function fail(code: ProductionErrorCode, message: string): never {
  throw new ProductionApplicationError(code, message);
}

const truncate = (message: string) => (message.length > 1500 ? `${message.slice(0, 1497)}...` : message);

function selectChunkCanon(segments: readonly { kind: string; characterId: string | null }[], canonRevisions: readonly CanonRevision[], kind: ProposalKind): PlannerCanonEntry[] {
  const speakerIds = new Set(segments.flatMap((item) => (item.kind === 'dialogue' && item.characterId ? [item.characterId] : [])));
  const entries: PlannerCanonEntry[] = [];
  for (const row of canonRevisions) {
    const needed = row.entityKind === 'character' ? speakerIds.has(row.entityId) : kind === 'storyboard';
    if (!needed) continue;
    entries.push({ entityId: row.entityId, entityKind: row.entityKind, description: row.description, referenceAssetIds: row.referenceAssetIds });
  }
  return entries;
}

async function planChunk(
  provider: TextProvider,
  input: { modelId: string; kind: ProposalKind },
  chunk: SpeechChunk,
  canonRevisions: readonly CanonRevision[],
  options: StoryProposalServiceOptions,
  contextTokens: number,
  repair?: { previousRawText: string; errors: readonly string[] } | null,
): Promise<ChunkPlanOutcome> {
  let result;
  try {
    result = await planTextChunk(provider, {
      modelId: input.modelId, kind: input.kind, segments: chunk.segments,
      canon: selectChunkCanon(chunk.segments, canonRevisions, input.kind),
      contextTokens, maxOutputTokens: options.plannerMaxOutputTokens, repair: repair ?? null,
    });
  } catch (error) {
    return { kind: 'provider_failed', message: truncate(error instanceof Error ? error.message : String(error)) };
  }
  if (!result.ok) {
    return result.reason === 'model_limit'
      ? { kind: 'model_limit', message: result.message }
      : { kind: 'invalid', errors: result.errors, rawText: result.rawText };
  }
  return { kind: 'ok', output: result.output, rawText: result.rawText };
}

export async function generateStoryProposal(
  store: ProductionStore,
  provider: TextProvider,
  rawCommand: unknown,
  options: StoryProposalServiceOptions = {},
): Promise<StoryProposalResult> {
  if (!isTextProvider(provider)) fail('INVALID_INPUT', 'Story proposal planning requires a TextProvider implementation');
  const parsed = CreateStoryProposalCommandSchema.safeParse(rawCommand);
  if (!parsed.success) fail('INVALID_INPUT', `Invalid story proposal command: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  const command = parsed.data;
  const createdAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('INVALID_INPUT', 'Clock must return a nonnegative safe integer timestamp');
  const idFactory = options.idFactory ?? randomUUID;
  const proposalId = idFactory();
  if (!IdSchema.safeParse(proposalId).success) fail('INVALID_INPUT', 'ID factory must return a valid production ID');
  const maxShots = command.maxShots ?? options.maxShots ?? 10_000;
  if (!Number.isSafeInteger(maxShots) || maxShots < 1) fail('INVALID_INPUT', 'Configured maximum shots must be a positive safe integer');

  // Read-only projection; a proposal persists nothing anywhere.
  const project = store.read.getProject(command.projectId);
  if (!project) fail('UNKNOWN_REFERENCE', 'Project not found');
  const canonRevisions = store.read.listCanonRevisions(project.activeCanonRevisionIds);
  if (canonRevisions.length !== project.activeCanonRevisionIds.length) fail('UNKNOWN_REFERENCE', 'Project has a missing selected canon revision');
  const storyRevision = project.activeStoryRevisionId ? store.read.getStoryRevision(project.activeStoryRevisionId) : null;
  if (project.activeStoryRevisionId && !storyRevision) fail('UNKNOWN_REFERENCE', 'Project has a missing active story revision');
  const pinKey = (ids: readonly string[]) => [...ids].sort().join('\u0000');
  if (pinKey(command.expectedCanonRevisionIds) !== pinKey(project.activeCanonRevisionIds)) fail('STALE_REVISION', 'Expected selected canon snapshot is stale; reload the project and retry');
  if (command.expectedStoryRevisionId !== project.activeStoryRevisionId) fail('STALE_REVISION', 'Expected story revision is stale; reload the project and retry');

  if (provider.id !== command.providerId) fail('CAPABILITY_MISMATCH', `Configured text provider ${provider.id} does not match the selected provider ${command.providerId}`);
  if (!provider.isConfigured()) fail('CAPABILITY_MISMATCH', `Selected text provider ${provider.id} is not configured`);
  const model = provider.listTextModels().find((entry) => entry.id === command.modelId);
  if (!model) fail('CAPABILITY_MISMATCH', `Selected provider ${provider.id} does not offer text model ${command.modelId}; no silent fallback is permitted`);
  if (!Number.isSafeInteger(model.contextTokens) || (model.contextTokens ?? 0) <= 0) fail('CAPABILITY_MISMATCH', `Context limit for model ${command.modelId} is unknown; refusing to plan`);

  const characters = canonRevisions.filter((row) => row.entityKind === 'character')
    .map((row) => ({ entityId: row.entityId, name: typeof row.attributes.name === 'string' ? row.attributes.name : null }));
  const { segments, issues: parseIssues } = parseScriptSpeech(command.scriptText, characters, command.speechMap ?? []);
  // Graceful bound checks: the result DTO caps segments/issues at 10000; reject
  // degenerate scripts visibly here instead of failing the final zod parse.
  if (segments.length > 10_000) fail('INVALID_INPUT', `Script produces ${segments.length} speech segments; the proposal bound is 10000`);
  if (parseIssues.length > 10_000) fail('INVALID_INPUT', `Script produces ${parseIssues.length} speech parse issues; the proposal bound is 10000`);
  const issues: ProposalIssue[] = [...parseIssues];
  const designated = segments.filter((item) => item.kind !== 'unmapped');
  if (designated.length === 0 && parseIssues.length === 0) {
    issues.push(proposalIssue('NO_DESIGNATED_SPEECH', segments.length === 0
      ? 'The script designates no speech; plain narration or labeled lines are required'
      : 'No segment is designated as speech; map the ambiguous lines explicitly before proposing'));
  }

  const scriptSha256 = createHash('sha256').update(command.scriptText, 'utf8').digest('hex');
  const canonById = new Map<string, CanonRef>(canonRevisions.map((row) => [row.id, { canonRevisionId: row.id, entityId: row.entityId, entityKind: row.entityKind }]));
  const canonPins = canonRevisions.map((row) => ({ canonRevisionId: row.id, entityId: row.entityId, entityKind: row.entityKind, contentHash: row.contentHash }));
  const beats: ProposedBeat[] = [];
  const shots: ProposedShot[] = [];
  const advisories = [];
  let planned = 0;
  let completed = 0;
  if (designated.length > 0) {
    const chunks = planSpeechChunks(designated, command.chunkMaxBytes ?? 4_000);
    planned = chunks.length;
    let stopped = false;
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (stopped) {
        issues.push(proposalIssue('CHUNK_NOT_PROCESSED', `Chunk ${chunkIndex} was not processed because an earlier chunk failed hard`, { chunkIndex }));
        continue;
      }
      let attempt = await planChunk(provider, command, chunk, canonRevisions, options, model.contextTokens!);
      let repaired = false;
      if (attempt.kind === 'invalid') {
        const repair = await planChunk(provider, command, chunk, canonRevisions, options, model.contextTokens!,
          { previousRawText: attempt.rawText ?? '', errors: attempt.errors });
        repaired = true;
        if (repair.kind === 'provider_failed' || repair.kind === 'model_limit') {
          issues.push(proposalIssue(repair.kind === 'provider_failed' ? 'PROVIDER_CALL_FAILED' : 'MODEL_LIMIT_EXCEEDED', repair.message, { chunkIndex }));
          stopped = true;
          continue;
        }
        attempt = repair;
      }
      if (attempt.kind === 'invalid') {
        issues.push(proposalIssue('PROVIDER_REPAIR_EXHAUSTED', `Chunk ${chunkIndex} still produces invalid structured output after the single permitted repair`, { chunkIndex }));
        continue;
      }
      if (attempt.kind !== 'ok') {
        issues.push(proposalIssue(attempt.kind === 'provider_failed' ? 'PROVIDER_CALL_FAILED' : 'MODEL_LIMIT_EXCEEDED', attempt.message, { chunkIndex }));
        stopped = true;
        continue;
      }
      let validated = validateChunkOutput(chunk, attempt.output, { kind: command.kind, chunkIndex });
      if (validated.issues.length > 0 && !repaired) {
        const repair = await planChunk(provider, command, chunk, canonRevisions, options, model.contextTokens!,
          { previousRawText: attempt.rawText, errors: validated.issues.map((issue) => `${issue.code}: ${issue.message}`) });
        if (repair.kind === 'provider_failed' || repair.kind === 'model_limit') {
          issues.push(proposalIssue(repair.kind === 'provider_failed' ? 'PROVIDER_CALL_FAILED' : 'MODEL_LIMIT_EXCEEDED', repair.message, { chunkIndex }));
          stopped = true;
          continue;
        }
        if (repair.kind === 'ok') {
          const repairedValidation = validateChunkOutput(chunk, repair.output, { kind: command.kind, chunkIndex });
          validated = repairedValidation.issues.length === 0
            ? repairedValidation
            : { ...repairedValidation, issues: [...repairedValidation.issues, proposalIssue('PROVIDER_REPAIR_EXHAUSTED', `Chunk ${chunkIndex} still invalid after the single permitted structured repair`, { chunkIndex })] };
        } else {
          validated = { ...validated, issues: [...validated.issues, proposalIssue('PROVIDER_REPAIR_EXHAUSTED', `Chunk ${chunkIndex} still invalid after the single permitted structured repair`, { chunkIndex })] };
        }
      } else if (validated.issues.length > 0) {
        validated = { ...validated, issues: [...validated.issues, proposalIssue('PROVIDER_REPAIR_EXHAUSTED', `Chunk ${chunkIndex} still invalid after the single permitted structured repair`, { chunkIndex })] };
      }
      beats.push(...validated.beats);
      shots.push(...validated.shots);
      issues.push(...validated.issues);
      if (validated.issues.length === 0) completed += 1;
    }
  }
  if (command.kind === 'storyboard') {
    const storyboard = validateStoryboardProposal({ beats, shots, canonById, maxShots, frameGrid: options.frameGrid });
    issues.push(...storyboard.issues);
    advisories.push(...storyboard.advisories);
  }
  const completeness = issues.length === 0 && planned > 0 && completed === planned && beats.length > 0 && designated.length > 0;
  const contentHash = hashCanonicalJson({
    schemaVersion: 1, projectId: command.projectId, kind: command.kind, providerId: command.providerId, modelId: command.modelId,
    scriptSha256, canonPins, expectedStoryRevisionId: project.activeStoryRevisionId, segments,
    chunks: { planned, completed }, beats, shots, advisories, issues,
  });
  return StoryProposalResultSchema.parse({
    schemaVersion: 1, proposalId, projectId: command.projectId, kind: command.kind,
    providerId: command.providerId, modelId: command.modelId, scriptSha256, canonPins,
    expectedStoryRevisionId: project.activeStoryRevisionId, segments,
    chunks: { planned, completed }, beats, shots, advisories, issues, completeness, contentHash, createdAt,
  });
}

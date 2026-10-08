import { z } from 'zod';
import {
  AnimaticRevisionSchema, AudioMixRevisionSchema, CanonRevisionSchema, CreateCanonRevisionCommandSchema,
  CreateProjectCommandSchema, DependencyIssueSchema, IdSchema, NullableIdSchema, ShotPlanRevisionSchema,
  StoryRevisionSchema, type CreateProjectCommand, type DependencyIssue,
} from './contracts';

/** Pure project/canon/script view-model derivation for C07; every function derives, none mutate. */

export type ValidationIssue = { code: string; message: string; field?: string };
export type Derivation<T> = { ok: true; value: T } | { ok: false; issues: readonly ValidationIssue[] };

const zodIssues = (error: z.ZodError, code: string, label: string): ValidationIssue[] =>
  error.issues.map((entry) => ({
    code,
    message: `${label}: ${entry.message}`,
    ...(entry.path.length ? { field: entry.path.map(String).join('.') } : {}),
  }));
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/* 1. Project/canon creation flow: details -> cast -> world -> script, all steps derived from the draft. */
export const PROJECT_CREATION_STEPS = ['details', 'cast', 'world', 'script'] as const;
export type ProjectCreationStep = (typeof PROJECT_CREATION_STEPS)[number];
/** Mirrors CreateCanonRevisionCommand minus the server-owned projectId/expectedRevisionId fields. */
export const CanonEntityDraftSchema = CreateCanonRevisionCommandSchema.omit({ projectId: true, expectedRevisionId: true });
export type CanonEntityDraftCommand = z.infer<typeof CanonEntityDraftSchema>;
export type ProjectCreationFlow = {
  stepComplete: Record<ProjectCreationStep, boolean>;
  nextStep: ProjectCreationStep | null;
  projectCommand: CreateProjectCommand | null;
  canonDrafts: CanonEntityDraftCommand[];
  script: ScriptImport | null;
  issues: ValidationIssue[];
};
const bucketFor = (kind: CanonEntityDraftCommand['entityKind']) => (kind === 'character' ? 'cast' : 'world');

/** Derive the full creation-flow state from a wizard draft; failed validation only yields issues and never mutates. */
export function deriveProjectCreationFlow(draft: unknown): ProjectCreationFlow {
  const issues: ValidationIssue[] = [];
  const input = plainObject(draft) ? draft : null;
  if (!input) issues.push({ code: 'INVALID_DRAFT', message: 'Creation draft must be an object with name, profileId and optional cast/world/script lists' });

  const parsedProject = CreateProjectCommandSchema.safeParse({ name: input?.name, profileId: input?.profileId });
  const projectCommand = parsedProject.success ? parsedProject.data : null;
  if (!parsedProject.success) issues.push(...zodIssues(parsedProject.error, 'INVALID_PROJECT_DETAILS', 'Project details'));

  const canonDrafts: CanonEntityDraftCommand[] = [];
  const seenEntities = new Map<string, string>();
  const complete: Record<ProjectCreationStep, boolean> = { details: projectCommand !== null, cast: false, world: false, script: false };
  for (const bucket of ['cast', 'world'] as const) {
    const entries = input?.[bucket];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      issues.push({ code: 'INVALID_ENTITY_LIST', message: `${bucket} must be a list of canon entity drafts`, field: bucket });
      continue;
    }
    entries.forEach((entry, index) => {
      const field = `${bucket}[${index}]`;
      const parsed = CanonEntityDraftSchema.safeParse(entry);
      if (!parsed.success) {
        issues.push(...zodIssues(parsed.error, 'INVALID_ENTITY_DRAFT', `Canon draft ${field}`));
        return;
      }
      const value = parsed.data;
      let rejected = false;
      if (bucketFor(value.entityKind) !== bucket) {
        issues.push({ code: 'ENTITY_KIND_MISMATCH', message: `${value.entityKind} entities belong in the ${bucketFor(value.entityKind)} list, not ${bucket}`, field });
        rejected = true;
      }
      const prior = seenEntities.get(value.entityId);
      if (prior) {
        issues.push({ code: 'DUPLICATE_ENTITY', message: `Canon entity ${value.entityId} is drafted twice (${prior} and ${field})`, field });
        rejected = true;
      } else {
        seenEntities.set(value.entityId, field);
      }
      if (!rejected) canonDrafts.push(value);
    });
    complete[bucket] = canonDrafts.some((draft) => bucketFor(draft.entityKind) === bucket);
  }

  let script: ScriptImport | null = null;
  if (input?.script !== undefined) {
    const derived = deriveScriptImport(input.script);
    if (derived.ok) script = derived.value;
    else issues.push(...derived.issues);
  }
  complete.script = script !== null;
  return {
    stepComplete: complete,
    nextStep: PROJECT_CREATION_STEPS.find((step) => !complete[step]) ?? null,
    projectCommand,
    canonDrafts,
    script,
    issues,
  };
}

/* 2. Plain-text script import: fail-closed type and size bounds aligned with StoryRevision.scriptText. */
export const SCRIPT_TEXT_MAX_CHARS = 500_000;
export const SCRIPT_MEDIA_TYPES = ['text/plain'] as const;
export type ScriptImport = { scriptText: string; mediaType: 'text/plain'; charCount: number; byteLength: number; lineCount: number };

/** Validate an uploaded plain-text script and derive display facts; any bound failure keeps the prior editor state. */
export function deriveScriptImport(input: unknown): Derivation<ScriptImport> {
  if (!plainObject(input)) return { ok: false, issues: [{ code: 'INVALID_IMPORT', message: 'Script import must be an object with text and optional mediaType' }] };
  const { text, mediaType } = input;
  const issues: ValidationIssue[] = [];
  if (typeof text !== 'string') issues.push({ code: 'INVALID_SCRIPT_TEXT', message: 'Script text must be a plain-text string', field: 'text' });
  if (mediaType !== undefined && (typeof mediaType !== 'string' || !(SCRIPT_MEDIA_TYPES as readonly string[]).includes(mediaType))) {
    issues.push({ code: 'UNSUPPORTED_MEDIA_TYPE', message: `Only ${SCRIPT_MEDIA_TYPES.join(' and ')} script imports are supported`, field: 'mediaType' });
  }
  if (typeof text === 'string') {
    if (text.length > SCRIPT_TEXT_MAX_CHARS) issues.push({ code: 'SCRIPT_TOO_LONG', message: `Script text exceeds the ${SCRIPT_TEXT_MAX_CHARS} character bound`, field: 'text' });
    if (text.trim().length === 0) issues.push({ code: 'EMPTY_SCRIPT', message: 'Script text cannot be empty or whitespace only', field: 'text' });
  }
  if (issues.length) return { ok: false, issues };
  const scriptText = text as string;
  return {
    ok: true,
    value: {
      scriptText,
      mediaType: 'text/plain',
      charCount: scriptText.length,
      byteLength: new TextEncoder().encode(scriptText).length,
      lineCount: scriptText.split('\n').length,
    },
  };
}

/* 3. Save semantics as derived facts: a save appends a new immutable revision and preserves the prior one. */
const ScriptSaveInputSchema = z.object({ activeStoryRevisionId: NullableIdSchema, scriptText: z.string() });
export type ScriptSaveFacts = {
  baseRevisionId: string | null;
  createsNewRevision: true;
  immutable: true;
  priorRevisionPreserved: boolean;
  label: string;
};

/** Derive save-creates-new-immutable-revision facts for display; performs no write of any kind. */
export function deriveScriptSaveFacts(input: unknown): Derivation<ScriptSaveFacts> {
  const parsed = ScriptSaveInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, 'INVALID_SAVE_INPUT', 'Script save') };
  const { activeStoryRevisionId, scriptText } = parsed.data;
  if (scriptText.length > SCRIPT_TEXT_MAX_CHARS) return { ok: false, issues: [{ code: 'SCRIPT_TOO_LONG', message: `Script text exceeds the ${SCRIPT_TEXT_MAX_CHARS} character bound`, field: 'scriptText' }] };
  if (scriptText.trim().length === 0) return { ok: false, issues: [{ code: 'EMPTY_SCRIPT', message: 'Script text cannot be empty or whitespace only', field: 'scriptText' }] };
  const priorRevisionPreserved = activeStoryRevisionId !== null;
  return {
    ok: true,
    value: {
      baseRevisionId: activeStoryRevisionId,
      createsNewRevision: true,
      immutable: true,
      priorRevisionPreserved,
      label: priorRevisionPreserved
        ? `Saving appends a new immutable story revision after ${activeStoryRevisionId}; the prior revision is never modified.`
        : 'Saving creates the first immutable story revision; later saves append new revisions.',
    },
  };
}

/* 4. Stale-dependency notices derived from the C02 read model's schemaVersion-2 dependencyIssues. */
const DependencyIssueListSchema = z.array(DependencyIssueSchema).max(100_000);
const ReadModelIssuesSchema = z.object({ schemaVersion: z.literal(2), dependencyIssues: DependencyIssueListSchema });
const SelectedShotSchema = z.object({
  shotRevision: z.object({ id: IdSchema }),
  selectedAnchor: z.object({ id: IdSchema }).nullable(),
  selectedTake: z.object({ id: IdSchema }).nullable(),
});
type SelectedShot = z.infer<typeof SelectedShotSchema>;
export type StaleDependencyNotice = {
  code: DependencyIssue['code'];
  targetKind: DependencyIssue['targetKind'];
  targetId: string;
  dependencyKind: DependencyIssue['dependencyKind'];
  pinnedDependencyId: string;
  activeDependencyId: string | null;
  anchorId: string | null;
  takeId: string | null;
  message: string;
};
const TARGET_KIND_ORDER: readonly DependencyIssue['targetKind'][] = ['story', 'shotplan', 'animatic', 'shot', 'audio'];
const CODE_ORDER: readonly DependencyIssue['code'][] = ['DEPENDENCY_REPLACED', 'STORY_CHANGED', 'DEPENDENCY_MISSING'];
const DEPENDENCY_KIND_ORDER: readonly DependencyIssue['dependencyKind'][] = ['canon', 'story', 'shot', 'continuation'];
const TARGET_LABEL: Record<DependencyIssue['targetKind'], string> = { story: 'Story', shotplan: 'Shot plan', animatic: 'Animatic', shot: 'Shot', audio: 'Audio mix' };

/** Accept the read-model wrapper ({schemaVersion:2, dependencyIssues}) or a bare issue list. */
function readDependencyIssues(input: unknown): { ok: true; issues: readonly DependencyIssue[] } | { ok: false; issues: ValidationIssue[] } {
  const wrapper = ReadModelIssuesSchema.safeParse(input);
  if (wrapper.success) return { ok: true, issues: wrapper.data.dependencyIssues };
  const list = DependencyIssueListSchema.safeParse(input);
  if (list.success) return { ok: true, issues: list.data };
  const attempt = wrapper.error.issues.some((entry) => entry.path.includes('schemaVersion')) && !DependencyIssueListSchema.safeParse(input).success;
  return { ok: false, issues: zodIssues(list.error ?? wrapper.error, 'INVALID_DEPENDENCY_ISSUES', attempt ? 'Read model schemaVersion must be 2' : 'Dependency issues') };
}

/**
 * Derive human-readable stale-work notices (which anchors/takes are stale) from C02 dependency issues.
 * Output is deduplicated and sorted deterministically; malformed input fails closed with issues.
 */
export function deriveStaleDependencyNotices(input: unknown, shots?: unknown): Derivation<readonly StaleDependencyNotice[]> {
  const parsedShots = shots === undefined ? { success: true as const, data: [] as SelectedShot[] } : z.array(SelectedShotSchema).safeParse(shots);
  if (!parsedShots.success) return { ok: false, issues: zodIssues(parsedShots.error, 'INVALID_SHOTS', 'Shot selections') };
  const source = readDependencyIssues(input);
  if (!source.ok) return source;
  const byShotRevision = new Map(parsedShots.data.map((shot) => [shot.shotRevision.id, shot]));
  const unique = new Map<string, DependencyIssue>();
  for (const entry of source.issues) unique.set(`${entry.targetKind}|${entry.targetId}|${entry.dependencyKind}|${entry.pinnedDependencyId}|${entry.activeDependencyId ?? ''}|${entry.code}`, entry);
  const rank = <T>(order: readonly T[], value: T) => { const index = order.indexOf(value); return index < 0 ? order.length : index; };
  const notices = [...unique.values()]
    .sort((left, right) =>
      rank(TARGET_KIND_ORDER, left.targetKind) - rank(TARGET_KIND_ORDER, right.targetKind) ||
      left.targetId.localeCompare(right.targetId) ||
      rank(CODE_ORDER, left.code) - rank(CODE_ORDER, right.code) ||
      rank(DEPENDENCY_KIND_ORDER, left.dependencyKind) - rank(DEPENDENCY_KIND_ORDER, right.dependencyKind) ||
      left.pinnedDependencyId.localeCompare(right.pinnedDependencyId))
    .map((entry): StaleDependencyNotice => {
      const shot = entry.targetKind === 'shot' ? byShotRevision.get(entry.targetId) : undefined;
      const label = `${TARGET_LABEL[entry.targetKind]} ${entry.targetId}`;
      const anchorId = shot?.selectedAnchor?.id ?? null;
      const takeId = shot?.selectedTake?.id ?? null;
      const suffix = shot ? ` Re-derive selected anchor ${anchorId ?? 'none'} and take ${takeId ?? 'none'}.` : '';
      const cause = entry.code === 'DEPENDENCY_REPLACED'
        ? `its ${entry.dependencyKind} pin ${entry.pinnedDependencyId} was replaced by ${entry.activeDependencyId ?? 'nothing'}`
        : entry.code === 'STORY_CHANGED'
          ? `its ${entry.dependencyKind} source ${entry.pinnedDependencyId} changed and the active dependency is ${entry.activeDependencyId ?? 'unknown'}`
          : `its ${entry.dependencyKind} pin ${entry.pinnedDependencyId} no longer exists`;
      return {
        code: entry.code, targetKind: entry.targetKind, targetId: entry.targetId, dependencyKind: entry.dependencyKind,
        pinnedDependencyId: entry.pinnedDependencyId, activeDependencyId: entry.activeDependencyId, anchorId, takeId,
        message: `${label} is stale: ${cause}.${suffix}`,
      };
    });
  return { ok: true, value: notices };
}

/* 5. Provenance display data: source revision facts, dependencies and immutable-append semantics. */
const RevisionProvenanceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('canon'), revision: CanonRevisionSchema }),
  z.strictObject({ kind: z.literal('story'), revision: StoryRevisionSchema }),
  z.strictObject({ kind: z.literal('shotplan'), revision: ShotPlanRevisionSchema }),
  z.strictObject({ kind: z.literal('animatic'), revision: AnimaticRevisionSchema }),
  z.strictObject({ kind: z.literal('audiomix'), revision: AudioMixRevisionSchema }),
]);
export type RevisionKind = z.infer<typeof RevisionProvenanceInputSchema>['kind'];
export type RevisionProvenance = {
  kind: RevisionKind;
  revisionId: string;
  contentHash: string;
  createdAt: number;
  parentRevisionId: string | null;
  dependencies: string[];
  saveSemantics: { createsNewRevision: true; immutable: true; label: string };
};

/** Derive read-only provenance facts for the active revision of any kind; never writes. */
export function deriveRevisionProvenance(input: unknown): Derivation<RevisionProvenance> {
  const parsed = RevisionProvenanceInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, 'INVALID_REVISION', 'Revision provenance input') };
  const source = parsed.data;
  const parentAndDeps = ((): { parentRevisionId: string | null; dependencies: string[] } => {
    switch (source.kind) {
      case 'canon': return { parentRevisionId: null, dependencies: [...source.revision.referenceAssetIds] };
      case 'story': return { parentRevisionId: source.revision.parentRevisionId, dependencies: [...source.revision.canonRevisionIds] };
      case 'shotplan': return { parentRevisionId: null, dependencies: [source.revision.storyRevisionId] };
      case 'animatic': return { parentRevisionId: null, dependencies: [source.revision.shotPlanRevisionId] };
      case 'audiomix': return { parentRevisionId: null, dependencies: [source.revision.storyRevisionId] };
    }
  })();
  return {
    ok: true,
    value: {
      kind: source.kind,
      revisionId: source.revision.id,
      contentHash: source.revision.contentHash,
      createdAt: source.revision.createdAt,
      ...parentAndDeps,
      saveSemantics: {
        createsNewRevision: true,
        immutable: true,
        label: 'Saving creates a new immutable revision; existing revisions are never modified.',
      },
    },
  };
}

/** Deterministic serialization for display structures: object keys are sorted recursively. */
export function serializeDisplay(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.keys(entry).sort().reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = (entry as Record<string, unknown>)[key];
      return sorted;
    }, {});
  });
}

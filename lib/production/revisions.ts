import { hashCanonicalJson } from './hash';
import type { CanonRevision, ShotRevision, StoryRevision } from './contracts';

export type ShotRevisionCandidate = Omit<ShotRevision, 'id' | 'contentHash' | 'createdAt'>;
export interface ShotCompatibilityContext {
  projectId: string;
  /** Descending ancestry beginning at successor; each parent link must connect to the next item. */
  storyLineage: readonly StoryRevision[];
  selectedCanonRevisions: readonly CanonRevision[];
  candidate: ShotRevisionCandidate;
  continuationIsValid: boolean;
}

type ExactShotInputs = Omit<ShotRevisionCandidate, 'storyRevisionId'>;
function exactShotInputsMatch(left: ExactShotInputs, right: ExactShotInputs): boolean {
  const signature = (value: ExactShotInputs) => JSON.stringify({
    shotId: value.shotId,
    beatIds: value.beatIds,
    order: value.order,
    visualIntent: value.visualIntent,
    motionIntent: value.motionIntent,
    castBindings: value.castBindings.map(({ characterId, canonRevisionId, wardrobe }) => [characterId, canonRevisionId, wardrobe]),
    locationRevisionId: value.locationRevisionId,
    propRevisionIds: value.propRevisionIds,
    styleRevisionId: value.styleRevisionId,
    framing: value.framing,
    targetFrames: value.targetFrames,
    continuation: value.continuation ? [value.continuation.previousShotRevisionId, value.continuation.endFrameAssetId] : null,
  });
  return signature(left) === signature(right);
}

/** Canon-only successors retain a shot only when the complete originating script and beats are byte-equivalent. */
export function shotsCompatibleWithStory(
  shot: ShotRevision,
  origin: StoryRevision,
  successor: StoryRevision,
  context: ShotCompatibilityContext,
): boolean {
  if (context.projectId !== origin.projectId || successor.projectId !== context.projectId || shot.storyRevisionId !== origin.id || context.candidate.shotId !== shot.shotId) return false;
  if (context.candidate.storyRevisionId !== successor.id || context.storyLineage.length > 10_000 || context.storyLineage[0]?.id !== successor.id) return false;
  const originIndex = context.storyLineage.findIndex((entry) => entry.id === origin.id);
  if (originIndex < 0 || context.storyLineage.some((entry, index) => index > 0 && context.storyLineage[index - 1].parentRevisionId !== entry.id)) return false;
  if (context.storyLineage.slice(0, originIndex + 1).some((entry) => entry.projectId !== origin.projectId || entry.scriptText !== origin.scriptText || JSON.stringify(entry.beats) !== JSON.stringify(origin.beats))) return false;
  if (successor.scriptText !== origin.scriptText || JSON.stringify(successor.beats) !== JSON.stringify(origin.beats)) return false;
  if (!shot.beatIds.length || shot.beatIds.some((id) => !origin.beats.some((beat) => beat.id === id))) return false;
  if (!context.continuationIsValid) return false;
  if (new Set(context.candidate.beatIds).size !== context.candidate.beatIds.length ||
      new Set(context.candidate.castBindings.map((binding) => binding.characterId)).size !== context.candidate.castBindings.length ||
      new Set(context.candidate.propRevisionIds).size !== context.candidate.propRevisionIds.length) return false;
  if (new Set(context.selectedCanonRevisions.map((revision) => revision.entityId)).size !== context.selectedCanonRevisions.length) return false;
  const selectedCanon = new Map(context.selectedCanonRevisions.map((revision) => [revision.id, revision]));
  const validPin = (id: string, kind: CanonRevision['entityKind']) => successor.canonRevisionIds.includes(id) && selectedCanon.get(id)?.entityKind === kind;
  if (!validPin(context.candidate.locationRevisionId, 'location') || !validPin(context.candidate.styleRevisionId, 'style') ||
      context.candidate.propRevisionIds.some((id) => !validPin(id, 'prop')) ||
      context.candidate.castBindings.some((binding) => {
        const revision = selectedCanon.get(binding.canonRevisionId);
        return !successor.canonRevisionIds.includes(binding.canonRevisionId) || revision?.entityKind !== 'character' || revision.entityId !== binding.characterId;
      })) return false;
  if (context.candidate.beatIds.some((id) => !successor.beats.some((beat) => beat.id === id))) return false;
  const { id: _id, createdAt: _createdAt, contentHash: _contentHash, ...inputs } = shot;
  const { storyRevisionId: _storyRevisionId, ...originInputs } = inputs;
  const { storyRevisionId: _candidateStoryId, ...candidateInputs } = context.candidate;
  if (!exactShotInputsMatch(originInputs, candidateInputs) || hashCanonicalJson(originInputs) !== hashCanonicalJson(candidateInputs)) return false;
  return hashCanonicalJson({ ...candidateInputs, storyRevisionId: origin.id, version: 1 }) === shot.contentHash;
}

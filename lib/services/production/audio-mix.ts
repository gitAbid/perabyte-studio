import type { AudioCue, DeliveryPreset, StoryBeat, StoryRevision } from "../../production/contracts";
import type { VoicesStoreV1 } from "../../voices/read-model";

/**
 * Audio mix plan (spec 12, M4-3): derive the per-line speech plan from the
 * active story's beats (narration copy + dialogue lines), the character voice
 * bindings, and the current mix cues. Pure and deterministic — the page
 * renders it, the cue editor edits its output, and mix approval gates on it.
 *
 * Bookkeeping parity (spec acceptance): an IMPORTED narration line and a
 * generated one are the same shape — a cue whose `scriptSegmentId` pins the
 * beat (the studio's established convention, shared with the stale-narration
 * checker). Today import is the only fill path (no TTS adapter is active in
 * M4; generation arrives in M5 behind the adapter seam), so the UI shows
 * Import, never a disabled fake Generate.
 */

export interface SpeechPlanRow {
  /** Stable row key: the beat id for narration, `${beatId}#d${index}` for dialogue lines. */
  readonly rowKey: string;
  /** The cue binding convention: narration beats bind by beat id; dialogue lines bind by beat id (line text disambiguates the source). */
  readonly scriptSegmentId: string;
  readonly role: "narration" | "dialogue";
  readonly text: string;
  readonly characterId: string | null;
  /** Bound voice (server store), null when unbound (or narration without a narrator binding). */
  readonly voice: VoicesStoreV1["voices"][number] | null;
  readonly voiceLocked: boolean;
  /** Delivery preset for the line: the cue's stamp, else "auto". */
  readonly delivery: DeliveryPreset;
  /** The cue carrying this line's audio, null while the line is unfilled. */
  readonly cue: AudioCue | null;
  readonly filled: boolean;
}

function beatRows(beat: StoryBeat, cues: readonly AudioCue[], voices: VoicesStoreV1): SpeechPlanRow[] {
  const rows: SpeechPlanRow[] = [];
  const rowFor = (rowKey: string, role: SpeechPlanRow["role"], text: string, characterId: string | null): SpeechPlanRow => {
    const cue = cues.find((candidate) => candidate.scriptSegmentId === rowKey) ?? null;
    const binding = characterId !== null ? voices.bindings[characterId] ?? null : null;
    const voice = binding ? voices.voices.find((candidate) => candidate.id === binding.voiceId) ?? null : null;
    return {
      rowKey,
      scriptSegmentId: beat.id,
      role,
      text,
      characterId,
      voice,
      voiceLocked: binding?.locked ?? false,
      delivery: cue?.delivery ?? "auto",
      cue,
      filled: cue !== null,
    };
  };
  if (beat.dialogue.length > 0) {
    beat.dialogue.forEach((line, index) => rows.push(rowFor(index === 0 ? beat.id : `${beat.id}#d${index}`, "dialogue", line.text, line.characterId)));
  } else if (beat.narration.trim().length > 0) {
    rows.push(rowFor(beat.id, "narration", beat.narration, null));
  }
  return rows;
}

export function deriveSpeechPlanRows(input: {
  storyRevision: Pick<StoryRevision, "id" | "beats">;
  cues: readonly AudioCue[];
  voices: VoicesStoreV1;
}): SpeechPlanRow[] {
  return [...input.storyRevision.beats]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .flatMap((beat) => beatRows(beat, input.cues, input.voices));
}

export interface MixApprovalReadiness {
  readonly approvable: boolean;
  /** Row keys with no cue carrying their audio yet. */
  readonly missingRowKeys: readonly string[];
  /** Row keys whose cue references rights "unknown" (approval refuses those server-side too). */
  readonly unknownRightsRowKeys: readonly string[];
}

export function mixApprovalReadiness(rows: readonly SpeechPlanRow[]): MixApprovalReadiness {
  const missingRowKeys = rows.filter((row) => !row.filled).map((row) => row.rowKey);
  const unknownRightsRowKeys = rows
    .filter((row) => row.cue?.sourceRights === "unknown")
    .map((row) => row.rowKey);
  return { approvable: missingRowKeys.length === 0 && unknownRightsRowKeys.length === 0, missingRowKeys, unknownRightsRowKeys };
}

/**
 * Delivery re-render scope proof (spec acceptance: "Delivery change
 * creates/re-renders only affected speech line"): returns the cue list with
 * EXACTLY one cue's `delivery`/`voiceId` stamp replaced — every other cue is
 * the same object reference. The mix content hash moves; no other cue bytes do.
 */
export function stampSpeechCue(
  cues: readonly AudioCue[],
  rowKey: string,
  stamp: { delivery: DeliveryPreset; voiceId: string | null },
): AudioCue[] {
  return cues.map((cue) =>
    cue.scriptSegmentId === rowKey ? { ...cue, delivery: stamp.delivery, voiceId: stamp.voiceId } : cue,
  );
}

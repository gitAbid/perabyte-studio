import { AudioCueSchema, type AudioCue, type AudioMixRevision, type DeliveryPreset, type StoryRevision } from "./contracts";
import { hashCanonicalJson } from "./hash";

/**
 * Audio cue domain: strict local audio import validation, cue construction, explicit overlap
 * policies, deterministic timeline serialization, and narration alignment against the exact
 * pinned story revision. Pure functions only; persistence lives in the audio service.
 */
export const MAX_IMPORT_AUDIO_BYTES = 100 * 1024 * 1024;
export const REQUIRED_AUDIO_SAMPLE_RATE = 48_000;

export type AudioProbeReason = "oversize" | "unsupported" | "corrupt";
export class AudioProbeError extends RangeError {
  readonly reason: AudioProbeReason;
  constructor(reason: AudioProbeReason, message: string) {
    super(message);
    this.name = "AudioProbeError";
    this.reason = reason;
  }
}

export interface AudioProbe { mime: "audio/wav" | "audio/mpeg"; sampleRate: number; channels: number; audioSamples: number }

/**
 * Validates raw audio bytes by header parsing only (no external probe dependency) and reports the
 * 48kHz sample count cues are authored against. Every unsupported codec, oversize payload, or
 * corrupt structure fails closed before callers persist anything.
 */
export function probeAudioBytes(bytes: Uint8Array, options: { maxBytes?: number } = {}): AudioProbe {
  const maxBytes = options.maxBytes ?? MAX_IMPORT_AUDIO_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive safe integer");
  if (bytes.byteLength > maxBytes) throw new AudioProbeError("oversize", `Audio import exceeds the configured limit of ${maxBytes} bytes`);
  if (bytes.byteLength === 0) throw new AudioProbeError("corrupt", "Audio file is empty");
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.subarray(0, 4).toString("latin1") === "RIFF" && view.subarray(8, 12).toString("latin1") === "WAVE") return probeWav(view);
  return probeMp3(view);
}

function probeWav(view: Buffer): AudioProbe {
  if (view.byteLength < 12) throw new AudioProbeError("corrupt", "WAV header is truncated");
  if (view.readUInt32LE(4) + 8 > view.byteLength) throw new AudioProbeError("corrupt", "WAV declares more bytes than were provided");
  let offset = 12;
  let format: { channels: number; sampleRate: number; blockAlign: number } | null = null;
  let dataBytes = -1;
  while (offset < view.byteLength) {
    if (view.byteLength - offset < 8) throw new AudioProbeError("corrupt", "WAV has trailing bytes outside its declared chunk structure");
    const id = view.subarray(offset, offset + 4).toString("latin1");
    const size = view.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > view.byteLength) throw new AudioProbeError("corrupt", `WAV ${id.trim()} chunk is truncated`);
    if (id === "fmt ") {
      if (format) throw new AudioProbeError("corrupt", "WAV contains duplicate fmt chunks");
      if (size < 16) throw new AudioProbeError("corrupt", "WAV fmt chunk is too short");
      const audioFormat = view.readUInt16LE(body);
      if (audioFormat !== 1) throw new AudioProbeError("unsupported", `Unsupported compressed WAV codec (format tag ${audioFormat}); only 16-bit PCM is accepted`);
      const channels = view.readUInt16LE(body + 2);
      const sampleRate = view.readUInt32LE(body + 4);
      const bitsPerSample = view.readUInt16LE(body + 14);
      const blockAlign = view.readUInt16LE(body + 12);
      if (channels < 1 || channels > 2) throw new AudioProbeError("unsupported", "WAV must be mono or stereo");
      if (sampleRate !== REQUIRED_AUDIO_SAMPLE_RATE) throw new AudioProbeError("unsupported", `WAV sample rate must be ${REQUIRED_AUDIO_SAMPLE_RATE}, received ${sampleRate}`);
      if (bitsPerSample !== 16) throw new AudioProbeError("unsupported", "WAV must be 16-bit PCM");
      if (blockAlign !== channels * 2) throw new AudioProbeError("corrupt", "WAV block align does not match its channel count");
      format = { channels, sampleRate, blockAlign };
    } else if (id === "data") {
      if (dataBytes >= 0) throw new AudioProbeError("corrupt", "WAV contains duplicate data chunks");
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new AudioProbeError("corrupt", "WAV is missing its fmt chunk");
  if (dataBytes < 0) throw new AudioProbeError("corrupt", "WAV is missing its data chunk");
  const audioSamples = dataBytes / format.blockAlign;
  if (dataBytes === 0 || !Number.isSafeInteger(audioSamples) || audioSamples <= 0) throw new AudioProbeError("corrupt", "WAV data chunk holds no complete samples");
  return { mime: "audio/wav", sampleRate: format.sampleRate, channels: format.channels, audioSamples };
}

const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_SAMPLE_RATES = [44_100, 48_000, 32_000];
function probeMp3(view: Buffer): AudioProbe {
  let offset = 0;
  if (view.subarray(0, 3).toString("latin1") === "ID3") {
    if (view.byteLength < 10) throw new AudioProbeError("corrupt", "ID3 header is truncated");
    offset = 10 + ((view[6] << 21) | (view[7] << 14) | (view[8] << 7) | view[9]);
    if (offset > view.byteLength) throw new AudioProbeError("corrupt", "ID3 tag declares more bytes than were provided");
  }
  let frames = 0;
  let channels = 2;
  while (offset < view.byteLength) {
    if (view.byteLength - offset < 4) throw new AudioProbeError("corrupt", "MP3 frame header is truncated");
    if (view[offset] !== 0xff || (view[offset + 1] & 0xe0) !== 0xe0) throw new AudioProbeError("corrupt", "MP3 frame sync not found");
    if (((view[offset + 1] >> 3) & 0x03) !== 0b11) throw new AudioProbeError("unsupported", "MP3 must be an MPEG-1 stream");
    if (((view[offset + 1] >> 1) & 0x03) !== 0b01) throw new AudioProbeError("unsupported", "MP3 must be Layer III");
    const bitrateIndex = view[offset + 2] >> 4;
    const sampleRateIndex = (view[offset + 2] >> 2) & 0x03;
    const padding = (view[offset + 2] >> 1) & 0x01;
    if (bitrateIndex === 0) throw new AudioProbeError("unsupported", "MP3 free-format bitrate is not supported");
    if (bitrateIndex === 15) throw new AudioProbeError("corrupt", "MP3 frame declares an invalid bitrate index");
    if (sampleRateIndex === 3) throw new AudioProbeError("corrupt", "MP3 frame declares a reserved sample rate");
    const sampleRate = MP3_SAMPLE_RATES[sampleRateIndex];
    if (sampleRate !== REQUIRED_AUDIO_SAMPLE_RATE) throw new AudioProbeError("unsupported", `MP3 sample rate must be ${REQUIRED_AUDIO_SAMPLE_RATE}, received ${sampleRate}`);
    channels = ((view[offset + 3] >> 6) & 0x03) === 0b11 ? 1 : 2;
    const frameLength = Math.floor((144 * MP3_BITRATES[bitrateIndex] * 1000) / sampleRate) + padding;
    if (frameLength < 4 || offset + frameLength > view.byteLength) throw new AudioProbeError("corrupt", "MP3 frame is truncated");
    frames += 1;
    offset += frameLength;
  }
  if (frames === 0) throw new AudioProbeError("corrupt", "MP3 contains no audio frames");
  return { mime: "audio/mpeg", sampleRate: REQUIRED_AUDIO_SAMPLE_RATE, channels, audioSamples: frames * 1152 };
}

export type AudioCueInput = {
  assetId: string;
  assetAudioSamples: number;
  sourceStartSample: number;
  sourceEndSample: number;
  timelineStartSample: number;
  gainDb: number;
  role: AudioCue["role"];
  scriptSegmentId: string | null;
  sourceText: string | null;
  sourceRights: AudioCue["sourceRights"];
  /** C16 additive stamps (spec 12); omitted = "auto" + unbound. */
  delivery?: DeliveryPreset;
  voiceId?: string | null;
};

/** Builds one schema-valid cue; identity is deterministic from content and ordinal unless given explicitly. */
export function buildAudioCue(input: AudioCueInput, ordinal: number, explicitId?: string): AudioCue {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new RangeError("Cue ordinal must be a nonnegative safe integer");
  if (typeof input.assetId !== "string" || input.assetId.length === 0) throw new RangeError("Audio cue requires a source asset ID");
  if (!Number.isSafeInteger(input.assetAudioSamples) || input.assetAudioSamples <= 0) throw new RangeError("Audio cue requires a source asset with a positive decoded sample count");
  if (!Number.isSafeInteger(input.sourceStartSample) || input.sourceStartSample < 0) throw new RangeError("Audio cue source start sample must be a nonnegative safe integer");
  if (!Number.isSafeInteger(input.sourceEndSample) || input.sourceEndSample <= input.sourceStartSample) throw new RangeError("Audio cue source end sample must be a safe integer that follows its start");
  if (!Number.isSafeInteger(input.timelineStartSample) || input.timelineStartSample < 0) throw new RangeError("Audio cue timeline start sample must be a nonnegative safe integer");
  if (input.sourceEndSample > input.assetAudioSamples) throw new RangeError("Audio cue source end sample exceeds its source asset's decoded sample count");
  if (typeof input.gainDb !== "number" || !Number.isFinite(input.gainDb) || input.gainDb < -60 || input.gainDb > 12) throw new RangeError("Audio cue gain must be a finite number between -60 and 12 dB");
  if (input.scriptSegmentId !== null && (typeof input.scriptSegmentId !== "string" || input.scriptSegmentId.length === 0)) throw new RangeError("Audio cue script segment must be null or a nonempty ID");
  if (input.sourceText !== null && typeof input.sourceText !== "string") throw new RangeError("Audio cue source text must be null or a string");
  const id = explicitId ?? `cue-${hashCanonicalJson({ ...input, ordinal }).slice(0, 24)}`;
  return AudioCueSchema.parse({
    id,
    assetId: input.assetId,
    sourceStartSample: input.sourceStartSample,
    sourceEndSample: input.sourceEndSample,
    timelineStartSample: input.timelineStartSample,
    gainDb: input.gainDb,
    role: input.role,
    scriptSegmentId: input.scriptSegmentId,
    sourceText: input.sourceText,
    sourceRights: input.sourceRights,
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.voiceId !== undefined ? { voiceId: input.voiceId } : {}),
  });
}

export const AUDIO_OVERLAP_POLICIES = ["strict_sequential", "layered"] as const;
export type AudioOverlapPolicy = (typeof AUDIO_OVERLAP_POLICIES)[number];
export const DEFAULT_AUDIO_OVERLAP_POLICY: AudioOverlapPolicy = "layered";
const SPOKEN_ROLES: ReadonlySet<AudioCue["role"]> = new Set(["narration", "dialogue"]);
const cueEnd = (cue: Pick<AudioCue, "timelineStartSample" | "sourceStartSample" | "sourceEndSample">) => cue.timelineStartSample + (cue.sourceEndSample - cue.sourceStartSample);

/** Enforces the explicitly chosen overlap policy: layered keeps spoken lines exclusive, strict_sequential allows no overlap. */
export function validateCueOverlaps(
  cues: ReadonlyArray<Pick<AudioCue, "id" | "role" | "timelineStartSample" | "sourceStartSample" | "sourceEndSample">>,
  policy: AudioOverlapPolicy,
): void {
  for (let first = 0; first < cues.length; first += 1) {
    for (let second = first + 1; second < cues.length; second += 1) {
      const a = cues[first];
      const b = cues[second];
      if (a.timelineStartSample >= cueEnd(b) || b.timelineStartSample >= cueEnd(a)) continue;
      if (policy === "layered" && !(SPOKEN_ROLES.has(a.role) && SPOKEN_ROLES.has(b.role))) continue;
      const [lower, upper] = a.id <= b.id ? [a, b] : [b, a];
      throw new RangeError(`Audio cues ${lower.id} and ${upper.id} overlap on the timeline, which the ${policy} overlap policy forbids`);
    }
  }
}

export interface SerializedAudioTimeline {
  sampleRate: number;
  channels: number;
  overlapPolicy: AudioOverlapPolicy;
  totalEndSample: number;
  cues: Array<{ id: string; assetId: string; role: AudioCue["role"]; timelineStartSample: number; timelineEndSample: number; sourceStartSample: number; sourceEndSample: number; gainDb: number; scriptSegmentId: string | null; sourceRights: AudioCue["sourceRights"] }>;
}
const ROLE_ORDER: Record<AudioCue["role"], number> = { narration: 0, dialogue: 1, music: 2, sfx: 3 };

/** Serializes the mix timeline in a stable timeline order; the output depends only on the mix content and the explicit policy. */
export function serializeAudioTimeline(mix: Pick<AudioMixRevision, "mixSettings" | "cues">, policy: AudioOverlapPolicy = DEFAULT_AUDIO_OVERLAP_POLICY): SerializedAudioTimeline {
  validateCueOverlaps(mix.cues, policy);
  const cues = [...mix.cues]
    .sort((a, b) => a.timelineStartSample - b.timelineStartSample || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((cue) => ({ id: cue.id, assetId: cue.assetId, role: cue.role, timelineStartSample: cue.timelineStartSample, timelineEndSample: cueEnd(cue), sourceStartSample: cue.sourceStartSample, sourceEndSample: cue.sourceEndSample, gainDb: cue.gainDb, scriptSegmentId: cue.scriptSegmentId, sourceRights: cue.sourceRights }));
  return {
    sampleRate: mix.mixSettings.sampleRate,
    channels: mix.mixSettings.channels,
    overlapPolicy: policy,
    cues,
    totalEndSample: cues.reduce((max, cue) => Math.max(max, cue.timelineEndSample), 0),
  };
}

export type NarrationAlignmentInput = { storyRevisionId: string; cues: ReadonlyArray<Pick<AudioCue, "id" | "role" | "scriptSegmentId" | "sourceText">> };
export type NarrationAlignmentIssueCode = "STALE_STORY" | "UNKNOWN_SEGMENT" | "TEXT_DRIFT";
export interface NarrationAlignmentIssue { code: NarrationAlignmentIssueCode; cueId: string | null; message: string }

/** Reports why spoken cues no longer align with the given story revision; empty means fully aligned. */
export function narrationAlignmentIssues(mix: NarrationAlignmentInput, story: Pick<StoryRevision, "id" | "beats">): NarrationAlignmentIssue[] {
  if (mix.storyRevisionId !== story.id) {
    return [{ code: "STALE_STORY", cueId: null, message: `Audio mix pins story revision ${mix.storyRevisionId}, which is not the current ${story.id}` }];
  }
  const issues: NarrationAlignmentIssue[] = [];
  const beats = new Map(story.beats.map((beat) => [beat.id, beat]));
  for (const cue of mix.cues) {
    if (cue.role !== "narration" && cue.role !== "dialogue") continue;
    if (cue.scriptSegmentId === null) {
      issues.push({ code: "UNKNOWN_SEGMENT", cueId: cue.id, message: `Spoken cue ${cue.id} does not reference a script segment` });
      continue;
    }
    const beat = beats.get(cue.scriptSegmentId);
    if (!beat) {
      issues.push({ code: "UNKNOWN_SEGMENT", cueId: cue.id, message: `Spoken cue ${cue.id} references unknown script segment ${cue.scriptSegmentId}` });
      continue;
    }
    const expected = cue.role === "narration" ? [beat.narration] : beat.dialogue.map((line) => line.text);
    if (!expected.some((text) => text === cue.sourceText)) {
      issues.push({ code: "TEXT_DRIFT", cueId: cue.id, message: `Spoken cue ${cue.id} text ${JSON.stringify(cue.sourceText)} does not match its ${cue.role} segment ${beat.id} (expected ${JSON.stringify(expected)})` });
    }
  }
  return issues;
}

export type AudioMixIdentityInput = {
  projectId: string;
  storyRevisionId: string;
  mixSettings: AudioMixRevision["mixSettings"];
  overlapPolicy: AudioOverlapPolicy;
  cues: readonly AudioCue[];
  assetChecksums: Readonly<Record<string, string>>;
};

/** Canonical, order-sensitive hash binding the mix to its story revision, settings, policy, cues, and source asset checksums. */
export function audioMixContentHash(input: AudioMixIdentityInput): string {
  return hashCanonicalJson({
    recipeVersion: 1,
    projectId: input.projectId,
    storyRevisionId: input.storyRevisionId,
    mixSettings: input.mixSettings,
    overlapPolicy: input.overlapPolicy,
    cues: input.cues.map(({ id, assetId, sourceStartSample, sourceEndSample, timelineStartSample, gainDb, role, scriptSegmentId, sourceText, sourceRights }) =>
      ({ id, assetId, sourceStartSample, sourceEndSample, timelineStartSample, gainDb, role, scriptSegmentId, sourceText, sourceRights })),
    assetChecksums: { ...input.assetChecksums },
  });
}
export const audioMixRevisionId = (contentHash: string): string => `audio-mix-${contentHash}`;
export const audioAssetId = (sha256: string): string => `audio-asset-${sha256}`;

import { describe, expect, it } from "vitest";
import {
  AudioProbeError,
  DEFAULT_AUDIO_OVERLAP_POLICY,
  MAX_IMPORT_AUDIO_BYTES,
  audioAssetId,
  audioMixContentHash,
  audioMixRevisionId,
  buildAudioCue,
  narrationAlignmentIssues,
  probeAudioBytes,
  serializeAudioTimeline,
  validateCueOverlaps,
  type AudioCueInput,
  type SerializedAudioTimeline,
} from "./audio";
import type { AudioCue, AudioMixRevision, StoryBeat } from "./contracts";
import { hashCanonicalJson } from "./hash";

const u32le = (value: number) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value, 0); return buffer; };
function wavBytes(options: { samples: number; channels?: 1 | 2; sampleRate?: number; bitsPerSample?: number; audioFormat?: number; corrupt?: "truncate" | "extend" }): Uint8Array {
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 48_000;
  const bits = options.bitsPerSample ?? 16;
  const blockAlign = (channels * bits) / 8;
  const dataBytes = options.samples * blockAlign;
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(options.audioFormat ?? 1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bits, 14);
  const header = Buffer.concat([Buffer.from("RIFF"), u32le(36 + dataBytes), Buffer.from("WAVE"), Buffer.from("fmt "), u32le(16), fmt, Buffer.from("data"), u32le(dataBytes)]);
  const data = Buffer.alloc(dataBytes, 7);
  if (options.corrupt === "truncate") return new Uint8Array(Buffer.concat([header, data.subarray(Math.max(0, dataBytes - 2))]));
  if (options.corrupt === "extend") return new Uint8Array(Buffer.concat([header, data, Buffer.alloc(3, 1)]));
  return new Uint8Array(Buffer.concat([header, data]));
}
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
function mp3Frame(options: { versionBits?: number; layerBits?: number; bitrateIndex?: number; sampleRateIndex?: number; padding?: number; mode?: number; garbageBody?: boolean } = {}): Buffer {
  const versionBits = options.versionBits ?? 0b11;
  const layerBits = options.layerBits ?? 0b01;
  const bitrateIndex = options.bitrateIndex ?? 5;
  const sampleRateIndex = options.sampleRateIndex ?? 1;
  const padding = options.padding ?? 0;
  const header = Buffer.from([
    0xff,
    (0b111 << 5) | (versionBits << 3) | (layerBits << 1) | 0b1,
    (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding << 1),
    (options.mode ?? 0b00) << 6,
  ]);
  if (options.garbageBody || !(bitrateIndex in MP3_BITRATES) || MP3_BITRATES[bitrateIndex] === 0) return Buffer.concat([header, Buffer.alloc(60, 0x3a)]);
  const bitrate = MP3_BITRATES[bitrateIndex]! * 1000;
  const frameLength = Math.floor((144 * bitrate) / 48_000) + padding;
  return Buffer.concat([header, Buffer.alloc(Math.max(4, frameLength) - 4, 0x55)]);
}
function id3Header(size: number): Buffer {
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0]), Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])]);
}

describe("audio import probe", () => {
  it("parses 48kHz PCM WAV bytes into an exact sample count", () => {
    expect(probeAudioBytes(wavBytes({ samples: 4800 }))).toEqual({ mime: "audio/wav", sampleRate: 48_000, channels: 1, audioSamples: 4800 });
    expect(probeAudioBytes(wavBytes({ samples: 2400, channels: 2 }))).toEqual({ mime: "audio/wav", sampleRate: 48_000, channels: 2, audioSamples: 2400 });
  });
  it("rejects unsupported WAV codecs, sample rates, bit depths, and empty data fail-closed", () => {
    expect(() => probeAudioBytes(wavBytes({ samples: 10, sampleRate: 44_100 }))).toThrow(AudioProbeError);
    expect(() => probeAudioBytes(wavBytes({ samples: 10, sampleRate: 44_100 }))).toThrow(/48000/);
    expect(() => probeAudioBytes(wavBytes({ samples: 10, audioFormat: 3 }))).toThrow(/compressed/);
    expect(() => probeAudioBytes(wavBytes({ samples: 10, bitsPerSample: 8 }))).toThrow(/16-bit/);
    expect(() => probeAudioBytes(wavBytes({ samples: 0 }))).toThrow(/complete samples/);
  });
  it("rejects corrupt WAV structure without any recovery", () => {
    expect(() => probeAudioBytes(wavBytes({ samples: 10, corrupt: "truncate" }))).toThrow(/truncated|more bytes than/i);
    expect(() => probeAudioBytes(wavBytes({ samples: 10, corrupt: "extend" }))).toThrow(/trailing|structure/i);
    expect(() => probeAudioBytes(new Uint8Array(Buffer.from("not audio at all")))).toThrow(AudioProbeError);
    expect(() => probeAudioBytes(new Uint8Array(0))).toThrow(/empty/i);
  });
  it("enforces strict injectable and default size bounds", () => {
    expect(() => probeAudioBytes(wavBytes({ samples: 8 }), { maxBytes: 16 })).toThrow(AudioProbeError);
    try { probeAudioBytes(wavBytes({ samples: 8 }), { maxBytes: 16 }); } catch (error) { expect((error as AudioProbeError).reason).toBe("oversize"); }
    expect(MAX_IMPORT_AUDIO_BYTES).toBe(100 * 1024 * 1024);
  });
  it("parses MPEG-1 Layer III 48kHz frames including ID3v2 prefixes and padding", () => {
    expect(probeAudioBytes(new Uint8Array(Buffer.concat([mp3Frame(), mp3Frame(), mp3Frame()])))).toEqual({ mime: "audio/mpeg", sampleRate: 48_000, channels: 2, audioSamples: 3456 });
    expect(probeAudioBytes(new Uint8Array(Buffer.concat([mp3Frame({ padding: 1 }), mp3Frame()]))).audioSamples).toBe(2304);
    const id3Body = Buffer.alloc(200, 0x11);
    expect(probeAudioBytes(new Uint8Array(Buffer.concat([id3Header(id3Body.length), id3Body, mp3Frame()]))).audioSamples).toBe(1152);
    expect(probeAudioBytes(new Uint8Array(Buffer.concat([mp3Frame({ mode: 0b11 })]))).channels).toBe(1);
  });
  it("rejects unsupported MP3 variants and corrupt frame streams", () => {
    expect(() => probeAudioBytes(new Uint8Array(mp3Frame({ sampleRateIndex: 0 })))).toThrow(/48000/);
    expect(() => probeAudioBytes(new Uint8Array(mp3Frame({ layerBits: 0b10 })))).toThrow(/Layer III/);
    expect(() => probeAudioBytes(new Uint8Array(mp3Frame({ versionBits: 0b10 })))).toThrow(/MPEG-1/);
    expect(() => probeAudioBytes(new Uint8Array(mp3Frame({ bitrateIndex: 0 })))).toThrow(/free/);
    expect(() => probeAudioBytes(new Uint8Array(mp3Frame({ bitrateIndex: 15 })))).toThrow(/invalid/i);
    expect(() => probeAudioBytes(new Uint8Array(Buffer.concat([mp3Frame(), mp3Frame().subarray(0, 60)])))).toThrow(/truncated/i);
    expect(() => probeAudioBytes(new Uint8Array(Buffer.concat([mp3Frame(), Buffer.alloc(50, 0x21)])))).toThrow(/sync/i);
    expect(() => probeAudioBytes(new Uint8Array(Buffer.concat([mp3Frame({ garbageBody: true }), mp3Frame()])))).toThrow(/sync|truncated|invalid/i);
  });
});

const asset = { id: "asset-narration", audioSamples: 4800 };
const narrationCueInput: AudioCueInput = {
  assetId: asset.id, assetAudioSamples: asset.audioSamples,
  sourceStartSample: 0, sourceEndSample: 2400, timelineStartSample: 0,
  gainDb: -3, role: "narration",
  scriptSegmentId: "beat_1", sourceText: "A door opens.", sourceRights: "creator_attested",
};

describe("audio cue construction", () => {
  it("builds a schema-valid cue with deterministic content-derived identity", () => {
    const cue = buildAudioCue(narrationCueInput, 0);
    expect(cue.id).toBe(buildAudioCue(narrationCueInput, 0).id);
    expect(cue.id).toMatch(/^cue-/);
    expect(cue.sourceEndSample).toBe(2400);
  });
  it("rejects negative or reversed sample bounds", () => {
    expect(() => buildAudioCue({ ...narrationCueInput, sourceStartSample: -1 }, 0)).toThrow(/nonnegative/);
    expect(() => buildAudioCue({ ...narrationCueInput, sourceEndSample: 0 }, 0)).toThrow(/follow/);
    expect(() => buildAudioCue({ ...narrationCueInput, timelineStartSample: -4 }, 0)).toThrow(/nonnegative/);
    expect(() => buildAudioCue({ ...narrationCueInput, sourceStartSample: 1.5 }, 0)).toThrow(/safe integer/);
  });
  it("rejects out-of-bound gain values including non-finite numbers", () => {
    expect(() => buildAudioCue({ ...narrationCueInput, gainDb: 12.1 }, 0)).toThrow(/gain/);
    expect(() => buildAudioCue({ ...narrationCueInput, gainDb: -60.1 }, 0)).toThrow(/gain/);
    expect(() => buildAudioCue({ ...narrationCueInput, gainDb: Number.NaN }, 0)).toThrow(/gain/);
    expect(buildAudioCue({ ...narrationCueInput, gainDb: 12 }, 0).gainDb).toBe(12);
    expect(buildAudioCue({ ...narrationCueInput, gainDb: -60 }, 0).gainDb).toBe(-60);
  });
  it("binds the cue to the source asset provenance window", () => {
    expect(() => buildAudioCue({ ...narrationCueInput, sourceEndSample: 4801 }, 0)).toThrow(/asset/);
    expect(() => buildAudioCue({ ...narrationCueInput, assetAudioSamples: null as unknown as number }, 0)).toThrow(/asset/);
    expect(() => buildAudioCue({ ...narrationCueInput, assetId: "" }, 0)).toThrow(/asset/);
  });
});

const mixCue = (overrides: Partial<typeof narrationCueInput> = {}, id = "cue-a"): AudioCue =>
  buildAudioCue({ ...narrationCueInput, ...overrides }, 0, id);
const span = (start: number, length: number) => ({ sourceStartSample: 0, sourceEndSample: length, timelineStartSample: start });

describe("explicit cue overlap policy", () => {
  it("layered policy allows music and sfx over spoken cues but never spoken over spoken", () => {
    const spoken = mixCue({ ...span(0, 2400) }, "cue-spoken");
    const music = mixCue({ ...span(0, 4800), role: "music", scriptSegmentId: null, sourceText: null }, "cue-music");
    const sfx = mixCue({ ...span(1000, 200), role: "sfx", scriptSegmentId: null, sourceText: null }, "cue-sfx");
    expect(() => validateCueOverlaps([spoken, music, sfx], "layered")).not.toThrow();
    const secondSpoken = mixCue({ ...span(1000, 2400) }, "cue-spoken-2");
    expect(() => validateCueOverlaps([spoken, secondSpoken], "layered")).toThrow(/overlap/);
  });
  it("strict sequential policy rejects any timeline overlap and accepts gapless or gapped sequences", () => {
    const first = mixCue({ ...span(0, 2400) }, "cue-1");
    const second = mixCue({ ...span(2400, 2400) }, "cue-2");
    expect(() => validateCueOverlaps([first, second], "strict_sequential")).not.toThrow();
    const overlapping = mixCue({ ...span(2399, 2400) }, "cue-3");
    expect(() => validateCueOverlaps([first, overlapping], "strict_sequential")).toThrow(/cue-1.*cue-3|cue-3.*cue-1/);
  });
  it("defaults to the explicit layered policy", () => {
    expect(DEFAULT_AUDIO_OVERLAP_POLICY).toBe("layered");
  });
});

const mixSettings = { sampleRate: 48_000 as const, channels: 2 as const, loudnessTargetLufs: -16, truePeakLimitDbtp: -1.5, muteNativeAudio: true };

describe("deterministic audio timeline serialization", () => {
  const cues = [
    mixCue({ ...span(2400, 2400) }, "cue-late"),
    mixCue({ ...span(0, 2400) }, "cue-early"),
    mixCue({ ...span(0, 4800), role: "music", scriptSegmentId: null, sourceText: null }, "cue-music"),
  ];
  const serialize = (order: AudioCue[]) => serializeAudioTimeline({ mixSettings, cues: order }, "layered");
  it("serializes cues in a stable timeline order independent of input order", () => {
    const forward: SerializedAudioTimeline = serialize(cues);
    const reversed: SerializedAudioTimeline = serialize([...cues].reverse());
    expect(forward.cues.map((cue) => cue.id)).toEqual(["cue-early", "cue-music", "cue-late"]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.totalEndSample).toBe(4800);
    expect(forward.cues[2]!.timelineEndSample).toBe(4800);
  });
  it("serializes an empty mix deterministically at zero length", () => {
    const empty = serializeAudioTimeline({ mixSettings, cues: [] }, "layered");
    expect(empty.cues).toEqual([]);
    expect(empty.totalEndSample).toBe(0);
  });
  it("fails closed when serialization is asked to represent an overlap the policy forbids", () => {
    const overlapping = [mixCue({ ...span(0, 2400) }, "cue-a"), mixCue({ ...span(0, 2400) }, "cue-b")];
    expect(() => serializeAudioTimeline({ mixSettings, cues: overlapping }, "strict_sequential")).toThrow(/overlap/);
  });
});

const beat = (id: string, narration: string, dialogue: Array<{ characterId: string; text: string }> = []): StoryBeat => ({ id, action: `Action for ${id}`, narration, dialogue, order: 0 });
const story = { id: "story-1", beats: [beat("beat_1", "A door opens."), beat("beat_2", "", [{ characterId: "narrator", text: "Someone enters." }])] };

describe("narration alignment against the exact story revision", () => {
  it("reports no issues when spoken cues reference the pinned story revision text", () => {
    const cues = [
      mixCue({ scriptSegmentId: "beat_1", sourceText: "A door opens." }, "cue-n1"),
      mixCue({ role: "dialogue", scriptSegmentId: "beat_2", sourceText: "Someone enters." }, "cue-d1"),
      mixCue({ role: "music", scriptSegmentId: null, sourceText: null }, "cue-m1"),
    ];
    expect(narrationAlignmentIssues({ storyRevisionId: "story-1", cues }, story)).toEqual([]);
  });
  it("reports stale alignment when the mix pins a different story revision", () => {
    const issues = narrationAlignmentIssues({ storyRevisionId: "story-0", cues: [mixCue({}, "cue-n1")] }, story);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("STALE_STORY");
  });
  it("reports unknown segments and drifted text per cue", () => {
    const issues = narrationAlignmentIssues({
      storyRevisionId: "story-1",
      cues: [
        mixCue({ scriptSegmentId: "beat_missing", sourceText: "A door opens." }, "cue-lost"),
        mixCue({ scriptSegmentId: null }, "cue-unbound"),
        mixCue({ scriptSegmentId: "beat_1", sourceText: "A door closes." }, "cue-drift"),
        mixCue({ role: "dialogue", scriptSegmentId: "beat_1", sourceText: "Someone enters." }, "cue-wrong-role-text"),
      ],
    }, story);
    expect(issues.map((issue) => [issue.cueId, issue.code])).toEqual([
      ["cue-lost", "UNKNOWN_SEGMENT"], ["cue-unbound", "UNKNOWN_SEGMENT"], ["cue-drift", "TEXT_DRIFT"], ["cue-wrong-role-text", "TEXT_DRIFT"],
    ]);
  });
});

describe("immutable mix identity", () => {
  const identity = { projectId: "project-1", storyRevisionId: "story-1", mixSettings, overlapPolicy: "layered" as const };
  it("binds the mix hash to cues, story revision, settings, policy, and source asset checksums", () => {
    const cues = [mixCue({}, "cue-a"), mixCue({ timelineStartSample: 2400, sourceStartSample: 2400, sourceEndSample: 4800 }, "cue-b")];
    const checksums = { [asset.id]: "a".repeat(64) };
    const base = audioMixContentHash({ ...identity, cues, assetChecksums: checksums });
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(audioMixContentHash({ ...identity, cues: [...cues].reverse(), assetChecksums: checksums })).not.toBe(base);
    expect(audioMixContentHash({ ...identity, cues, assetChecksums: { [asset.id]: "b".repeat(64) } })).not.toBe(base);
    expect(audioMixContentHash({ ...identity, storyRevisionId: "story-2", cues, assetChecksums: checksums })).not.toBe(base);
    expect(audioMixContentHash({ ...identity, overlapPolicy: "strict_sequential", cues, assetChecksums: checksums })).not.toBe(base);
    expect(audioMixRevisionId(base)).toBe(`audio-mix-${base}`);
    expect(audioAssetId(checksums[asset.id]!)).toBe(`audio-asset-${checksums[asset.id]}`);
  });
  it("documents the exact canonical hash recipe", () => {
    const cues = [mixCue({}, "cue-a")];
    const hash = audioMixContentHash({ ...identity, cues, assetChecksums: {} });
    const mix: AudioMixRevision = { version: 1, id: audioMixRevisionId(hash), projectId: identity.projectId, storyRevisionId: identity.storyRevisionId, cues, mixSettings, contentHash: hash, createdAt: 1 };
    expect(mix.contentHash).toBe(hashCanonicalJson({ recipeVersion: 1, projectId: identity.projectId, storyRevisionId: identity.storyRevisionId, mixSettings, overlapPolicy: "layered", cues: cues.map(({ id, assetId, sourceStartSample, sourceEndSample, timelineStartSample, gainDb, role, scriptSegmentId, sourceText, sourceRights }) => ({ id, assetId, sourceStartSample, sourceEndSample, timelineStartSample, gainDb, role, scriptSegmentId, sourceText, sourceRights })), assetChecksums: {} }));
  });
});

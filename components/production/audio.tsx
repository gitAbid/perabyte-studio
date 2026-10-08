"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  DEFAULT_AUDIO_OVERLAP_POLICY, buildAudioCue, narrationAlignmentIssues, serializeAudioTimeline,
  validateCueOverlaps, type AudioOverlapPolicy, type SerializedAudioTimeline,
} from "../../lib/production/audio";
import {
  AssetSchema, ProjectReadModelSchema, type Asset, type AudioCue, type AudioMixRevision,
  type ProjectReadModel, type SaveAudioMixCommand, type StoryBeat, type StoryRevision,
} from "../../lib/production/contracts";
import { deriveSpeechPlanRows, mixApprovalReadiness } from "@/lib/services/production/audio-mix";
import { EMPTY_VOICES_STORE, type VoicesStoreV1 } from "@/lib/voices/read-model";
import { loadVoicesStoreClient, migrateClientVoicesOnce } from "@/lib/voices/client-sync";
import type { DeliveryPreset } from "@/lib/production/contracts";
import { deriveStaleDependencyNotices } from "../../lib/production/project-canon";

/**
 * C10 audio cue workspace. All save/overlap/alignment rules are re-executed client-side through
 * the accepted pure domain validators (never reimplemented) so a disabled Save and the server's
 * 4xx/409 cannot disagree; the network boundary is plain HTTP against the existing routes.
 */

export const ANIMATIC_SAMPLES_PER_FRAME = 2000;
export const PREVIEW_SAMPLE_RATE = 48_000;
/** Exactly the rights statuses the import route accepts (route is the authority). */
export const rightsStatusOptions = ["creator_attested", "licensed", "public_domain"] as const;
/** Display-only defaults; the literals live in contracts.ts AudioMixSettingsSchema bounds. */
export const DEFAULT_MIX_SETTINGS = {
  sampleRate: 48_000, channels: 2, loudnessTargetLufs: -14, truePeakLimitDbtp: -1, muteNativeAudio: true,
} as const;

export type UploadOutcome = { phase: "ready"; asset: Asset } | { phase: "failed"; message: string };
export type CatalogEntry = {
  assetId: string;
  /** null when the asset is only recoverable from the active mix's cue rows. */
  asset: Asset | null;
  /** null means provenance is unavailable until the file is re-imported in this session. */
  provenance: "session" | null;
  /** Known source-length bound: audioSamples for session assets, known cue end for recovered ones. */
  maxKnownSamples: number | null;
  sourceRights: AudioCue["sourceRights"];
};
export type CueDraft = {
  key: string;
  /** Persisted cue id when the draft mirrors a cue of the active mix; null for new cues. */
  fromMixId: string | null;
  assetId: string;
  role: AudioCue["role"];
  timelineStartSample: number;
  sourceStartSample: number;
  sourceEndSample: number;
  gainDb: number;
  scriptSegmentId: string | null;
  sourceText: string | null;
  sourceRights: AudioCue["sourceRights"];
  delivery: DeliveryPreset;
  voiceId: string | null;
};
export type CueIssue = {
  cueKey: string | null;
  kind: "MISSING_ASSET" | "SOURCE_RANGE" | "GAIN" | "OVERLAP" | "ALIGNMENT" | "OVERFLOW" | "STALE_STORY";
  message: string;
};
export type SaveReadinessContext = {
  projectId: string;
  activeStoryRevisionId: string;
  audioMixVersion: number;
  storyRevision: StoryRevision;
  /** totalFrames * ANIMATIC_SAMPLES_PER_FRAME, or null when no animatic exists (tier not evaluated). */
  animaticTotalSamples: number | null;
};
export type SaveReadiness = { ok: true; command: SaveAudioMixCommand } | { ok: false; issues: CueIssue[] };
export type StaleNarrationNotice = {
  code: "MIX_STORY_PINNED" | "STALE_STORY" | "UNKNOWN_SEGMENT" | "TEXT_DRIFT" | "DEPENDENCY";
  cueId: string | null;
  message: string;
};
export type TimelineView = {
  sampleRate: number;
  channels: number;
  overlapPolicy: AudioOverlapPolicy;
  totalEndSample: number;
  rows: Array<SerializedAudioTimeline["cues"][number] & { provenance: "session" | "recovered" }>;
};

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const cueRightsFor = (status: Asset["rightsStatus"]): AudioCue["sourceRights"] =>
  status === "creator_attested" || status === "licensed" || status === "public_domain" || status === "provider" || status === "unknown"
    ? status
    : "unknown";

/** Integer-only sample display: "48001" -> "1.001s"; stored values never carry floating seconds. */
export function samplesToDisplayTime(samples: number): string {
  const safe = Number.isFinite(samples) ? Math.max(0, Math.trunc(samples)) : 0;
  const totalMs = Math.floor((safe + 47) / 48); // ceil(safe * 1000 / 48_000)
  const whole = Math.trunc(totalMs / 1000);
  return `${whole}.${String(totalMs - whole * 1000).padStart(3, "0")}s`;
}

function uploadHint(status: number, code: string, message: string): string {
  if (status === 413 || /exceeds the allowed size|size limit/i.test(message)) return "Choose an audio file under the 100 MB import limit.";
  if (code === "MEDIA_UNAVAILABLE") return "Export the file as a 48 kHz, 16-bit PCM WAV (or MP3) and import it again.";
  if (code === "STALE_REVISION") return "The audio mix or script changed; reload to continue.";
  return "Check the file and the source/rights fields, then retry.";
}

/**
 * Maps one import-route response onto the upload state machine. Ready requires a 2xx status AND a
 * body whose asset parses against the accepted AssetSchema; every other shape fails closed with a
 * message that names the envelope code and requestId (or "network error" when nothing answered).
 */
export function deriveUploadOutcome(status: number | null, payload: unknown): UploadOutcome {
  if (status !== null && status >= 200 && status < 300) {
    const asset = plainObject(payload) && "asset" in payload ? AssetSchema.safeParse(payload.asset) : null;
    if (asset?.success) return { phase: "ready", asset: asset.data };
    return { phase: "failed", message: "Upload response was not a valid audio asset; nothing was imported. Retry the import." };
  }
  if (status === null) return { phase: "failed", message: "Upload failed: network error — the local studio server could not be reached. Retry once it is running." };
  const envelope = plainObject(payload) && plainObject(payload.error) ? payload.error : null;
  const code = typeof envelope?.code === "string" ? envelope.code : "UNKNOWN";
  const message = typeof envelope?.message === "string" ? envelope.message : "The import was rejected.";
  const requestId = plainObject(payload) && typeof payload.requestId === "string" ? payload.requestId : "unknown";
  return { phase: "failed", message: `${code}: ${message} (requestId ${requestId}) — ${uploadHint(status, code, message)}` };
}

function describeResponseError(status: number, payload: unknown, fallback: string): string {
  const envelope = plainObject(payload) && plainObject(payload.error) ? payload.error : null;
  const code = typeof envelope?.code === "string" ? envelope.code : "UNKNOWN";
  const message = typeof envelope?.message === "string" ? envelope.message : fallback;
  const requestId = plainObject(payload) && typeof payload.requestId === "string" ? payload.requestId : "unknown";
  return `${code}: ${message} (requestId ${requestId}) — ${uploadHint(status, code, message)}`;
}

/** Session uploads first; recovered active-mix cue assets follow with honest null provenance. */
export function deriveMixCatalog(readModel: Pick<ProjectReadModel, "audioMixRevision"> | null, sessionAssets: readonly Asset[]): CatalogEntry[] {
  const entries = new Map<string, CatalogEntry>();
  for (const asset of sessionAssets) {
    entries.set(asset.id, { assetId: asset.id, asset, provenance: "session", maxKnownSamples: asset.audioSamples, sourceRights: cueRightsFor(asset.rightsStatus) });
  }
  for (const cue of readModel?.audioMixRevision?.cues ?? []) {
    const existing = entries.get(cue.assetId);
    if (existing?.asset) continue;
    const knownMax = existing?.maxKnownSamples ?? 0;
    if (cue.sourceEndSample > knownMax) {
      entries.set(cue.assetId, { assetId: cue.assetId, asset: null, provenance: null, maxKnownSamples: cue.sourceEndSample, sourceRights: cue.sourceRights });
    } else if (!existing) {
      entries.set(cue.assetId, { assetId: cue.assetId, asset: null, provenance: null, maxKnownSamples: cue.sourceEndSample, sourceRights: cue.sourceRights });
    }
  }
  return [...entries.values()];
}

const draftBound = (draft: CueDraft, catalog: readonly CatalogEntry[]): number | null => {
  const entry = catalog.find((candidate) => candidate.assetId === draft.assetId);
  if (!entry) return null;
  return entry.asset?.audioSamples ?? entry.maxKnownSamples;
};

/** Input-level clamp helper: keeps source start < source end within the known bound, gain in range. */
export function clampCueDraft(draft: CueDraft, maxSourceSamples: number): CueDraft {
  const bound = Number.isSafeInteger(maxSourceSamples) && maxSourceSamples > 0 ? maxSourceSamples : 1;
  const intOr = (value: number, fallback: number) => (Number.isFinite(value) ? Math.trunc(value) : fallback);
  const sourceStartSample = Math.min(Math.max(0, intOr(draft.sourceStartSample, 0)), bound - 1);
  const sourceEndSample = Math.min(Math.max(sourceStartSample + 1, intOr(draft.sourceEndSample, sourceStartSample + 1)), bound);
  return {
    ...draft,
    sourceStartSample,
    sourceEndSample,
    timelineStartSample: Math.max(0, intOr(draft.timelineStartSample, 0)),
    gainDb: Math.min(12, Math.max(-60, Number.isFinite(draft.gainDb) ? draft.gainDb : 0)),
  };
}

/** The exact text equality narrationAlignmentIssues enforces for spoken cues. */
export function beatSourceText(beat: StoryBeat, role: AudioCue["role"], dialogueIndex = 0): string | null {
  if (role === "narration") return beat.narration;
  if (role === "dialogue") return beat.dialogue[dialogueIndex]?.text ?? null;
  return null;
}

/**
 * Full save preflight: per-draft catalog/bound checks, the accepted buildAudioCue, then
 * narrationAlignmentIssues, validateCueOverlaps and the two-tier overflow rule. Any issue
 * disables Save; the command only exists when every accepted validator passed.
 */
export function deriveCueSaveReadiness(drafts: readonly CueDraft[], catalog: readonly CatalogEntry[], context: SaveReadinessContext): SaveReadiness {
  const issues: CueIssue[] = [];
  const built: AudioCue[] = [];
  drafts.forEach((draft, ordinal) => {
    const entry = catalog.find((candidate) => candidate.assetId === draft.assetId);
    if (!entry || (entry.asset === null && draft.fromMixId === null)) {
      issues.push({
        cueKey: draft.key,
        kind: "MISSING_ASSET",
        message: entry
          ? `Cue ${draft.key} references an asset that is only recoverable from the saved mix; re-import the file in this session before creating new cues with it.`
          : `Cue ${draft.key} references an asset that is no longer in the session catalog; pick an imported file.`,
      });
      return;
    }
    const bound = entry.asset?.audioSamples ?? entry.maxKnownSamples;
    if (bound === null || !Number.isSafeInteger(bound) || bound <= 0) {
      issues.push({ cueKey: draft.key, kind: "MISSING_ASSET", message: `Cue ${draft.key}'s asset has no decoded audio sample count; import it through the audio importer.` });
      return;
    }
    if (Number.isFinite(draft.sourceEndSample) && draft.sourceEndSample > bound) {
      issues.push({
        cueKey: draft.key,
        kind: "SOURCE_RANGE",
        message: `Cue ${draft.key} source end ${draft.sourceEndSample} samples (${samplesToDisplayTime(draft.sourceEndSample)}) exceeds the ${entry.asset ? "asset" : "re-imported asset"} bound of ${bound} samples (${samplesToDisplayTime(bound)}); trim the cue or import a longer file.`,
      });
      return;
    }
    try {
      built.push(buildAudioCue({
        assetId: draft.assetId,
        assetAudioSamples: bound,
        sourceStartSample: draft.sourceStartSample,
        sourceEndSample: draft.sourceEndSample,
        timelineStartSample: draft.timelineStartSample,
        gainDb: draft.gainDb,
        role: draft.role,
        scriptSegmentId: draft.scriptSegmentId,
        sourceText: draft.sourceText,
        sourceRights: draft.sourceRights,
        delivery: draft.delivery,
        voiceId: draft.voiceId,
      }, ordinal));
    } catch (error) {
      const message = error instanceof Error ? error.message : `Cue ${draft.key} is invalid.`;
      issues.push({ cueKey: draft.key, kind: /gain/i.test(message) ? "GAIN" : "SOURCE_RANGE", message });
    }
  });
  if (issues.length === 0) {
    const alignment = narrationAlignmentIssues(
      { storyRevisionId: context.activeStoryRevisionId, cues: built },
      { id: context.storyRevision.id, beats: context.storyRevision.beats },
    );
    for (const issue of alignment) {
      issues.push({ cueKey: issue.cueId, kind: issue.code === "STALE_STORY" ? "STALE_STORY" : "ALIGNMENT", message: issue.message });
    }
    try {
      validateCueOverlaps(built, DEFAULT_AUDIO_OVERLAP_POLICY);
    } catch (error) {
      issues.push({ cueKey: null, kind: "OVERLAP", message: error instanceof Error ? error.message : "Cues overlap on the timeline." });
    }
    if (context.animaticTotalSamples !== null) {
      for (const cue of built) {
        const end = cue.timelineStartSample + (cue.sourceEndSample - cue.sourceStartSample);
        if (end > context.animaticTotalSamples) {
          issues.push({
            cueKey: cue.id,
            kind: "OVERFLOW",
            message: `Cue ${cue.id} ends at sample ${end} (${samplesToDisplayTime(end)}), past the animatic length of ${context.animaticTotalSamples} samples (${samplesToDisplayTime(context.animaticTotalSamples)}); trim the cue or move it earlier on the timeline.`,
          });
        }
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    command: {
      projectId: context.projectId,
      expectedAudioVersion: context.audioMixVersion,
      expectedStoryRevisionId: context.activeStoryRevisionId,
      cues: built.map(({ id: _id, ...cueInput }) => cueInput),
      mixSettings: { ...DEFAULT_MIX_SETTINGS },
    },
  };
}

/** Ordered stale-narration rows: pinned-mix banner, audio dependency notices, per-cue alignment. */
export function deriveStaleNarrationNotices(readModel: Pick<ProjectReadModel, "schemaVersion" | "dependencyIssues" | "audioMixRevision" | "storyRevision">): StaleNarrationNotice[] {
  const notices: StaleNarrationNotice[] = [];
  const mix = readModel.audioMixRevision;
  const story = readModel.storyRevision;
  if (mix && story && mix.storyRevisionId !== story.id) {
    notices.push({ code: "MIX_STORY_PINNED", cueId: null, message: `Audio mix ${mix.id} is pinned to story revision ${mix.storyRevisionId}, while the active script is ${story.id}. Re-align or re-save the mix against the current script.` });
  }
  const derived = deriveStaleDependencyNotices(readModel);
  if (derived.ok) {
    for (const row of derived.value) {
      if (row.targetKind !== "audio") continue;
      notices.push({ code: "DEPENDENCY", cueId: null, message: row.message });
    }
  }
  if (mix && story) {
    for (const issue of narrationAlignmentIssues({ storyRevisionId: mix.storyRevisionId, cues: mix.cues }, { id: story.id, beats: story.beats })) {
      notices.push({ code: issue.code === "STALE_STORY" ? "STALE_STORY" : issue.code, cueId: issue.cueId, message: issue.message });
    }
  }
  return notices;
}

/** Read-only active-mix timeline via the accepted serializer; a policy-violating mix degrades to null. */
export function deriveTimelineView(mix: Pick<AudioMixRevision, "mixSettings" | "cues"> | null, catalog: readonly CatalogEntry[]): TimelineView | null {
  if (!mix) return null;
  let timeline: SerializedAudioTimeline;
  try {
    timeline = serializeAudioTimeline(mix);
  } catch {
    return null;
  }
  const session = new Set(catalog.filter((entry) => entry.asset !== null).map((entry) => entry.assetId));
  return {
    sampleRate: timeline.sampleRate,
    channels: timeline.channels,
    overlapPolicy: timeline.overlapPolicy,
    totalEndSample: timeline.totalEndSample,
    rows: timeline.cues.map((cue) => ({ ...cue, provenance: session.has(cue.assetId) ? ("session" as const) : ("recovered" as const) })),
  };
}

const BADGE_CLASS = "inline-flex items-center gap-1 rounded-[5px] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em]";
const BUTTON_CLASS = "inline-flex h-9 items-center justify-center gap-1.5 rounded-[7px] px-3.5 text-[13px] font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55";
const PRIMARY_BUTTON = `${BUTTON_CLASS} bg-primary-strong text-white hover:bg-primary-dark`;
const SECONDARY_BUTTON = `${BUTTON_CLASS} border border-border-strong bg-raised text-ink hover:border-muted hover:bg-surface`;
const INPUT_CLASS = "w-full rounded-[7px] border border-border-strong bg-surface px-2.5 py-2 text-[13px] text-ink focus:border-primary focus:outline-none";
const LABEL_CLASS = "block text-[11px] font-bold uppercase tracking-[0.08em] text-muted";

interface SessionUpload { asset: Asset; file: File | null }

function seedDraftFromCue(cue: AudioCue): CueDraft {
  return {
    key: cue.id, fromMixId: cue.id, assetId: cue.assetId, role: cue.role, timelineStartSample: cue.timelineStartSample,
    sourceStartSample: cue.sourceStartSample, sourceEndSample: cue.sourceEndSample, gainDb: cue.gainDb,
    scriptSegmentId: cue.scriptSegmentId, sourceText: cue.sourceText, sourceRights: cue.sourceRights,
    delivery: cue.delivery ?? "auto", voiceId: cue.voiceId ?? null,
  };
}

function numberFromInput(raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function PreviewTransport({ asset, file }: { asset: Asset; file: File }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [samples, setSamples] = useState(0);
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const durationSamples = asset.audioSamples ?? 0;
  const bounded = Math.min(Math.max(0, samples), durationSamples);
  return (
    <figure className="mt-3 border-t border-border pt-3" data-testid="preview">
      <audio
        ref={audioRef}
        src={url}
        preload="auto"
        data-testid="preview-element"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setSamples(Math.round(event.currentTarget.currentTime * PREVIEW_SAMPLE_RATE))}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={SECONDARY_BUTTON}
          aria-label={playing ? "Pause preview" : "Play preview"}
          data-preview-state={playing ? "playing" : "paused"}
          onClick={() => {
            const element = audioRef.current;
            if (!element) return;
            if (element.paused) void element.play().catch(() => setPlaying(false));
            else element.pause();
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          className="min-w-[160px] flex-1 accent-primary"
          aria-label="Seek preview"
          data-testid="seek"
          min={0}
          max={Math.max(durationSamples, 1)}
          step={1}
          value={bounded}
          onChange={(event) => {
            const next = numberFromInput(event.target.value, bounded);
            const clamped = Math.min(Math.max(0, Math.trunc(next)), durationSamples);
            setSamples(clamped);
            const element = audioRef.current;
            if (element) element.currentTime = clamped / PREVIEW_SAMPLE_RATE;
          }}
        />
        <span className="font-mono text-[12px] text-ink" data-testid="preview-time" data-preview-state={playing ? "playing" : "paused"}>
          {samplesToDisplayTime(bounded)}
        </span>
      </div>
      <figcaption className="mt-1 text-[11px] text-muted">In-session preview of the uploaded file (48 kHz reference clock).</figcaption>
    </figure>
  );
}

export function AudioCueWorkspace({ projectId }: { projectId: string }) {
  const [readModel, setReadModel] = useState<ProjectReadModel | null>(null);
  const [loadPhase, setLoadPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<SessionUpload[]>([]);
  const [uploadPhase, setUploadPhase] = useState<"idle" | "uploading" | "ready" | "failed">("idle");
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [readyAssetId, setReadyAssetId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("");
  const [rightsAttestation, setRightsAttestation] = useState("");
  const [rightsStatus, setRightsStatus] = useState<(typeof rightsStatusOptions)[number]>("creator_attested");
  const [drafts, setDrafts] = useState<CueDraft[]>([]);
  const [saveState, setSaveState] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved"; revisionId: string; contentHash: string; created: boolean } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const [voices, setVoices] = useState<VoicesStoreV1>(EMPTY_VOICES_STORE);
  const [tts, setTts] = useState<{ available: boolean; busy: boolean }>({ available: false, busy: false });
  const [approval, setApproval] = useState<{ phase: "idle" | "recording" } | { phase: "recorded"; approvalId: string } | { phase: "failed"; message: string }>({ phase: "idle" });
  const [newRole, setNewRole] = useState<AudioCue["role"]>("music");
  const [newBeatId, setNewBeatId] = useState("");
  const [newDialogueIndex, setNewDialogueIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async (reason: "mount" | "manual" | "after-save") => {
    setLoadPhase("loading");
    setLoadError(null);
    try {
      const response = await fetch(`/api/production/projects/${projectId}`, { cache: "no-store" });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => undefined);
        setReadModel(null);
        setLoadPhase("error");
        setLoadError(describeResponseError(response.status, payload, "The project could not be loaded."));
        return;
      }
      const payload: unknown = await response.json().catch(() => undefined);
      const parsed = ProjectReadModelSchema.safeParse(payload);
      if (!parsed.success) {
        setReadModel(null);
        setLoadPhase("error");
        setLoadError("The project read model did not match the expected schema; reload to retry.");
        return;
      }
      setReadModel(parsed.data);
      setLoadPhase("ready");
      if (reason !== "after-save") setDrafts(parsed.data.audioMixRevision ? parsed.data.audioMixRevision.cues.map(seedDraftFromCue) : []);
    } catch {
      setReadModel(null);
      setLoadPhase("error");
      setLoadError("The project could not be loaded: network error — the local studio server may be offline.");
    }
  }, [projectId]);

  useEffect(() => { void load("mount"); }, [load]);
  useEffect(() => { void migrateClientVoicesOnce().then(setVoices); }, []);
  useEffect(() => {
    void fetch("/api/production/tts", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { available?: unknown } | null) => setTts((current) => ({ ...current, available: payload?.available === true })))
      .catch(() => setTts((current) => ({ ...current, available: false })));
  }, []);

  const catalog = useMemo(
    () => deriveMixCatalog(readModel, uploads.map((upload) => upload.asset)),
    [readModel, uploads],
  );
  const sessionEntries = useMemo(() => catalog.filter((entry): entry is CatalogEntry & { asset: Asset } => entry.asset !== null), [catalog]);
  const sessionFiles = useMemo(
    () => new Map(uploads.filter((upload): upload is SessionUpload & { file: File } => upload.file !== null).map((upload) => [upload.asset.id, upload.file])),
    [uploads],
  );
  const storyRevision = readModel?.storyRevision ?? null;
  const beats = storyRevision?.beats ?? [];
  const activeStoryRevisionId = readModel?.project.activeStoryRevisionId ?? null;
  const animaticTotalSamples = readModel?.animaticRevision ? readModel.animaticRevision.totalFrames * ANIMATIC_SAMPLES_PER_FRAME : null;
  const readiness = useMemo(
    () =>
      activeStoryRevisionId && storyRevision
        ? deriveCueSaveReadiness(drafts, catalog, {
            projectId, activeStoryRevisionId, audioMixVersion: readModel?.project.audioMixVersion ?? 0,
            storyRevision, animaticTotalSamples,
          })
        : ({ ok: false, issues: [] as CueIssue[] } as SaveReadiness),
    [activeStoryRevisionId, animaticTotalSamples, catalog, drafts, projectId, readModel, storyRevision],
  );
  const staleNotices = useMemo(() => (readModel ? deriveStaleNarrationNotices(readModel) : []), [readModel]);
  const speechRows = useMemo(() => {
    if (!storyRevision) return [];
    const cueProjection = drafts.map((draft) => ({
      id: draft.key, assetId: draft.assetId, sourceStartSample: draft.sourceStartSample, sourceEndSample: draft.sourceEndSample,
      timelineStartSample: draft.timelineStartSample, gainDb: draft.gainDb, role: draft.role, scriptSegmentId: draft.scriptSegmentId,
      sourceText: draft.sourceText, sourceRights: draft.sourceRights, delivery: draft.delivery, voiceId: draft.voiceId,
    }));
    return deriveSpeechPlanRows({ storyRevision, cues: cueProjection, voices });
  }, [drafts, storyRevision, voices]);
  const speechReadiness = useMemo(() => mixApprovalReadiness(speechRows), [speechRows]);

  async function generateRowSpeech(row: { rowKey: string; scriptSegmentId: string; role: "narration" | "dialogue"; text: string; delivery: DeliveryPreset; voice: VoicesStoreV1["voices"][number] | null }) {
    if (tts.busy) return;
    setTts((current) => ({ ...current, busy: true }));
    try {
      const response = await fetch("/api/production/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: row.text, delivery: row.delivery, source: row.rowKey, ...(row.voice ? { voiceId: row.voice.id } : {}) }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const asset = (payload as { asset?: Asset } | null)?.asset;
      const samples = asset?.audioSamples;
      if (response.ok && asset && typeof samples === "number" && samples > 0) {
        setDrafts((previous) => previous.concat(clampCueDraft({
          key: `tts-${row.rowKey}-${Date.now().toString(36)}`,
          fromMixId: null,
          assetId: asset.id,
          role: row.role === "dialogue" ? "dialogue" : "narration",
          timelineStartSample: 0,
          sourceStartSample: 0,
          sourceEndSample: samples,
          gainDb: 0,
          scriptSegmentId: row.scriptSegmentId,
          sourceText: row.text,
          sourceRights: "creator_attested",
          delivery: row.delivery,
          voiceId: row.voice?.id ?? null,
        }, samples)));
      }
    } catch {
      // The row stays unfilled; the inline state already reads honestly.
    } finally {
      setTts((current) => ({ ...current, busy: false }));
    }
  }

  async function setRowVoice(characterId: string, voiceId: string) {
    const binding = { voiceId, locked: true, boundAt: Date.now() };
    const next: VoicesStoreV1 = { ...voices, bindings: { ...voices.bindings, [characterId]: binding } };
    setVoices(next);
    try {
      const response = await fetch("/api/production/voices", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      if (response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const store = (payload as { store?: unknown } | null)?.store;
        if (store && typeof store === "object") setVoices(store as VoicesStoreV1);
      }
    } catch {
      // Optimistic state stands; the next page load re-syncs from the server.
    }
  }

  function setRowDelivery(rowKey: string, delivery: DeliveryPreset) {
    // Single-line re-render (spec 12 acceptance): only the draft bound to this row changes.
    updateDraft(rowKey, { delivery });
  }

  async function approveMix() {
    if (saveState.kind !== "saved" || !speechReadiness.approvable) return;
    setApproval({ phase: "recording" });
    try {
      const response = await fetch("/api/production/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          idempotencyKey: `audio-mix-${saveState.revisionId}`,
          command: {
            targetKind: "audio", targetId: saveState.revisionId, expectedHash: saveState.contentHash,
            decision: "approved",
            checklist: speechRows.map((row) => ({ id: `speech:${row.rowKey}`, passed: true, note: `Imported audio pinned for "${row.text.slice(0, 80)}"` })),
            notes: "Audio mix approved from the audio page with every speech line attributed.",
            advisoryAcknowledgements: [],
          },
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const approvalId = (payload as { approval?: { id?: unknown } } | null)?.approval?.id;
      if (response.ok && typeof approvalId === "string") {
        setApproval({ phase: "recorded", approvalId });
        return;
      }
      const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
      setApproval({ phase: "failed", message: typeof message === "string" ? message : "The audio mix approval was refused." });
    } catch {
      setApproval({ phase: "failed", message: "Recording the approval failed: network error — nothing was spent or changed; retry once the server is reachable." });
    }
  }
  const timeline = useMemo(() => deriveTimelineView(readModel?.audioMixRevision ?? null, catalog), [catalog, readModel]);
  const readyAsset = readyAssetId ? uploads.find((upload) => upload.asset.id === readyAssetId)?.asset ?? null : null;
  const spokenDraft = newRole === "narration" || newRole === "dialogue";

  async function submitUpload() {
    if (!file || !source.trim() || !rightsAttestation.trim()) {
      setUploadPhase("failed");
      setUploadMessage("Choose an audio file and fill in the source and rights attestation before importing.");
      return;
    }
    setUploadPhase("uploading");
    setUploadMessage(null);
    const body = new FormData();
    body.append("file", file);
    body.append("source", source.trim());
    body.append("rightsAttestation", rightsAttestation.trim());
    body.append("rightsStatus", rightsStatus);
    let outcome: UploadOutcome;
    try {
      const response = await fetch("/api/production/assets/import", { method: "POST", body });
      const payload: unknown = await response.json().catch(() => undefined);
      outcome = deriveUploadOutcome(response.status, payload);
    } catch {
      outcome = deriveUploadOutcome(null, undefined);
    }
    if (outcome.phase === "ready") {
      const imported = outcome.asset;
      setUploads((previous) => (previous.some((upload) => upload.asset.id === imported.id) ? previous : [...previous, { asset: imported, file }]));
      setReadyAssetId(imported.id);
      setUploadPhase("ready");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } else {
      setUploadPhase("failed");
      setUploadMessage(outcome.message);
    }
  }

  function addCue() {
    const entry = sessionEntries[0];
    if (!entry?.asset?.audioSamples) return;
    const bound = entry.asset.audioSamples;
    const spoken = newRole === "narration" || newRole === "dialogue";
    const beat = beats.find((candidate) => candidate.id === newBeatId) ?? null;
    if (spoken && !beat) return;
    const next = clampCueDraft({
      key: `draft-${drafts.length + 1}-${Date.now().toString(36)}`,
      fromMixId: null,
      assetId: entry.assetId,
      role: newRole,
      timelineStartSample: 0,
      sourceStartSample: 0,
      sourceEndSample: bound,
      gainDb: 0,
      scriptSegmentId: spoken && beat ? beat.id : null,
      sourceText: beat ? beatSourceText(beat, newRole, newDialogueIndex) : null,
      sourceRights: entry.sourceRights,
      delivery: "auto" as DeliveryPreset,
      voiceId: null,
    }, bound);
    setDrafts((previous) => [...previous, next]);
  }

  function updateDraft(key: string, patch: Partial<CueDraft>) {
    setDrafts((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function bindBeat(key: string, beat: StoryBeat, role: AudioCue["role"], dialogueIndex: number) {
    updateDraft(key, { scriptSegmentId: beat.id, sourceText: beatSourceText(beat, role, dialogueIndex) });
  }

  async function saveMix() {
    if (!readiness.ok) return;
    setSaveState({ kind: "saving" });
    try {
      const response = await fetch(`/api/production/projects/${projectId}/audio`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(readiness.command),
      });
      const payload: unknown = await response.json().catch(() => undefined);
      if (response.ok && plainObject(payload) && plainObject(payload.revision) && typeof payload.revision.id === "string") {
        setSaveState({ kind: "saved", revisionId: payload.revision.id, contentHash: typeof payload.revision.contentHash === "string" ? payload.revision.contentHash : "", created: payload.created === true });
        await load("after-save");
        return;
      }
      setSaveState({ kind: "failed", message: describeResponseError(response.status, payload, "The audio mix could not be saved.") });
    } catch {
      setSaveState({ kind: "failed", message: "Saving the audio mix failed: network error — the cue drafts are retained; retry once the local server is reachable." });
    }
  }

  const busy = loadPhase === "loading";
  const noStory = loadPhase === "ready" && readModel !== null && !activeStoryRevisionId;

  return (
    <main className="mx-auto w-full max-w-[1080px] flex-1 px-4 py-6 sm:px-6" data-testid="audio-page">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">Production / Audio</p>
          <h1 className="mt-1 text-[27px] font-medium leading-none tracking-[-0.04em] text-ink">Audio cues</h1>
          <p className="mt-1 text-[12px] text-muted">Import local audio, audition it, then place narration, music and SFX cues for the mix.</p>
        </div>
        <button type="button" className={SECONDARY_BUTTON} onClick={() => void load("manual")} disabled={busy}>
          Reload
        </button>
      </header>

      {loadPhase === "error" && (
        <section className="mt-4 border border-danger/40 bg-danger-soft p-4" role="alert">
          <p className="text-[13px] font-semibold text-danger">{loadError}</p>
          <button type="button" className={`${SECONDARY_BUTTON} mt-3`} onClick={() => void load("manual")}>Retry</button>
        </section>
      )}

      {noStory && (
        <section className="mt-4 border border-border bg-surface p-6 text-center">
          <p className="text-[14px] font-semibold text-ink">Save a script revision before placing audio cues</p>
          <p className="mt-1 text-[12px] text-muted">Audio cues bind to the active story revision, so the project needs a script first.</p>
          <Link href={`/production/${projectId}`} className="mt-3 inline-block text-[13px] font-semibold text-primary underline underline-offset-4">
            Open the project
          </Link>
        </section>
      )}

      {readModel && storyRevision && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
          {/* ---------------------------- Import + catalog ---------------------------- */}
          <div className="flex min-w-0 flex-col gap-4">
            <section className="border border-border bg-surface p-4" aria-labelledby="import-heading">
              <h2 id="import-heading" className="text-[13px] font-bold text-ink">Import audio</h2>
              <form
                className="mt-3 grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitUpload();
                }}
              >
                <div>
                  <label className={LABEL_CLASS} htmlFor="audio-file">Audio file (WAV or MP3)</label>
                  <input
                    id="audio-file"
                    ref={fileInputRef}
                    type="file"
                    accept="audio/wav,audio/x-wav,audio/mpeg,audio/aac,audio/flac"
                    className={`${INPUT_CLASS} file:mr-3 file:rounded-[5px] file:border-0 file:bg-surface-2 file:px-2 file:py-1 file:text-[12px]`}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)}
                    disabled={uploadPhase === "uploading"}
                  />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="audio-source">Source</label>
                  <input id="audio-source" className={INPUT_CLASS} value={source} maxLength={1000}
                    onChange={(event) => setSource(event.target.value)} disabled={uploadPhase === "uploading"} required />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="audio-rights-attestation">Rights attestation</label>
                  <textarea id="audio-rights-attestation" className={INPUT_CLASS} rows={2} value={rightsAttestation} maxLength={4000}
                    onChange={(event) => setRightsAttestation(event.target.value)} disabled={uploadPhase === "uploading"} required />
                </div>
                <div>
                  <label className={LABEL_CLASS} htmlFor="audio-rights-status">Rights status</label>
                  <select id="audio-rights-status" className={INPUT_CLASS} value={rightsStatus}
                    onChange={(event) => setRightsStatus(event.target.value as (typeof rightsStatusOptions)[number])}
                    disabled={uploadPhase === "uploading"}>
                    {rightsStatusOptions.map((option) => (
                      <option key={option} value={option}>{option.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </div>
                <button type="submit" className={PRIMARY_BUTTON} disabled={uploadPhase === "uploading"} aria-busy={uploadPhase === "uploading"}>
                  {uploadPhase === "uploading" ? "Importing…" : "Import audio file"}
                </button>
              </form>
              {uploadPhase === "failed" && uploadMessage && (
                <p className="mt-3 border border-danger/40 bg-danger-soft p-2.5 text-[12px] text-danger" role="alert" data-testid="upload-alert">
                  {uploadMessage}
                </p>
              )}
              {uploadPhase === "ready" && readyAsset && (
                <p className="mt-3 border border-success/40 bg-success-soft p-2.5 text-[12px] text-success" role="status" data-testid="upload-ready">
                  Imported {readyAsset.id} — it is available for cue placement below.
                </p>
              )}
            </section>

            <section className="border border-border bg-surface p-4" aria-labelledby="catalog-heading">
              <h2 id="catalog-heading" className="text-[13px] font-bold text-ink">Asset catalog</h2>
              {catalog.length === 0 ? (
                <p className="mt-2 text-[12px] text-muted">No audio yet — import a file to place your first cue.</p>
              ) : (
                <ul className="mt-2 grid gap-2">
                  {catalog.map((entry) => (
                    <li key={entry.assetId} className="border border-border bg-raised p-2.5" data-testid="asset-card" data-sha256={entry.asset?.sha256 ?? ""}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-[11px] text-ink">{entry.assetId}</span>
                        <span className={`${BADGE_CLASS} ${entry.asset ? "bg-primary-soft text-primary" : "bg-warning-soft text-warning"}`}>
                          {entry.asset ? "in session" : "recovered"}
                        </span>
                      </div>
                      {entry.asset ? (
                        <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-[11.5px] text-muted sm:grid-cols-2">
                          <div><dt className="inline font-semibold text-ink-soft">Rights: </dt><dd className="inline">{entry.asset.rightsStatus.replace(/_/g, " ")}</dd></div>
                          <div><dt className="inline font-semibold text-ink-soft">Source: </dt><dd className="inline">{entry.asset.importProvenance?.source ?? "—"}</dd></div>
                          <div className="sm:col-span-2"><dt className="inline font-semibold text-ink-soft">Attestation: </dt><dd className="inline">{entry.asset.importProvenance?.rightsAttestation ?? "—"}</dd></div>
                          <div><dt className="inline font-semibold text-ink-soft">SHA-256: </dt><dd className="inline break-all font-mono">{entry.asset.sha256}</dd></div>
                          <div>
                            <dt className="inline font-semibold text-ink-soft">Samples: </dt>
                            <dd className="inline">{entry.asset.audioSamples?.toLocaleString("en-US") ?? "—"}
                              {entry.asset.audioSamples ? ` (${samplesToDisplayTime(entry.asset.audioSamples)})` : ""}</dd>
                          </div>
                        </dl>
                      ) : (
                        <p className="mt-1.5 text-[11.5px] text-warning">
                          Provenance unavailable until re-imported — known bound {entry.maxKnownSamples?.toLocaleString("en-US")} samples
                          {entry.maxKnownSamples ? ` (${samplesToDisplayTime(entry.maxKnownSamples)})` : ""}. It cannot back new cues.
                        </p>
                      )}
                      {entry.asset && (sessionFiles.has(entry.assetId) ? (
                        <PreviewTransport asset={entry.asset} file={sessionFiles.get(entry.assetId) ?? new File([], "audio.wav")} />
                      ) : (
                        <p className="mt-1.5 text-[11.5px] text-muted">Preview unavailable — re-import the file in this session to audition it.</p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ---------------------------- Editor + timeline ---------------------------- */}
          <div className="flex min-w-0 flex-col gap-4">
            {staleNotices.length > 0 && (
              <section className="border border-warning/50 bg-warning-soft p-4" role="status" data-testid="stale-region" aria-label="Stale narration">
                <h2 className="text-[13px] font-bold text-warning">Stale narration</h2>
                <ul className="mt-2 grid gap-1.5 text-[12px] text-ink">
                  {staleNotices.map((notice, index) => (
                    <li key={`${notice.code}-${notice.cueId ?? "mix"}-${index}`}>
                      <strong className="font-bold">[{notice.code}]</strong> {notice.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="border border-border bg-surface p-4" aria-labelledby="editor-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="editor-heading" className="text-[13px] font-bold text-ink">Cue editor</h2>
                <span className="text-[11px] text-muted">{drafts.length} draft cue{drafts.length === 1 ? "" : "s"} · active script {storyRevision.id}</span>
              </div>

              <div className="mt-3 flex flex-wrap items-end gap-2 border border-border bg-raised p-2.5">
                <div>
                  <label className={LABEL_CLASS} htmlFor="new-cue-role">New cue role</label>
                  <select id="new-cue-role" className={INPUT_CLASS} value={newRole}
                    onChange={(event) => {
                      setNewRole(event.target.value as AudioCue["role"]);
                      setNewBeatId("");
                      setNewDialogueIndex(0);
                    }}>
                    <option value="music">music</option>
                    <option value="sfx">sfx</option>
                    <option value="narration">narration</option>
                    <option value="dialogue">dialogue</option>
                  </select>
                </div>
                {spokenDraft && (
                  <div>
                    <label className={LABEL_CLASS} htmlFor="new-cue-beat">Script beat</label>
                    <select id="new-cue-beat" className={INPUT_CLASS} value={newBeatId} onChange={(event) => setNewBeatId(event.target.value)}>
                      <option value="">Pick a beat…</option>
                      {beats.map((beat) => (
                        <option key={beat.id} value={beat.id}>{beat.id}</option>
                      ))}
                    </select>
                  </div>
                )}
                {newRole === "dialogue" && (
                  <div>
                    <label className={LABEL_CLASS} htmlFor="new-cue-line">Dialogue line</label>
                    <select id="new-cue-line" className={INPUT_CLASS} value={newDialogueIndex}
                      onChange={(event) => setNewDialogueIndex(Number(event.target.value) || 0)}>
                      {(beats.find((beat) => beat.id === newBeatId)?.dialogue ?? []).map((line, index) => (
                        <option key={`${line.characterId}-${index}`} value={index}>{line.text}</option>
                      ))}
                    </select>
                  </div>
                )}
                <button type="button" className={SECONDARY_BUTTON}
                  disabled={(spokenDraft && !newBeatId) || sessionEntries.length === 0 || (newRole === "dialogue" && (beats.find((beat) => beat.id === newBeatId)?.dialogue.length ?? 0) === 0)}
                  onClick={addCue}>
                  Add cue
                </button>
                {sessionEntries.length === 0 && <p className="text-[11px] text-warning">Import audio in this session to back a new cue.</p>}
              </div>

              {drafts.length === 0 ? (
                <p className="mt-3 text-[12px] text-muted">No cue drafts yet. Add a music or SFX cue freely; narration and dialogue bind to a script beat.</p>
              ) : (
                <ul className="mt-3 grid gap-3">
                  {drafts.map((row) => {
                    const bound = draftBound(row, catalog);
                    const rowBeat = beats.find((beat) => beat.id === row.scriptSegmentId) ?? null;
                    const spoken = row.role === "narration" || row.role === "dialogue";
                    return (
                      <li key={row.key} className="border border-border bg-raised p-3" data-testid="cue-row" data-cue-key={row.key} aria-label={`Cue ${row.key}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="flex items-center gap-2">
                            <span className={`${BADGE_CLASS} bg-primary-soft text-primary`}>{row.role}</span>
                            <span className="font-mono text-[11px] text-muted">{row.assetId}</span>
                            {row.fromMixId && <span className={`${BADGE_CLASS} bg-surface-2 text-ink-soft`}>saved cue</span>}
                          </span>
                          <button type="button" className={`${SECONDARY_BUTTON} !h-7 !px-2 text-[11px]`} aria-label={`Remove cue ${row.key}`}
                            onClick={() => setDrafts((previous) => previous.filter((candidate) => candidate.key !== row.key))}>
                            Remove
                          </button>
                        </div>
                        {spoken && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <div>
                              <label className={LABEL_CLASS} htmlFor={`${row.key}-beat`}>Script beat</label>
                              <select id={`${row.key}-beat`} className={INPUT_CLASS} value={row.scriptSegmentId ?? ""}
                                onChange={(event) => {
                                  const beat = beats.find((candidate) => candidate.id === event.target.value);
                                  if (beat) bindBeat(row.key, beat, row.role, 0);
                                }}>
                                <option value="">Unbound</option>
                                {beats.map((beat) => (
                                  <option key={beat.id} value={beat.id}>{beat.id}</option>
                                ))}
                              </select>
                            </div>
                            {row.role === "dialogue" && rowBeat && rowBeat.dialogue.length > 0 && (
                              <div>
                                <label className={LABEL_CLASS} htmlFor={`${row.key}-line`}>Dialogue line</label>
                                <select id={`${row.key}-line`} className={INPUT_CLASS}
                                  onChange={(event) => bindBeat(row.key, rowBeat, row.role, Number(event.target.value) || 0)}>
                                  {rowBeat.dialogue.map((line, index) => (
                                    <option key={`${line.characterId}-${index}`} value={index}>{line.text}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                          </div>
                        )}
                        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                          <div>
                            <label className={LABEL_CLASS} htmlFor={`${row.key}-timeline`}>Timeline start (samples)</label>
                            <input id={`${row.key}-timeline`} data-testid="timeline-start" type="number" className={INPUT_CLASS} min={0} step={1}
                              value={row.timelineStartSample}
                              onChange={(event) => updateDraft(row.key, { timelineStartSample: Math.max(0, Math.trunc(numberFromInput(event.target.value, row.timelineStartSample))) })} />
                          </div>
                          <div>
                            <label className={LABEL_CLASS} htmlFor={`${row.key}-source-start`}>Source start (samples)</label>
                            <input id={`${row.key}-source-start`} data-testid="source-start" type="number" className={INPUT_CLASS} min={0} step={1}
                              value={row.sourceStartSample}
                              onChange={(event) => updateDraft(row.key, { sourceStartSample: Math.max(0, Math.trunc(numberFromInput(event.target.value, row.sourceStartSample))) })} />
                          </div>
                          <div>
                            <label className={LABEL_CLASS} htmlFor={`${row.key}-source-end`}>Source end (samples{bound ? `, max ${bound.toLocaleString("en-US")}` : ""})</label>
                            <input id={`${row.key}-source-end`} data-testid="source-end" type="number" className={INPUT_CLASS} min={1} step={1}
                              value={row.sourceEndSample}
                              onChange={(event) => updateDraft(row.key, { sourceEndSample: Math.trunc(numberFromInput(event.target.value, row.sourceEndSample)) })} />
                          </div>
                          <div>
                            <label className={LABEL_CLASS} htmlFor={`${row.key}-gain`}>Gain (dB)</label>
                            <input id={`${row.key}-gain`} data-testid="gain" type="number" className={INPUT_CLASS} min={-60} max={12} step={0.5}
                              value={row.gainDb}
                              onChange={(event) => updateDraft(row.key, { gainDb: numberFromInput(event.target.value, row.gainDb) })} />
                          </div>
                        </div>
                        {spoken && (
                          <div className="mt-2">
                            <label className={LABEL_CLASS} htmlFor={`${row.key}-text`}>Source text (must match the beat exactly)</label>
                            <input id={`${row.key}-text`} data-testid="source-text" className={INPUT_CLASS} value={row.sourceText ?? ""}
                              onChange={(event) => updateDraft(row.key, { sourceText: event.target.value })} />
                          </div>
                        )}
                        {bound === null && <p className="mt-2 text-[11.5px] text-warning" role="status">This cue&apos;s asset is not in the session catalog; re-import the file before saving.</p>}
                      </li>
                    );
                  })}
                </ul>
              )}

              {!readiness.ok && readiness.issues.length > 0 && (
                <div className="mt-3 border border-danger/40 bg-danger-soft p-2.5" role="alert" data-testid="save-issues">
                  <p className="text-[12px] font-bold text-danger">Save is blocked:</p>
                  <ul className="mt-1 grid gap-1 text-[12px] text-danger">
                    {readiness.issues.map((issue, index) => (
                      <li key={`${issue.kind}-${issue.cueKey ?? "mix"}-${index}`}>
                        <strong className="font-bold">[{issue.kind}]</strong> {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button type="button" className={PRIMARY_BUTTON} disabled={!readiness.ok || drafts.length === 0 || saveState.kind === "saving"}
                  aria-busy={saveState.kind === "saving"} onClick={() => void saveMix()}>
                  {saveState.kind === "saving" ? "Saving…" : "Save audio mix"}
                </button>
                <span className="text-[11px] text-muted">
                  Saves an immutable mix revision bound to {storyRevision.id} · expected audio version {readModel.project.audioMixVersion}
                </span>
              </div>

              {storyRevision && speechRows.length > 0 && (
              <section className="border border-border bg-surface p-4" aria-labelledby="speech-plan-heading" data-testid="audio.speech-plan">
                <h2 id="speech-plan-heading" className="text-[13px] font-bold text-ink">Speech plan</h2>
                <p className="mt-1 text-[12px] text-muted">
                  One row per spoken line. Import is the only fill path today — a voice engine isn&apos;t connected yet, so there is no Generate button to fake.
                </p>
                <ul className="mt-3 flex flex-col gap-2">
                  {speechRows.map((row) => {
                    const rowDelivery = (delivery: DeliveryPreset) => setRowDelivery(row.rowKey, delivery);
                    return (
                      <li key={row.rowKey} className="border border-border bg-raised p-2.5" data-testid="audio.speech-row" data-row-key={row.rowKey} data-filled={String(row.filled)}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={`${BADGE_CLASS} ${row.role === "dialogue" ? "bg-primary-soft text-primary" : "bg-ink/5 text-ink-soft"}`}>{row.role}</span>
                          <span className={`${BADGE_CLASS} ${row.filled ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`} data-testid="audio.speech-row.status">
                            {row.filled ? "audio attached" : "missing audio"}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12.5px] leading-snug text-ink">&ldquo;{row.text}&rdquo;</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {row.characterId && (
                            <label className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
                              Voice
                              <select
                                className="rounded-[6px] border border-border bg-surface px-2 py-1 text-[12px] text-ink"
                                value={row.voice?.id ?? ""}
                                onChange={(event) => void setRowVoice(row.characterId!, event.target.value)}
                                data-testid="audio.speech-row.voice"
                              >
                                <option value="">Unbound</option>
                                {voices.voices.map((voice) => (
                                  <option key={voice.id} value={voice.id}>{voice.name}</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
                            Delivery
                            <select
                              className="rounded-[6px] border border-border bg-surface px-2 py-1 text-[12px] text-ink"
                              value={row.delivery}
                              onChange={(event) => rowDelivery(event.target.value as DeliveryPreset)}
                              data-testid="audio.speech-row.delivery"
                            >
                              {(["auto", "calm", "excited", "scared", "angry", "whisper", "shout"] as const).map((preset) => (
                                <option key={preset} value={preset}>{preset}</option>
                              ))}
                            </select>
                          </label>
                          {!row.filled && tts.available && (
                            <button
                              type="button"
                              className="rounded-[7px] bg-primary-strong px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-primary-dark disabled:opacity-50"
                              disabled={tts.busy}
                              onClick={() => void generateRowSpeech(row)}
                              data-testid="audio.speech-row.generate"
                            >
                              {tts.busy ? "Generating…" : "Generate voice"}
                            </button>
                          )}
                          {!row.filled && !tts.available && (
                            <span className="text-[11px] text-muted">Attach this line in the cue editor below (bind beat {row.scriptSegmentId}).</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {saveState.kind === "saved" && (
                <p className="mt-3 border border-success/40 bg-success-soft p-2.5 text-[12px] text-success" role="status" data-testid="save-banner" data-created={String(saveState.created)}>
                  Audio mix revision {saveState.revisionId} {saveState.created ? "created and active." : "is already current — no duplicate revision."}
                </p>
              )}
              {saveState.kind === "saved" && (
                <div className="mt-3 border border-border bg-surface p-2.5" data-testid="audio.approve">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[12px] text-muted">
                      {speechReadiness.approvable
                        ? "Every spoken line has attributed audio — the mix can be approved."
                        : `${speechReadiness.missingRowKeys.length} spoken line(s) still need audio; approval stays locked until they are filled.`}
                    </p>
                    <button
                      type="button"
                      className={PRIMARY_BUTTON}
                      disabled={!speechReadiness.approvable || saveState.kind !== "saved" || approval.phase === "recording" || saveState.contentHash === ""}
                      onClick={() => void approveMix()}
                      data-testid="audio.approve.submit"
                    >
                      {approval.phase === "recording" ? "Recording…" : "Approve Audio Mix"}
                    </button>
                  </div>
                  {approval.phase === "recorded" && (
                    <p className="mt-2 border border-success/40 bg-success-soft p-2 text-[12px] text-success" role="status" data-testid="audio.approve.status">
                      Audio mix approved — {approval.approvalId}
                    </p>
                  )}
                  {approval.phase === "failed" && (
                    <p className="mt-2 border border-danger/40 bg-danger-soft p-2 text-[12px] text-danger" role="alert" data-testid="audio.approve.error">
                      {approval.message}
                    </p>
                  )}
                </div>
              )}
              {saveState.kind === "failed" && (
                <p className="mt-3 border border-danger/40 bg-danger-soft p-2.5 text-[12px] text-danger" role="alert" data-testid="save-alert">
                  {saveState.message}
                </p>
              )}
            </section>

            <section className="border border-border bg-surface p-4" aria-labelledby="timeline-heading">
              <h2 id="timeline-heading" className="text-[13px] font-bold text-ink">Active mix timeline</h2>
              {timeline ? (
                <>
                  <p className="mt-1 text-[12px] text-muted">
                    {timeline.totalEndSample.toLocaleString("en-US")} samples ({samplesToDisplayTime(timeline.totalEndSample)}) end · {timeline.sampleRate / 1000} kHz · {timeline.channels} channels · {timeline.overlapPolicy} policy
                  </p>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[640px] border-collapse text-left text-[11.5px]">
                      <thead>
                        <tr className="border-b border-border text-muted">
                          <th scope="col" className="py-1.5 pr-3 font-bold">Cue</th>
                          <th scope="col" className="py-1.5 pr-3 font-bold">Role</th>
                          <th scope="col" className="py-1.5 pr-3 font-bold">Timeline</th>
                          <th scope="col" className="py-1.5 pr-3 font-bold">Source</th>
                          <th scope="col" className="py-1.5 pr-3 font-bold">Gain</th>
                          <th scope="col" className="py-1.5 pr-3 font-bold">Segment</th>
                          <th scope="col" className="py-1.5 font-bold">Rights</th>
                        </tr>
                      </thead>
                      <tbody>
                        {timeline.rows.map((row) => (
                          <tr key={row.id} className="border-b border-border/60" data-testid="timeline-row">
                            <td className="py-1.5 pr-3 font-mono text-ink">{row.id}</td>
                            <td className="py-1.5 pr-3">{row.role}</td>
                            <td className="py-1.5 pr-3 font-mono">{row.timelineStartSample.toLocaleString("en-US")} → {row.timelineEndSample.toLocaleString("en-US")}</td>
                            <td className="py-1.5 pr-3 font-mono">{row.sourceStartSample.toLocaleString("en-US")} → {row.sourceEndSample.toLocaleString("en-US")}</td>
                            <td className="py-1.5 pr-3 font-mono">{row.gainDb} dB</td>
                            <td className="py-1.5 pr-3 font-mono">{row.scriptSegmentId ?? "—"}</td>
                            <td className="py-1.5">
                              {row.sourceRights.replace(/_/g, " ")}
                              <span className="block text-[10.5px] text-muted">
                                {row.provenance === "session" ? "uploaded in this session" : "provenance unavailable until re-imported"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="mt-2 text-[12px] text-muted">
                  {readModel.audioMixRevision
                    ? "The saved mix violates the overlap policy, so no timeline can be rendered."
                    : "No audio mix is active yet — save cue drafts to create one."}
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </main>
  );
}

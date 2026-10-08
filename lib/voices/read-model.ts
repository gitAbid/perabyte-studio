/**
 * Voice read model (feature spec 12 — Voice & Audio Studio, Creator Alpha
 * "import-first" slice).
 *
 * THE single seam between the /voices screen and the rest of the studio.
 * Rules honored here:
 *
 * - Pure module: no React, no node APIs, no fetches, no provider calls of
 *   any kind. The server page (app/voices/page.tsx) reads characters and
 *   History records through the same services the existing APIs use
 *   (characters / records — read-only) and hands them to
 *   `buildVoiceLibraryModel`; the client overlays the browser-local store
 *   and filters nothing server-side. Alpha keeps the library client-joined
 *   by design.
 * - Import-first, no generation: this slice never generates speech. There
 *   is no TTS toggle, no fake "Generate" button, and no provider call —
 *   spec 12 §8 ("missing TTS provider shows Import, not disabled fake
 *   generation"). The Sogni audio adapter (lib/providers/production/
 *   sogni-audio.ts) remains an unwired capability seam, not a UI feature.
 * - Import path: the ONLY audio import API in the studio today is
 *   `POST /api/production/assets/import` (multipart: file, source,
 *   rightsAttestation, rightsStatus). It accepts exactly audio/wav,
 *   audio/mpeg, audio/aac and audio/flac, checksums the bytes into the
 *   media vault, and returns a production Asset whose `audioSamples` is a
 *   full 48 kHz decode count — the authoritative duration. The History
 *   asset store (POST /api/assets) does NOT accept audio rows yet: its row
 *   parser (lib/repositories/asset-row.ts) admits only
 *   image/video/story, so a voice saved there would be silently dropped —
 *   which is why /voices uses the production import route instead.
 * - localStorage seam (documented, post-Alpha moves server-side per spec):
 *   key `perabyte.voices.v1` holds `{ version, voices, bindings }`.
 *   `voices` are metadata records only — never audio bytes (a WAV would
 *   blow the storage quota). Vault-imported voices are mirrored here so the
 *   library survives a reload; the browser-local fallback (server
 *   unreachable during import) marks `origin: "browser"` honestly.
 * - Playback: vault bytes are read server-side by mix composition, but no
 *   vault media-serving HTTP route exists yet (export download is the only
 *   byte route). So in-session playback uses the importing tab's File
 *   object URL; after a reload the card says re-import to preview. This —
 *   plus reading bindings to prefill narration/dialogue cues in
 *   components/production/audio.tsx's cue drafts — is the exact
 *   integration point for the scene-audio-plan lane.
 * - Locks: binding a voice to a character locks it immediately (spec:
 *   "per-character locked binding"). Changing a locked binding requires an
 *   explicit two-step unlock in the UI; the lock lives on the binding, not
 *   the voice, so one voice can be locked to a character while others stay
 *   free.
 */

import type { Asset } from "@/lib/types";
import type { CharacterRow } from "@/lib/repositories/character-row";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Where a voice's bytes live. "vault" = media vault (server-verified);
 * "browser" = this browser only (import ran while the server was down). */
export type VoiceOrigin = "vault" | "browser";

/**
 * One imported voice's metadata (mirrored into the seam). Audio bytes are
 * deliberately excluded — see the module docblock.
 */
export type StoredVoice = {
  /** Vault asset id (server-generated UUID) or `local-…` for browser rows. */
  id: string;
  name: string;
  origin: VoiceOrigin;
  /** Exact mime the import route verified, e.g. "audio/wav". */
  mime: string;
  byteSize: number | null;
  /** Seconds. Authoritative (48 kHz decode) for vault voices; probed in the
   * importing tab for browser voices; null when never measured. */
  durationSeconds: number | null;
  /** creator_attested | licensed | public_domain | unknown */
  rightsStatus: string;
  /** Where the recording came from (import provenance `source`). */
  source: string;
  importedAt: number;
};

/** A character's locked voice binding (spec 12 §2). */
export type VoiceBinding = {
  voiceId: string;
  /** Bound => locked (spec: binding is locked by default). */
  locked: boolean;
  boundAt: number;
};

/** The whole localStorage seam (documented Alpha persistence). */
export type VoicesStoreV1 = {
  version: 1;
  voices: StoredVoice[];
  /** characterId → binding. Characters are canon rows; the map stays keyed
   * by id so renames never orphan a binding. */
  bindings: Record<string, VoiceBinding>;
};

/** localStorage key for the voice library + bindings (documented seam). */
export const VOICES_STORAGE_KEY = "perabyte.voices.v1";

export const EMPTY_VOICES_STORE: VoicesStoreV1 = { version: 1, voices: [], bindings: {} };

/** The exact audio mimes the production import route accepts today. */
export const SUPPORTED_VOICE_MIME = ["audio/wav", "audio/mpeg", "audio/aac", "audio/flac"] as const;

/** The vault's probe decodes to 48 kHz mono — samples ÷ 48_000 = seconds. */
export const VAULT_SAMPLE_RATE = 48_000;

/** A character ref the client needs (kept narrow and serializable). */
export type VoiceCharacterRef = {
  id: string;
  name: string;
  /** Display URL of the portrait, when the row has one. */
  thumbnailUrl: string | null;
};

/**
 * An audio row from the History record store (GET /api/assets), in the
 * shape /voices can use. Forward-compat seam: the store's row parser
 * accepts only image/video/story today, so `selectHistoryAudioAssets`
 * returns [] until that store grows an audio kind. When it does, those rows
 * surface here as vault voices with zero new UI.
 */
export type HistoryAudioAsset = {
  id: string;
  title: string;
  url: string;
  mime: string | null;
  createdAt: number;
};

/** One card on the /voices grid. */
export type VoiceView = {
  id: string;
  name: string;
  origin: VoiceOrigin;
  mime: string;
  byteSize: number | null;
  durationSeconds: number | null;
  rightsStatus: string;
  source: string;
  importedAt: number;
  /** The character this voice is bound to, when any (name resolved). */
  boundTo: { characterId: string; characterName: string; locked: boolean } | null;
};

/** One character row of the binding editor (inspector). */
export type CharacterBindingView = {
  character: VoiceCharacterRef;
  binding: { voiceId: string; voiceName: string; locked: boolean; boundAt: number } | null;
  /** True when the binding points at a voice that is no longer in the
   * library (removed while bound). The row shows a repair state. */
  missingVoice: boolean;
};

export type VoiceLibraryModel = {
  voices: VoiceView[];
  bindings: CharacterBindingView[];
};

/* ------------------------------------------------------------------ */
/* Store: parse / read / write (Storage | null pattern, per library)   */
/* ------------------------------------------------------------------ */

/** Shape check for one seam row — malformed rows are dropped, not fatal. */
function parseStoredVoice(raw: unknown): StoredVoice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.name !== "string" || !r.name) return null;
  if (r.origin !== "vault" && r.origin !== "browser") return null;
  if (typeof r.mime !== "string" || !SUPPORTED_VOICE_MIME.includes(r.mime as (typeof SUPPORTED_VOICE_MIME)[number])) return null;
  if (r.byteSize !== null && typeof r.byteSize !== "number") return null;
  if (r.durationSeconds !== null && typeof r.durationSeconds !== "number") return null;
  if (typeof r.rightsStatus !== "string") return null;
  if (typeof r.source !== "string") return null;
  if (typeof r.importedAt !== "number") return null;
  return {
    id: r.id,
    name: r.name,
    origin: r.origin,
    mime: r.mime,
    byteSize: typeof r.byteSize === "number" ? r.byteSize : null,
    durationSeconds: typeof r.durationSeconds === "number" ? r.durationSeconds : null,
    rightsStatus: r.rightsStatus,
    source: r.source,
    importedAt: r.importedAt,
  };
}

function parseBindings(raw: unknown): Record<string, VoiceBinding> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, VoiceBinding> = {};
  for (const [characterId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!characterId || !value || typeof value !== "object") continue;
    const b = value as Record<string, unknown>;
    if (typeof b.voiceId !== "string" || !b.voiceId) continue;
    if (typeof b.boundAt !== "number") continue;
    out[characterId] = {
      voiceId: b.voiceId,
      locked: b.locked !== false,
      boundAt: b.boundAt,
    };
  }
  return out;
}

/** Parse anything into a valid store; unknown shapes degrade to empty. */
export function parseVoicesStore(raw: unknown): VoicesStoreV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_VOICES_STORE;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return EMPTY_VOICES_STORE;
  return {
    version: 1,
    voices: Array.isArray(r.voices)
      ? r.voices.map(parseStoredVoice).filter((v): v is StoredVoice => v !== null)
      : [],
    bindings: parseBindings(r.bindings),
  };
}

/** Read the seam; malformed or blocked storage degrades to an empty store. */
export function readVoicesStore(storage: Storage | null): VoicesStoreV1 {
  if (!storage) return EMPTY_VOICES_STORE;
  try {
    const raw = storage.getItem(VOICES_STORAGE_KEY);
    if (!raw) return EMPTY_VOICES_STORE;
    return parseVoicesStore(JSON.parse(raw));
  } catch {
    return EMPTY_VOICES_STORE;
  }
}

/** Persist the seam; storage failures are silent (the session still works). */
export function writeVoicesStore(storage: Storage | null, store: VoicesStoreV1): void {
  if (!storage) return;
  try {
    storage.setItem(VOICES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage blocked — the library stays in memory for this visit */
  }
}

/* ------------------------------------------------------------------ */
/* Store transitions (pure: return the next store)                     */
/* ------------------------------------------------------------------ */

/** Upsert one voice by id (newest first on insert). */
export function withStoredVoice(store: VoicesStoreV1, voice: StoredVoice): VoicesStoreV1 {
  const rest = store.voices.filter((v) => v.id !== voice.id);
  return { ...store, voices: [voice, ...rest] };
}

/**
 * Remove voices by id. Bindings pointing at a removed voice are dropped
 * with it — a character is never left bound to a voice the library lost.
 */
export function withoutStoredVoices(store: VoicesStoreV1, ids: string[]): VoicesStoreV1 {
  const doomed = new Set(ids);
  if (doomed.size === 0) return store;
  const bindings: Record<string, VoiceBinding> = {};
  for (const [characterId, binding] of Object.entries(store.bindings)) {
    if (!doomed.has(binding.voiceId)) bindings[characterId] = binding;
  }
  return { ...store, voices: store.voices.filter((v) => !doomed.has(v.id)), bindings };
}

/** Bind a voice to a character. Binding locks immediately (spec §2). */
export function withVoiceBinding(
  store: VoicesStoreV1,
  characterId: string,
  voiceId: string,
  now: number,
): VoicesStoreV1 {
  return {
    ...store,
    bindings: { ...store.bindings, [characterId]: { voiceId, locked: true, boundAt: now } },
  };
}

/** Explicit unlock (the escape hatch before a rebinding). */
export function unlockVoiceBinding(store: VoicesStoreV1, characterId: string): VoicesStoreV1 {
  const current = store.bindings[characterId];
  if (!current) return store;
  return {
    ...store,
    bindings: { ...store.bindings, [characterId]: { ...current, locked: false } },
  };
}

/** Remove a binding entirely (character returns to "no voice"). */
export function clearVoiceBinding(store: VoicesStoreV1, characterId: string): VoicesStoreV1 {
  if (!(characterId in store.bindings)) return store;
  const bindings = { ...store.bindings };
  delete bindings[characterId];
  return { ...store, bindings };
}

/* ------------------------------------------------------------------ */
/* History audio assets (forward-compat seam — see docblock)           */
/* ------------------------------------------------------------------ */

/**
 * Pull usable audio rows out of the History record store. Today this is
 * always [] — the store's row parser (lib/repositories/asset-row.ts) admits
 * only image/video/story kinds — so the check stays structural instead of
 * narrowing the shared Asset type locally.
 */
export function selectHistoryAudioAssets(records: Asset[]): HistoryAudioAsset[] {
  const out: HistoryAudioAsset[] = [];
  for (const record of records) {
    const raw = record as unknown as Record<string, unknown>;
    if (raw.kind !== "audio" || typeof raw.url !== "string" || !raw.url) continue;
    out.push({
      id: record.id,
      title: typeof raw.title === "string" && raw.title ? raw.title : "Untitled audio",
      url: raw.url,
      mime: typeof raw.mime === "string" ? raw.mime : null,
      createdAt: record.createdAt,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */

/** Bare media-cache ref (`<64hex>.<ext>`) → our /api/media origin. */
const MEDIA_REF_PATTERN = /^[0-9a-f]{64}\.[a-z0-9]{2,5}$/i;

/** Display URL for a stored character thumbnail (mirrors /library rules). */
function displayThumbnailUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (MEDIA_REF_PATTERN.test(value)) return `/api/media?f=${encodeURIComponent(value)}`;
  return value;
}

/** Narrow a canon character row to what the binding editor renders. */
export function characterRefFrom(row: CharacterRow): VoiceCharacterRef {
  return {
    id: row.id,
    name: row.name || "Unnamed character",
    thumbnailUrl: displayThumbnailUrl(row.thumbnail ?? null),
  };
}

/* ------------------------------------------------------------------ */
/* Model assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Join the three voice sources with the seam store and the canon cast.
 * Vault voices come first (newest first), then browser voices, then any
 * History audio rows (forward-compat). One voice binds at most one way per
 * character, but several characters may share a voice.
 */
export function buildVoiceLibraryModel(input: {
  characters: VoiceCharacterRef[];
  historyAssets: HistoryAudioAsset[];
  stored: VoicesStoreV1;
}): VoiceLibraryModel {
  const characterNames = new Map(input.characters.map((c) => [c.id, c.name]));

  const storedIds = new Set(input.stored.voices.map((v) => v.id));
  const voices: VoiceView[] = [];
  for (const voice of input.stored.voices) {
    voices.push({ ...voice, boundTo: boundToFor(voice.id, input.stored, characterNames) });
  }
  for (const asset of input.historyAssets) {
    if (storedIds.has(asset.id)) continue; // the mirror's import metadata (user-named, vault-probed duration) wins
    voices.push({
      id: asset.id,
      name: asset.title,
      origin: "vault",
      mime: asset.mime ?? "",
      byteSize: null,
      durationSeconds: null,
      rightsStatus: "unknown",
      source: "History library",
      importedAt: asset.createdAt,
      boundTo: boundToFor(asset.id, input.stored, characterNames),
    });
  }

  const bindings = input.characters.map((character) => {
    const binding = input.stored.bindings[character.id] ?? null;
    const voiceName = binding ? input.stored.voices.find((v) => v.id === binding.voiceId)?.name ?? null : null;
    return {
      character,
      binding: binding && voiceName
        ? { voiceId: binding.voiceId, voiceName, locked: binding.locked, boundAt: binding.boundAt }
        : binding
          ? { voiceId: binding.voiceId, voiceName: "Missing voice", locked: binding.locked, boundAt: binding.boundAt }
          : null,
      missingVoice: binding !== null && voiceName === null,
    };
  });

  return { voices, bindings };
}

function boundToFor(
  voiceId: string,
  store: VoicesStoreV1,
  characterNames: Map<string, string>,
): VoiceView["boundTo"] {
  for (const [characterId, binding] of Object.entries(store.bindings)) {
    if (binding.voiceId !== voiceId) continue;
    return {
      characterId,
      characterName: characterNames.get(characterId) ?? "Missing character",
      locked: binding.locked,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Authoritative vault duration: 48 kHz decoded sample count → seconds. */
export function durationFromAudioSamples(samples: number): number {
  return samples / VAULT_SAMPLE_RATE;
}

/** "1:23" (or "—" when unknown); sub-second voices show "0:04". */
export function formatVoiceDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "312 KB" / "1.8 MB" (or "—" when unknown). */
export function formatVoiceByteSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`;
}

/** File-extension label for the format chip: "WAV", "MP3", "AAC", "FLAC". */
export function formatVoiceKind(mime: string): string {
  switch (mime) {
    case "audio/wav":
      return "WAV";
    case "audio/mpeg":
      return "MP3";
    case "audio/aac":
      return "AAC";
    case "audio/flac":
      return "FLAC";
    default:
      return "Audio";
  }
}

/** Plain-language rights label (mirrors the import route's three options). */
export function formatRightsStatus(status: string): string {
  switch (status) {
    case "creator_attested":
      return "You made it";
    case "licensed":
      return "Licensed";
    case "public_domain":
      return "Public domain";
    default:
      return "Rights unknown";
  }
}

/**
 * Client-side guard mirroring the import route's accepted set. Returns a
 * human reason when the file can't be imported — the server is still the
 * authority (it re-verifies the bytes), this only saves a round trip.
 */
export function describeUnsupportedVoiceFile(file: { name: string; type: string }): string | null {
  const type = (file.type || "").toLowerCase();
  if (SUPPORTED_VOICE_MIME.includes(type as (typeof SUPPORTED_VOICE_MIME)[number])) return null;
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const byExtension: Record<string, string> = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  const guessed = extension ? byExtension[extension] : undefined;
  if (guessed && SUPPORTED_VOICE_MIME.includes(guessed as (typeof SUPPORTED_VOICE_MIME)[number])) return null;
  return "That file type isn't supported yet. Import a WAV, MP3, AAC, or FLAC recording.";
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { VoicesStoreV1 } from "./read-model";

/** Strict mirror of the browser seam shape (server persistence is fail-closed). */
export const StoredVoiceSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  origin: z.enum(["vault", "browser"]),
  mime: z.string().min(1),
  byteSize: z.number().int().safe().nonnegative().nullable(),
  durationSeconds: z.number().finite().nonnegative().nullable(),
  rightsStatus: z.string().min(1),
  source: z.string(),
  importedAt: z.number().int().safe().nonnegative(),
});
export const VoiceBindingSchema = z.strictObject({
  voiceId: z.string().min(1),
  locked: z.boolean(),
  boundAt: z.number().int().safe().nonnegative(),
});
export const VoicesStoreV1Schema = z.strictObject({
  version: z.literal(1),
  voices: z.array(StoredVoiceSchema).max(10_000),
  bindings: z.record(z.string().min(1), VoiceBindingSchema),
});

/**
 * Server-side voice persistence (C16, spec 12): the voice library and character
 * bindings move off localStorage onto the studio machine so every tab and the
 * audio mix service see the same bindings. The browser seam stays as the
 * migration SOURCE only — a client PUT adopts its snapshot once; after that the
 * server file is authoritative.
 *
 * Fail-closed: a corrupt or tampered file reads back as the empty store with a
 * warn log (the UI shows no voices rather than inventing any); writes go
 * temp-then-rename so a crash never truncates the library.
 */

const VOICES_FILE = "voices.json";

export interface VoicesStoreFileOptions {
  /** Studio data dir; defaults to the production runtime resolution. */
  dataDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}

export function resolveVoicesStorePath(options: VoicesStoreFileOptions = {}): string {
  if (options.dataDir) return resolve(options.dataDir, VOICES_FILE);
  const configured = (options.env ?? process.env).PERABYTE_STUDIO_DATA_DIR?.trim();
  return resolve(options.cwd ?? process.cwd(), configured || ".studio", VOICES_FILE);
}

function warn(message: string): void {
  console.warn(JSON.stringify({ scope: "voices.server-store", level: "warn", message }));
}

export async function loadVoicesStore(options: VoicesStoreFileOptions = {}): Promise<VoicesStoreV1> {
  let raw: string;
  try {
    raw = await readFile(resolveVoicesStorePath(options), "utf8");
  } catch {
    return { version: 1, voices: [], bindings: {} };
  }
  try {
    return VoicesStoreV1Schema.parse(JSON.parse(raw));
  } catch {
    warn("voices.json failed validation; treating the voice library as empty (fail-closed)");
    return { version: 1, voices: [], bindings: {} };
  }
}

export async function saveVoicesStore(store: VoicesStoreV1, options: VoicesStoreFileOptions = {}): Promise<void> {
  const path = resolveVoicesStorePath(options);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

/**
 * Migration adopt (spec 12): merge a browser snapshot into the server store.
 * Voices merge by id (server rows win on conflict — they were verified against
 * vault bytes), bindings merge per character (latest boundAt wins). Returns the
 * merged store; persists nothing — the caller decides when to save.
 */
export function mergeVoicesStore(server: VoicesStoreV1, remote: VoicesStoreV1): VoicesStoreV1 {
  const voices = new Map(server.voices.map((voice) => [voice.id, voice]));
  for (const voice of remote.voices) {
    if (!voices.has(voice.id)) voices.set(voice.id, voice);
  }
  const bindings: Record<string, VoicesStoreV1["bindings"][string]> = { ...server.bindings };
  for (const [characterId, binding] of Object.entries(remote.bindings)) {
    const current = bindings[characterId];
    if (!current || binding.boundAt > current.boundAt) bindings[characterId] = binding;
  }
  return { version: 1, voices: [...voices.values()], bindings };
}

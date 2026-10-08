import type { DeliveryPreset } from "../../production/contracts";

/**
 * C18 (spec 12/14, M5): provider-agnostic text-to-speech seam.
 *
 * Adapters synthesize one speech line at a time; the caller owns persistence
 * (vault import + AudioCue bookkeeping) and never treats a missing adapter as
 * an error path the UI can fake — "Generate" controls render only when
 * `getTtsAdapter()` returns an available adapter, otherwise import remains the
 * only path (spec 12: "UI never claims TTS availability when no adapter is active").
 */
export interface TtsSynthesisRequest {
  readonly text: string;
  readonly voiceId: string;
  readonly delivery: DeliveryPreset;
  readonly language?: string;
  /** 0.5–2.0 speak-rate multiplier; adapters clamp to their own range. */
  readonly speed?: number;
}

export interface TtsSynthesisResult {
  /** WAV-encoded audio bytes (48 kHz stereo preferred; adapters may downmix). */
  readonly audio: Uint8Array;
  readonly sampleRate: number;
  readonly channels: number;
  readonly adapterVersion: string;
  /** Adapter-reported duration in milliseconds (fallback: decoded duration). */
  readonly durationMs: number | null;
}

export interface TextToSpeechAdapter {
  readonly id: string;
  /** False when the engine is unconfigured (missing key/dependency) — never throws. */
  available(): boolean;
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

let activeAdapter: TextToSpeechAdapter | null = null;

export function getTtsAdapter(): TextToSpeechAdapter | null {
  return activeAdapter;
}

export function setTtsAdapter(adapter: TextToSpeechAdapter | null): void {
  activeAdapter = adapter;
}

import { OUTPUT_FORMAT, MsEdgeTTS } from "msedge-tts";
import type { TtsSynthesisRequest, TtsSynthesisResult, TextToSpeechAdapter } from "./tts-adapter";
import type { DeliveryPreset } from "../../production/contracts";

/**
 * Free built-in TTS engine (C18, spec 12/14): Microsoft Edge neural voices via
 * `msedge-tts` — no API key, works out of the box, pluggable for BYOK engines
 * later (the adapter seam is the contract, not this file).
 *
 * Delivery presets map to rate/pitch prosody hints (spec 12 §4's delivery
 * list); `auto` uses the voice's neutral read. Output is MP3 24 kHz mono —
 * the mix service decodes/resamples at import time (the existing import path
 * enforces the 48 kHz studio contract), so this adapter reports its NATIVE
 * shape honestly and lets the import pipeline own conversion.
 */

export const EDGE_TTS_ADAPTER_VERSION = "edge-tts-v1";

/** Default per delivery preset; a calm neutral EN voice, swap-friendly. */
export const EDGE_TTS_DEFAULT_VOICE = "en-US-AriaNeural";

const pct = (value: number): string => `${value >= 0 ? "+" : ""}${Math.round(value)}%`;
const DELIVERY_PROSODY: Record<DeliveryPreset, { rate: number; pitch: string }> = {
  auto: { rate: 0, pitch: "+0Hz" },
  calm: { rate: -8, pitch: "-2Hz" },
  excited: { rate: 14, pitch: "+3Hz" },
  scared: { rate: 10, pitch: "+4Hz" },
  angry: { rate: 8, pitch: "-3Hz" },
  whisper: { rate: -12, pitch: "-1Hz" },
  shout: { rate: 10, pitch: "+5Hz" },
};

export interface EdgeTtsOptions {
  /** MS Edge voices require a per-request network call; unavailable offline. */
  timeoutMs?: number;
}

export function createEdgeTtsAdapter(options: EdgeTtsOptions = {}): TextToSpeechAdapter {
  return {
    id: "edge-tts",
    available() {
      // No key and no local binary: the only failure mode is a missing
      // dependency or an offline network, probed at synthesize time. Advertise
      // available when the module loaded — the route fails honestly otherwise.
      return true;
    },
    async synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> {
      const { MsEdgeTTS: Engine } = await import("msedge-tts");
      const tts = new Engine();
      const voice = request.voiceId || EDGE_TTS_DEFAULT_VOICE;
      const delivery = DELIVERY_PROSODY[request.delivery] ?? DELIVERY_PROSODY.auto;
      const speed = request.speed !== undefined ? (request.speed - 1) * 100 : 0;
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(request.text, {
        rate: pct(delivery.rate + speed), pitch: delivery.pitch, volume: 0,
      });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        audioStream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        audioStream.on("end", () => resolve());
        audioStream.on("error", (error: Error) => reject(error));
      });
      tts.close();
      const audio = new Uint8Array(Buffer.concat(chunks));
      if (audio.byteLength === 0) {
        throw new Error("The voice engine returned no audio for this line.");
      }
      return { audio, sampleRate: 24_000, channels: 1, adapterVersion: EDGE_TTS_ADAPTER_VERSION, durationMs: null };
    },
  };
}

import {
  MODERATION_SYSTEM_PROMPT,
  MODERATION_USER_INSTRUCTION,
} from "@/lib/domain/moderation";
import { sogniChat } from "@/lib/providers/sogni/sogni.chat";

/**
 * The only vision-capable model on the verified Sogni LLM surface —
 * Step-0 spike result recorded in docs/sogni-api-guide.md.
 */
export const SOGNI_VISION_MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";

export interface VisionImage {
  bytes: Buffer;
  contentType: string;
}

/**
 * One classification call: moderation rubric + the image as a base64 data
 * URI. Returns the raw model reply — parsing and policy live in
 * lib/domain/moderation.ts so this stays pure transport.
 */
export async function sogniVisionComplete(
  instruction: string,
  image: VisionImage,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const dataUri = `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
  return sogniChat(
    SOGNI_VISION_MODEL,
    [
      { type: "text", text: instruction },
      { type: "image_url", image_url: { url: dataUri } },
    ],
    {
      signal: options.signal,
      systemPrompt: MODERATION_SYSTEM_PROMPT,
      label: "Sogni vision",
    },
  );
}

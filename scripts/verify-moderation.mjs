#!/usr/bin/env node
/**
 * Live check of the smart-masking vision classifier (Sogni vision model).
 *
 *   node scripts/verify-moderation.mjs <image-path> [more paths…]
 *
 * The API key comes from SOGNI_API_KEY, then .env.local, then
 * .studio/settings.json (providers.sogni.apiKey) — the same precedence the
 * app itself uses. Prints one verdict line per image and exits non-zero if
 * any call fails to produce parseable JSON.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";

const REST_URL = process.env.SOGNI_REST_URL?.trim() || "https://api.sogni.ai";
const MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";
const MAX_SIDE = 1024; // endpoint cap: inline images ≤1024px on the longest side

const SYSTEM_PROMPT =
  'You are a content classifier for an 18+ preview gate on AI-generated media. Decide whether the image must sit behind an 18+ blur before a user chooses to view it. Sensitive (blur) when the image shows: visible nudity (exposed breasts, genitals, or buttocks presented sexually); explicit sexual activity or a close simulation; erections, genital close-ups, masturbation; fetish or sex-toy depictions; any sexualized depiction of a person who appears to be under 18 (highest priority). Safe when everyone relevant is clothed (swimwear/lingerie/suggestive posing without nudity are safe) or there are no people. Artistic nudity is still sensitive. Violence/gore are out of scope. Reply with JSON only — no prose, no code fences: {"sensitive": <boolean>, "category": "nudity" | "sexual_activity" | "suggestive" | null, "confidence": <0..1>, "reason": "<=200 chars"}';

function resolveKey() {
  if (process.env.SOGNI_API_KEY?.trim()) return process.env.SOGNI_API_KEY.trim();
  const envLocal = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envLocal)) {
    const match = fs
      .readFileSync(envLocal, "utf-8")
      .match(/^SOGNI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (match) return match[1].trim();
  }
  const settingsPath = path.join(process.cwd(), ".studio", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    return settings?.providers?.sogni?.apiKey?.trim() || null;
  }
  return null;
}

function contentTypeFor(file) {
  if (/\.jpe?g$/i.test(file)) return "image/jpeg";
  if (/\.webp$/i.test(file)) return "image/webp";
  return "image/png";
}

const key = resolveKey();
if (!key) {
  console.error("No Sogni API key found (SOGNI_API_KEY, .env.local, or .studio/settings.json).");
  process.exit(1);
}
const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node scripts/verify-moderation.mjs <image-path> [more paths…]");
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  let bytes = fs.readFileSync(file);
  let contentType = contentTypeFor(file);
  try {
    const meta = await sharp(bytes).metadata();
    if (Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_SIDE) {
      bytes = await sharp(bytes)
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      contentType = "image/png";
    }
  } catch {
    // undecodable locally — let the endpoint's own error surface
  }
  const response = await fetch(`${REST_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Classify this image for an 18+ content gate. Reply with JSON only." },
            {
              type: "image_url",
              image_url: {
                url: `data:${contentType};base64,${bytes.toString("base64")}`,
              },
            },
          ],
        },
      ],
      max_tokens: 700,
      stream: false,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    console.error(`✗ ${path.basename(file)} — HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    failures += 1;
    continue;
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content?.trim() ?? "";
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  try {
    const verdict = JSON.parse(content.slice(start, end + 1));
    console.log(
      `✓ ${path.basename(file)} — sensitive=${verdict.sensitive} category=${verdict.category} confidence=${verdict.confidence} reason=${verdict.reason}`,
    );
  } catch {
    console.error(`✗ ${path.basename(file)} — unparsable reply: ${content.slice(0, 160)}`);
    failures += 1;
  }
}
process.exit(failures ? 1 : 0);

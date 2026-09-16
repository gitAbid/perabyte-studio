# Smart Masking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `safe === false` 18+ preview gate with content-aware verdicts from Sogni's vision LLM, per `docs/superpowers/specs/2026-09-16-smart-masking-design.md`.

**Architecture:** Ref-keyed moderation service (`.studio/moderation.json`, the ref is the content sha256) + `POST /api/moderate` + a client `useSmartMask` hook that lets a confident verdict override the static generation flag both ways. Vision calls ride the existing Sogni chat-completions surface. Everything degrades to today's static-flag behavior.

**Tech Stack:** Next.js 16 route handlers, TypeScript, vitest (explicit imports, `vi.stubGlobal("fetch")`, temp-path repository overrides), Tailwind (no new UI primitives — reuse `Toggle`).

**Worktree:** do all tasks in `.worktrees/smart-masking` on branch `feat/smart-masking` (project rule: never implement in the main tree).

---

### Task 1: Domain — verdict contract, rubric, parser, policy (`lib/domain/moderation.ts`)

**Files:**
- Create: `lib/domain/moderation.ts`
- Test: `lib/domain/moderation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/domain/moderation.test.ts
import { describe, expect, it } from "vitest";
import {
  MODERATION_CONFIDENCE_THRESHOLD,
  effectiveSensitive,
  isModerationVerdict,
  mediaRefFromSrc,
  parseVerdictReply,
} from "@/lib/domain/moderation";

const MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";

describe("parseVerdictReply", () => {
  it("parses a clean verdict", () => {
    const verdict = parseVerdictReply(
      JSON.stringify({ sensitive: true, category: "nudity", confidence: 0.9, reason: "exposed breasts" }),
      MODEL,
    );
    expect(verdict).toMatchObject({ sensitive: true, category: "nudity", confidence: 0.9 });
    expect(verdict?.model).toBe(MODEL);
    expect(verdict?.uncertain).toBeUndefined();
  });

  it("parses fenced and prose-wrapped JSON", () => {
    const fenced = "```json\n{\"sensitive\":false,\"category\":null,\"confidence\":0.8,\"reason\":\"clothed\"}\n```";
    expect(parseVerdictReply(fenced, MODEL)?.sensitive).toBe(false);
    const prose = 'Sure! {"sensitive":false,"category":null,"confidence":0.8,"reason":"clothed"} hope that helps';
    expect(parseVerdictReply(prose, MODEL)?.reason).toBe("clothed");
  });

  it("returns null for junk, missing fields, or bad confidence", () => {
    expect(parseVerdictReply("not json at all", MODEL)).toBeNull();
    expect(parseVerdictReply('{"confidence":0.9,"reason":"x"}', MODEL)).toBeNull(); // no sensitive
    expect(parseVerdictReply('{"sensitive":true,"confidence":"high","reason":"x"}', MODEL)).toBeNull();
    expect(parseVerdictReply('{"sensitive":true,"reason":"x"}', MODEL)).toBeNull(); // no confidence
  });

  it("clamps confidence and trims long reasons", () => {
    const verdict = parseVerdictReply(
      JSON.stringify({ sensitive: true, category: "weird", confidence: 1.5, reason: "r".repeat(500) }),
      MODEL,
    );
    expect(verdict?.confidence).toBe(1);
    expect(verdict?.category).toBeNull(); // unknown category → null
    expect(verdict?.reason).toHaveLength(200);
  });

  it("flags the gray zone below the confidence threshold", () => {
    const verdict = parseVerdictReply(
      JSON.stringify({ sensitive: false, category: null, confidence: 0.3, reason: "unsure" }),
      MODEL,
    );
    expect(verdict?.uncertain).toBe(true);
    expect(MODERATION_CONFIDENCE_THRESHOLD).toBe(0.5);
  });
});

describe("isModerationVerdict", () => {
  it("accepts verdicts and rejects junk when loading from disk", () => {
    const good = parseVerdictReply('{"sensitive":true,"category":null,"confidence":0.9,"reason":"x"}', MODEL);
    expect(isModerationVerdict(good)).toBe(true);
    expect(isModerationVerdict({ sensitive: "yes" })).toBe(false);
    expect(isModerationVerdict(null)).toBe(false);
  });
});

describe("effectiveSensitive", () => {
  it("lets a confident verdict override the static flag both ways", () => {
    const sensitive = { sensitive: true, category: "nudity" as const, confidence: 0.9, reason: "", model: MODEL, createdAt: 1 };
    const safe = { ...sensitive, sensitive: false };
    expect(effectiveSensitive(false, sensitive)).toBe(true);
    expect(effectiveSensitive(true, safe)).toBe(false);
  });

  it("keeps the static flag when there is no verdict or it is uncertain", () => {
    expect(effectiveSensitive(true, null)).toBe(true);
    expect(effectiveSensitive(false, undefined)).toBe(false);
    const gray = { sensitive: false, category: null, confidence: 0.3, reason: "", model: MODEL, createdAt: 1, uncertain: true };
    expect(effectiveSensitive(true, gray)).toBe(true);
    expect(effectiveSensitive(false, gray)).toBe(false);
  });
});

describe("mediaRefFromSrc", () => {
  it("extracts the cache ref from served media srcs", () => {
    expect(mediaRefFromSrc("/api/media?f=abc123.png")).toBe("abc123.png");
    expect(mediaRefFromSrc("/api/media?download=1&f=abc123.jpg")).toBe("abc123.jpg");
  });

  it("returns null for provider URLs, public assets, and non-refs", () => {
    expect(mediaRefFromSrc("/api/media?u=https%3A%2F%2Fimage.pollinations.ai%2Fx")).toBeNull();
    expect(mediaRefFromSrc("/demo/hero.png")).toBeNull();
    expect(mediaRefFromSrc("/api/media?f=not-a-ref.png")).toBeNull();
    expect(mediaRefFromSrc(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/domain/moderation.test.ts`
Expected: FAIL — cannot resolve `@/lib/domain/moderation`.

- [ ] **Step 3: Implement `lib/domain/moderation.ts`**

```ts
// lib/domain/moderation.ts

/**
 * Content-aware 18+ moderation: the verdict contract, the vision-LLM
 * rubric, and the pure policy functions shared by the server service
 * (lib/services/moderation.service.ts) and the client mask hook
 * (lib/moderation-client.ts). No I/O in this module.
 */

/**
 * Gray zone: below this confidence the verdict is "uncertain" and the
 * static generation flag rules (spec §3). Persisted verdicts keep the
 * flag so the threshold can be retuned from real data later.
 */
export const MODERATION_CONFIDENCE_THRESHOLD = 0.5;

export type ModerationCategory = "nudity" | "sexual_activity" | "suggestive";

export const MODERATION_CATEGORIES: readonly ModerationCategory[] = [
  "nudity",
  "sexual_activity",
  "suggestive",
];

export interface ModerationVerdict {
  sensitive: boolean;
  category: ModerationCategory | null;
  /** The model's own certainty, clamped to 0..1. */
  confidence: number;
  /** Free text for logs only — never shown in the UI. */
  reason: string;
  /** Vision model that produced the verdict. */
  model: string;
  createdAt: number;
  /** True when confidence < MODERATION_CONFIDENCE_THRESHOLD. */
  uncertain?: boolean;
}

/** Where a mask decision came from. */
export type ModerationSource = "cache" | "ai" | "static";

/**
 * The classifier rubric. The gate is the "uncensored 18+" preview mask:
 * nudity and explicit sexual content blur; clothed (incl. swimwear /
 * lingerie / suggestive posing without nudity) stays open; violence and
 * gore are out of scope. Under-18 sexualization is the top-priority rule.
 */
export const MODERATION_SYSTEM_PROMPT = `You are a content classifier for an 18+ preview gate on AI-generated media. Decide whether the image must sit behind an 18+ blur before a user chooses to view it.

Sensitive (blur) when the image shows:
- visible nudity: exposed breasts, genitals, or buttocks presented sexually;
- explicit sexual activity, or a close simulation of it;
- erections, genital close-ups, masturbation;
- fetish or sex-toy depictions;
- any sexualized depiction of a person who appears to be under 18 — highest priority, no exceptions.

Cartoon, anime, painted and photoreal styles follow the same rules.

Safe (no blur) when: everyone relevant is clothed — including swimwear, lingerie, or suggestive posing without nudity — or there are no people at all. Artistic or non-sexual nudity is still sensitive: the gate is age-based, not taste-based.

Violence, gore and other non-sexual shock content are out of scope: never mark them sensitive.

Reply with JSON only — no prose, no code fences:
{"sensitive": <boolean>, "category": "nudity" | "sexual_activity" | "suggestive" | null, "confidence": <0..1>, "reason": "<=200 chars, for logs"}`;

export const MODERATION_USER_INSTRUCTION =
  "Classify this image for an 18+ content gate. Reply with JSON only.";

/** Pull the first JSON object out of a possibly fenced/prose-wrapped reply. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clamp01(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/** Parse + sanitize a vision reply; null = no usable verdict (static fallback). */
export function parseVerdictReply(
  raw: string,
  model: string,
): ModerationVerdict | null {
  const body = extractJsonObject(raw);
  if (!body) return null;
  if (typeof body.sensitive !== "boolean") return null;
  const confidence = clamp01(body.confidence);
  if (confidence === null) return null;
  const category =
    typeof body.category === "string" &&
    (MODERATION_CATEGORIES as readonly string[]).includes(body.category)
      ? (body.category as ModerationCategory)
      : null;
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
  const uncertain = confidence < MODERATION_CONFIDENCE_THRESHOLD;
  return {
    sensitive: body.sensitive,
    category,
    confidence,
    reason,
    model,
    createdAt: Date.now(),
    ...(uncertain ? { uncertain: true } : {}),
  };
}

/** Shape guard for verdicts read back from disk. */
export function isModerationVerdict(value: unknown): value is ModerationVerdict {
  if (!value || typeof value !== "object") return false;
  const v = value as ModerationVerdict;
  return (
    typeof v.sensitive === "boolean" &&
    typeof v.confidence === "number" &&
    Number.isFinite(v.confidence) &&
    typeof v.reason === "string" &&
    typeof v.model === "string" &&
    typeof v.createdAt === "number"
  );
}

/**
 * The mask decision for one frame: a confident verdict wins; an absent or
 * uncertain (gray-zone) verdict leaves the static generation flag in charge.
 */
export function effectiveSensitive(
  staticSensitive: boolean,
  verdict: ModerationVerdict | null | undefined,
): boolean {
  if (!verdict) return staticSensitive;
  if (verdict.uncertain || verdict.confidence < MODERATION_CONFIDENCE_THRESHOLD) {
    return staticSensitive;
  }
  return verdict.sensitive;
}

/** Cache refs look like `<64 hex chars>.<ext>` (see isValidMediaRef). */
const REF_LIKE = /^[0-9a-f]{64}\./;

/**
 * Media-cache ref from a served src (`/api/media?f=<ref>`); null when the
 * src is not one of our cache refs (provider fallbacks, /public assets).
 */
export function mediaRefFromSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  const queryStart = src.indexOf("?");
  if (queryStart < 0) return null;
  const ref = new URLSearchParams(src.slice(queryStart + 1)).get("f");
  return ref && REF_LIKE.test(ref) ? ref : null;
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run lib/domain/moderation.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/domain/moderation.ts lib/domain/moderation.test.ts
git commit -m "feat(moderation): verdict contract, vision rubric, policy + ref parsing"
```

---

### Task 2: Chat plumbing + vision client (`sogni.chat.ts`, refactor `sogni.text.ts`, `sogni.vision.ts`)

**Files:**
- Create: `lib/providers/sogni/sogni.chat.ts`
- Modify: `lib/providers/sogni/sogni.text.ts` (delegate to the shared helper; public API unchanged)
- Create: `lib/providers/sogni/sogni.vision.ts`
- Test: `lib/providers/sogni/sogni.chat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/providers/sogni/sogni.chat.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { MODERATION_SYSTEM_PROMPT } from "@/lib/domain/moderation";
import { sogniChat } from "@/lib/providers/sogni/sogni.chat";
import { sogniTextComplete, DEFAULT_SOGNI_TEXT_MODEL } from "@/lib/providers/sogni/sogni.text";
import { sogniVisionComplete, SOGNI_VISION_MODEL } from "@/lib/providers/sogni/sogni.vision";
import { ProviderError } from "@/lib/providers/types";

function okReply(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200 },
  );
}

beforeEach(() => {
  process.env.SOGNI_API_KEY = "test-key";
  resetStudioEnvForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
});

describe("sogniChat (text path via sogniTextComplete)", () => {
  it("sends the OpenAI-style body and returns the reply", async () => {
    const fetchMock = vi.fn(async () => okReply("a better prompt"));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await sogniTextComplete("make this better");
    expect(reply).toBe("a better prompt");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_SOGNI_TEXT_MODEL);
    expect(body.messages[1].content).toBe("make this better");
    expect(init.headers).toMatchObject({ authorization: "Bearer test-key" });
  });
});

describe("sogniVisionComplete", () => {
  it("sends the rubric + image as a base64 data-URI part", async () => {
    const fetchMock = vi.fn(async () =>
      okReply('{"sensitive":false,"category":null,"confidence":0.9,"reason":"clothed"}'),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reply = await sogniVisionComplete(
      "Classify this image for an 18+ content gate. Reply with JSON only.",
      { bytes: Buffer.from("fake-png"), contentType: "image/png" },
    );
    expect(reply).toContain("sensitive");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(SOGNI_VISION_MODEL);
    expect(body.messages[0].content).toBe(MODERATION_SYSTEM_PROMPT);
    const parts = body.messages[1].content;
    expect(parts[0]).toEqual({ type: "text", text: expect.any(String) });
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("maps HTTP failures to retryable ProviderErrors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(sogniVisionComplete("classify", { bytes: Buffer.from("x"), contentType: "image/png" }))
      .rejects.toMatchObject({ name: "ProviderError", retryable: true });
  });

  it("reports unconfigured Sogni as non-retryable", async () => {
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    await expect(sogniChat(SOGNI_VISION_MODEL, "hi"))
      .rejects.toBeInstanceOf(ProviderError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/providers/sogni/sogni.chat.test.ts`
Expected: FAIL — `sogni.chat` / `sogni.vision` cannot be resolved.

- [ ] **Step 3: Create `lib/providers/sogni/sogni.chat.ts`**

```ts
// lib/providers/sogni/sogni.chat.ts
import { getStudioEnv } from "@/lib/config/env";
import { ProviderError } from "@/lib/providers/types";

export const CHAT_TIMEOUT_MS = 25_000;
export const CHAT_MAX_TOKENS = 700;

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Plain string for text models; multimodal parts for vision models. */
export type ChatContent = string | ChatContentPart[];

export interface SogniChatOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Human name for error messages, e.g. "Sogni enhancer" / "Sogni vision". */
  label?: string;
}

/**
 * One OpenAI-style chat completion against the Sogni LLM surface
 * (POST /v1/chat/completions, Bearer auth, rides the subscription —
 * verified live, see docs/sogni-api-guide.md §LLM surface).
 */
export async function sogniChat(
  model: string,
  content: ChatContent,
  options: SogniChatOptions = {},
): Promise<string> {
  const env = getStudioEnv();
  if (!env.sogniApiKey) {
    throw new ProviderError("Sogni is not configured.", { retryable: false });
  }
  const label = options.label ?? "Sogni";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? CHAT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${env.sogniRestUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.sogniApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: options.systemPrompt ?? "You are a helpful assistant." },
          { role: "user", content },
        ],
        max_tokens: options.maxTokens ?? CHAT_MAX_TOKENS,
        stream: false,
      }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") {
      throw new ProviderError(`The ${label} timed out.`, { retryable: true });
    }
    if ((error as Error)?.name === "AbortError") throw error;
    throw new ProviderError(`The ${label} is unreachable.`, { retryable: true });
  }

  if (!response.ok) {
    throw new ProviderError(`The ${label} replied ${response.status}.`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  const body = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const reply = body?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!reply) {
    throw new ProviderError(`The ${label} returned an empty reply.`, {
      retryable: true,
    });
  }
  return reply;
}
```

- [ ] **Step 4: Refactor `sogni.text.ts` to delegate (public API unchanged)**

Replace the fetch body of `sogniTextComplete` — keep `DEFAULT_SOGNI_TEXT_MODEL`, `SOGNI_TEXT_MODELS`, `TextCompletionOptions` exports exactly as they are:

```ts
// lib/providers/sogni/sogni.text.ts (top + function only; model table unchanged)
import { sogniChat } from "@/lib/providers/sogni/sogni.chat";
import type { TextModelDescriptor } from "@/lib/providers/types";

export const DEFAULT_SOGNI_TEXT_MODEL = "qwen3.5-35b-a3b-abliterated-gguf-q4km";

export const SOGNI_TEXT_MODELS: TextModelDescriptor[] = [
  // … keep the existing three descriptors verbatim …
];

const TIMEOUT_MS = 25_000;

const DEFAULT_TEXT_SYSTEM =
  "You rewrite AI-generation prompts. Follow the user's rules exactly and reply with the rewritten prompt only.";

export interface TextCompletionOptions {
  signal?: AbortSignal;
  modelId?: string;
  systemPrompt?: string;
}

export async function sogniTextComplete(
  instruction: string,
  options: TextCompletionOptions = {},
): Promise<string> {
  let model = options.modelId ?? DEFAULT_SOGNI_TEXT_MODEL;
  if (model.startsWith("sogni:")) {
    model = model.slice("sogni:".length);
  }
  return sogniChat(model, instruction, {
    signal: options.signal,
    systemPrompt: options.systemPrompt ?? DEFAULT_TEXT_SYSTEM,
    timeoutMs: TIMEOUT_MS,
    label: "Sogni enhancer",
  });
}
```

- [ ] **Step 5: Create `lib/providers/sogni/sogni.vision.ts`**

```ts
// lib/providers/sogni/sogni.vision.ts
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
  instruction: string = MODERATION_USER_INSTRUCTION,
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
```

- [ ] **Step 6: Run new test + the enhancement suite (regression on the refactor)**

Run: `npx vitest run lib/providers/sogni/sogni.chat.test.ts lib/services/enhancement.service.test.ts`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/providers/sogni/sogni.chat.ts lib/providers/sogni/sogni.chat.test.ts lib/providers/sogni/sogni.text.ts lib/providers/sogni/sogni.vision.ts
git commit -m "feat(sogni): shared chat helper + vision client (image_url data-URI parts)"
```

---

### Task 3: Verdict store (`lib/repositories/moderation.repository.ts`)

**Files:**
- Create: `lib/repositories/moderation.repository.ts`
- Test: `lib/repositories/moderation.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/repositories/moderation.repository.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseVerdictReply } from "@/lib/domain/moderation";
import {
  clearModerationRepository,
  getModerationRepository,
  putModerationRepository,
  setModerationPathForTests,
} from "@/lib/repositories/moderation.repository";

const MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";
const REF = "a".repeat(64) + ".png";

let tempFile: string;

beforeEach(() => {
  tempFile = path.join(
    os.tmpdir(),
    `moderation-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  setModerationPathForTests(tempFile);
});

afterEach(() => {
  setModerationPathForTests(null);
  if (tempFile) fs.rmSync(tempFile, { force: true });
});

describe("moderation repository", () => {
  it("round-trips a verdict and persists it to disk", () => {
    const verdict = parseVerdictReply(
      '{"sensitive":true,"category":"nudity","confidence":0.9,"reason":"x"}',
      MODEL,
    )!;
    putModerationRepository(REF, verdict);
    expect(getModerationRepository(REF)?.sensitive).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(tempFile, "utf-8"));
    expect(onDisk[REF].confidence).toBe(0.9);
  });

  it("drops malformed rows when loading a corrupt/edited file", () => {
    fs.writeFileSync(
      tempFile,
      JSON.stringify({ [REF]: { sensitive: "yes" }, garbage: 1 }),
    );
    expect(getModerationRepository(REF)).toBeUndefined();
  });

  it("survives an unreadable file and clears on demand", () => {
    fs.writeFileSync(tempFile, "{not json");
    expect(getModerationRepository(REF)).toBeUndefined();
    clearModerationRepository();
    putModerationRepository(
      REF,
      parseVerdictReply('{"sensitive":false,"category":null,"confidence":0.8,"reason":"x"}', MODEL)!,
    );
    expect(getModerationRepository(REF)?.sensitive).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/repositories/moderation.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the repository (assets.repository style)**

```ts
// lib/repositories/moderation.repository.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { isModerationVerdict, type ModerationVerdict } from "@/lib/domain/moderation";

/**
 * Verdict store (`.studio/moderation.json`) — media-cache ref → vision
 * verdict. The ref is the sha256 of the media bytes, so the key is content
 * addressing: one classification per unique image, ever. assets.repository
 * style: in-memory cache, sanitize on load, sync writes, pure storage.
 */

type ModerationRows = Record<string, ModerationVerdict>;

let overridePath: string | null = null;
let cache: ModerationRows | null = null;

function resolvePath(): string {
  if (overridePath) return overridePath;
  return path.join(
    /*turbopackIgnore: true*/ process.cwd(),
    ".studio",
    "moderation.json",
  );
}

function load(): ModerationRows {
  if (cache) return cache;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ target)) {
      cache = {};
    } else {
      const raw = JSON.parse(
        fs.readFileSync(/*turbopackIgnore: true*/ target, "utf-8"),
      ) as Record<string, unknown>;
      cache = {};
      for (const [ref, value] of Object.entries(raw)) {
        if (isModerationVerdict(value)) cache[ref] = value;
      }
    }
  } catch {
    cache = {}; // unreadable/corrupt file beats a crashed server
  }
  return cache;
}

function persist(rows: ModerationRows): void {
  cache = rows;
  const target = resolvePath();
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ path.dirname(target))) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    fs.writeFileSync(
      /*turbopackIgnore: true*/ target,
      JSON.stringify(rows, null, 2),
      "utf-8",
    );
  } catch (error) {
    // A full disk must not crash the API route — memory stays authoritative
    // for this process and the next successful write re-syncs the file.
    console.error("[moderation-repository] persist failed", error);
  }
}

export function getModerationRepository(ref: string): ModerationVerdict | undefined {
  return load()[ref];
}

export function putModerationRepository(ref: string, verdict: ModerationVerdict): void {
  persist({ ...load(), [ref]: verdict });
}

export function clearModerationRepository(): void {
  persist({});
}

/** Test hook: point the store at a scratch file. */
export function setModerationPathForTests(customPath: string | null): void {
  overridePath = customPath;
  cache = null;
}
```

- [ ] **Step 4: Run tests — expect PASS; Commit**

Run: `npx vitest run lib/repositories/moderation.repository.test.ts`

```bash
git add lib/repositories/moderation.repository.ts lib/repositories/moderation.repository.test.ts
git commit -m "feat(moderation): ref-keyed verdict store (.studio/moderation.json)"
```

---

### Task 4: Moderation service (`lib/services/moderation.service.ts`)

**Files:**
- Create: `lib/services/moderation.service.ts`
- Test: `lib/services/moderation.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/moderation.service.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import type { StoredMedia } from "@/lib/repositories/media.repository";
import { setMediaRepositoryForTests, isValidMediaRef } from "@/lib/repositories/media.repository";
import {
  clearModerationRepository,
  setModerationPathForTests,
} from "@/lib/repositories/moderation.repository";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import {
  classifyMediaRef,
  resetModerationServiceForTests,
  warmModeration,
} from "@/lib/services/moderation.service";

const PNG_REF = "a".repeat(64) + ".png";
const MP4_REF = "b".repeat(64) + ".mp4";
const BAD_REF = "nope.png";
const SAFE_REPLY =
  '{"sensitive":false,"category":null,"confidence":0.9,"reason":"clothed portrait"}';
const SENSITIVE_REPLY =
  '{"sensitive":true,"category":"nudity","confidence":0.85,"reason":"explicit nudity"}';

function okReply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function fakeMediaFor(ref: string): StoredMedia {
  return { ref, contentType: "image/png", bytes: Buffer.from("fake-bytes") };
}

let tempFiles: string[] = [];

function tempPath(name: string) {
  const p = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  tempFiles.push(p);
  return p;
}

beforeEach(() => {
  process.env.SOGNI_API_KEY = "test-key";
  setProviderConfigPathForTests(tempPath("provider-config"));
  setModerationPathForTests(tempPath("moderation"));
  setMediaRepositoryForTests({
    put: async (bytes) => fakeMediaFor(isValidMediaRef(`x.png`) ? `x.png` : `x.png`),
    get: async (ref) => (isValidMediaRef(ref) && !ref.endsWith(".mp4") ? fakeMediaFor(ref) : null),
    stat: async () => null,
    list: async () => [],
    delete: async () => {},
  } as never);
  resetStudioEnvForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetModerationServiceForTests();
  setMediaRepositoryForTests(null);
  setModerationPathForTests(null);
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
  delete process.env.SOGNI_API_KEY;
  resetStudioEnvForTests();
  for (const p of tempFiles) fs.rmSync(p, { force: true });
  tempFiles = [];
  clearModerationRepository();
});

describe("classifyMediaRef", () => {
  it("classifies via the vision model and persists the verdict", async () => {
    const fetchMock = vi.fn(async () => okReply(SENSITIVE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const decision = await classifyMediaRef(PNG_REF);
    expect(decision.source).toBe("ai");
    expect(decision.verdict?.sensitive).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat classification from the cache without re-calling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply(SAFE_REPLY)));
    expect((await classifyMediaRef(PNG_REF)).source).toBe("ai");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not be called"); }));
    const again = await classifyMediaRef(PNG_REF);
    expect(again.source).toBe("cache");
    expect(again.verdict?.sensitive).toBe(false);
  });

  it("joins an in-flight classification instead of double-calling", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([classifyMediaRef(PNG_REF), classifyMediaRef(PNG_REF)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.verdict).toEqual(b.verdict);
  });

  it("falls back to static for bad refs, mp4s, and missing bytes", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    for (const ref of [BAD_REF, MP4_REF]) {
      const decision = await classifyMediaRef(ref);
      expect(decision).toEqual({ verdict: null, source: "static" });
    }
    setMediaRepositoryForTests({
      get: async () => null, stat: async () => null, list: async () => [],
      delete: async () => {}, put: async () => { throw new Error("unused"); },
    } as never);
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to static when the provider errors or the reply is junk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    vi.stubGlobal("fetch", vi.fn(async () => okReply("I cannot classify that.")));
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
  });

  it("falls back to static when Sogni is unconfigured or disabled", async () => {
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
    updateProviderConfig({ providers: { sogni: { enabled: false } } });
    resetStudioEnvForTests();
    expect(await classifyMediaRef(PNG_REF)).toEqual({ verdict: null, source: "static" });
  });

  it("keeps verdicts below the confidence threshold but flags them uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply(
      '{"sensitive":false,"category":null,"confidence":0.3,"reason":"unsure"}')));
    const decision = await classifyMediaRef(PNG_REF);
    expect(decision.verdict?.uncertain).toBe(true);
    expect(decision.source).toBe("ai"); // persisted; policy (static fallback) is the caller's job
  });
});

describe("warmModeration", () => {
  it("warms a cache-ref URL and ignores provider URLs / junk", async () => {
    const fetchMock = vi.fn(async () => okReply(SAFE_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    warmModeration(`/api/media?f=${PNG_REF}`);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    warmModeration("/api/media?u=https%3A%2F%2Fx");
    warmModeration(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/services/moderation.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// lib/services/moderation.service.ts
import {
  MODERATION_USER_INSTRUCTION,
  mediaRefFromSrc,
  parseVerdictReply,
  type ModerationSource,
  type ModerationVerdict,
} from "@/lib/domain/moderation";
import type { Logger } from "@/lib/logging/logger";
import { logger as rootLogger } from "@/lib/logging/logger";
import { getStudioEnv } from "@/lib/config/env";
import { sogniVisionComplete } from "@/lib/providers/sogni/sogni.vision";
import { getMediaRepository, isValidMediaRef } from "@/lib/repositories/media.repository";
import {
  getModerationRepository,
  putModerationRepository,
} from "@/lib/repositories/moderation.repository";
import { getProviderConfig } from "@/lib/repositories/provider-config.repository";

/**
 * Content-aware 18+ classification (spec 2026-09-16-smart-masking): one
 * vision verdict per unique media, cached by the content-addressed ref,
 * joined across concurrent callers, and never throwing — every failure
 * degrades to `source: "static"` so the UI falls back to the generation
 * flag. The shared Sogni key pool is the scarce resource, so concurrent
 * vision calls are capped.
 */

export interface ModerationDecision {
  verdict: ModerationVerdict | null;
  source: ModerationSource;
}

/** Only stills can ride the vision endpoint; mp4 scenes keep the flag. */
const CLASSIFIABLE_REFS = /\.(png|jpe?g|webp)$/;
const MAX_VISION_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENCY = 2;

const pending = new Map<string, Promise<ModerationDecision>>();

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiters.shift()?.();
}

function visionAvailable(): boolean {
  const env = getStudioEnv();
  if (!env.sogniApiKey) return false;
  return getProviderConfig().providers.sogni?.enabled !== false;
}

export async function classifyMediaRef(
  ref: string,
  options: { signal?: AbortSignal; logger?: Logger } = {},
): Promise<ModerationDecision> {
  const log = (options.logger ?? rootLogger).child({
    surface: "moderation",
    ref: ref.slice(0, 12),
  });
  const fallback: ModerationDecision = { verdict: null, source: "static" };
  if (!isValidMediaRef(ref) || !CLASSIFIABLE_REFS.test(ref)) return fallback;

  const cached = getModerationRepository(ref);
  if (cached) return { verdict: cached, source: "cache" };

  const inFlight = pending.get(ref);
  if (inFlight) return inFlight;

  const task = runClassification(ref, log, options.signal).finally(() =>
    pending.delete(ref),
  );
  pending.set(ref, task);
  return task;
}

async function runClassification(
  ref: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<ModerationDecision> {
  const fallback: ModerationDecision = { verdict: null, source: "static" };
  if (!visionAvailable()) {
    log.debug("vision unavailable — static mask policy");
    return fallback;
  }
  await acquire();
  try {
    const stored = await getMediaRepository().get(ref);
    if (!stored || stored.bytes.length === 0 || stored.bytes.length > MAX_VISION_BYTES) {
      log.warn("media bytes unavailable for classification — static mask policy", {
        size: stored?.bytes.length ?? 0,
      });
      return fallback;
    }
    const reply = await sogniVisionComplete(
      MODERATION_USER_INSTRUCTION,
      { bytes: stored.bytes, contentType: stored.contentType },
      { signal },
    );
    if (signal?.aborted) {
      log.info("classification aborted");
      return fallback;
    }
    const verdict = parseVerdictReply(reply, "deepseek-v4-flash-vision-exp-dspark-1m");
    if (!verdict) {
      log.warn("vision reply unparsable — static mask policy", { reply: reply.slice(0, 120) });
      return fallback;
    }
    putModerationRepository(ref, verdict);
    log.info("media classified", {
      sensitive: verdict.sensitive,
      category: verdict.category,
      confidence: verdict.confidence,
      uncertain: verdict.uncertain ?? false,
      reason: verdict.reason,
    });
    return { verdict, source: "ai" };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      log.info("classification aborted");
      return fallback;
    }
    log.warn("vision classification failed — static mask policy", {
      message: (error as Error)?.message,
    });
    return fallback;
  } finally {
    release();
  }
}

/**
 * Fire-and-forget server warm-up: classify ahead of the client asking.
 * Accepts a full media URL and ignores anything without a cache ref.
 */
export function warmModeration(url: string | null | undefined, logger?: Logger): void {
  const ref = mediaRefFromSrc(url);
  if (!ref) return;
  void classifyMediaRef(ref, { logger }).catch(() => undefined);
}

/** Test hook: drop in-flight tasks and reset the concurrency gate. */
export function resetModerationServiceForTests(): void {
  pending.clear();
  active = 0;
  waiters.length = 0;
}
```

Import note: use `SOGNI_VISION_MODEL` from `@/lib/providers/sogni/sogni.vision` for the model argument instead of repeating the literal:

```ts
import { sogniVisionComplete, SOGNI_VISION_MODEL } from "@/lib/providers/sogni/sogni.vision";
// …
const verdict = parseVerdictReply(reply, SOGNI_VISION_MODEL);
```

- [ ] **Step 4: Run tests — expect PASS; Commit**

Run: `npx vitest run lib/services/moderation.service.test.ts`

```bash
git add lib/services/moderation.service.ts lib/services/moderation.service.test.ts
git commit -m "feat(moderation): ref-keyed classify service — cache, dedupe, cap-2, static fallback"
```

---

### Task 5: API route (`app/api/moderate/route.ts`)

**Files:**
- Create: `app/api/moderate/route.ts`

- [ ] **Step 1: Implement the route (thin controller, enhance-route style)**

```ts
// app/api/moderate/route.ts
import { NextResponse } from "next/server";
import { logger } from "@/lib/logging/logger";
import { isValidMediaRef } from "@/lib/repositories/media.repository";
import { classifyMediaRef } from "@/lib/services/moderation.service";

export const runtime = "nodejs";

const log = logger.child({ route: "api/moderate" });

/**
 * Classify one media-cache ref for the 18+ preview gate. Never fails the
 * client: any problem degrades to source "static" (flag-driven masking).
 */
export async function POST(request: Request) {
  let body: { ref?: unknown };
  try {
    body = (await request.json()) as { ref?: unknown };
  } catch {
    return NextResponse.json(
      { error: "We could not read that request. Please try again.", retryable: false },
      { status: 400 },
    );
  }

  const ref = typeof body.ref === "string" ? body.ref : "";
  if (!isValidMediaRef(ref)) {
    return NextResponse.json(
      { error: "Unknown media reference.", retryable: false },
      { status: 400 },
    );
  }

  const decision = await classifyMediaRef(ref, { signal: request.signal, logger: log });
  return NextResponse.json(
    { ref, verdict: decision.verdict, source: decision.source },
    { headers: { "cache-control": "no-store" } },
  );
}
```

- [ ] **Step 2: Typecheck; Commit**

Run: `npm run typecheck`

```bash
git add app/api/moderate/route.ts
git commit -m "feat(moderation): POST /api/moderate — classify one media ref"
```

---

### Task 6: Client wiring — settings, `useSmartMask`, Media.tsx, SceneChainBadge

**Files:**
- Modify: `lib/repositories/settings.repository.ts` (add `smartMask`, default true, `setSmartMask`)
- Modify: `lib/repositories/settings.repository.test.ts`
- Create: `lib/moderation-client.ts`
- Modify: `components/Media.tsx` (replace `useMediaMask` with `useSmartMask`)
- Modify: `components/story/SceneChainBadge.tsx`
- Modify: `components/settings/GeneralSection.tsx`

- [ ] **Step 1: Extend the settings test first**

Add to `lib/repositories/settings.repository.test.ts` (import `setSmartMask` too):

```ts
  it("defaults smart masking on and persists the toggle", () => {
    expect(getSettings().smartMask).toBe(true);
    setSmartMask(false);
    expect(getSettings().smartMask).toBe(false);
    const raw = window.localStorage.getItem("perabyte.settings.v1");
    expect(JSON.parse(raw as string).smartMask).toBe(false);
  });
```

Run: `npx vitest run lib/repositories/settings.repository.test.ts` — expect FAIL (no `smartMask`).

- [ ] **Step 2: Add the setting**

In `lib/repositories/settings.repository.ts`: add to `UserSettings` after `maskUncensored`:

```ts
  /** Judge 18+ masking from the pixels (vision LLM) instead of the render flag. On by default. */
  smartMask: boolean;
```

to `DEFAULT_USER_SETTINGS` after `maskUncensored: true,`:

```ts
  smartMask: true,
```

and after `setMaskUncensored`:

```ts
export function setSmartMask(value: boolean) {
  update({ smartMask: value });
}
```

Run the settings test again — expect PASS. Commit:

```bash
git add lib/repositories/settings.repository.ts lib/repositories/settings.repository.test.ts
git commit -m "feat(settings): smartMask toggle (default on) in user settings"
```

- [ ] **Step 3: Create `lib/moderation-client.ts`**

```ts
// lib/moderation-client.ts
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  effectiveSensitive,
  mediaRefFromSrc,
  type ModerationVerdict,
} from "@/lib/domain/moderation";
import { useSettings } from "@/lib/repositories/settings.repository";

/**
 * Client side of smart masking: one verdict request per media ref per
 * session (module-level cache over the content-addressed ref), and the
 * `useSmartMask` hook that turns a static generation flag into a
 * content-aware mask decision. The static flag rules until a confident
 * verdict lands — no flash of unmasked explicit content, and an explicit
 * safe-mode render gains its veil a moment after display.
 */

const verdictCache = new Map<string, Promise<ModerationVerdict | null>>();

export function requestVerdict(
  ref: string,
  signal?: AbortSignal,
): Promise<ModerationVerdict | null> {
  const cached = verdictCache.get(ref);
  if (cached) return cached;
  const task = fetch("/api/moderate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref }),
    signal,
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        verdict?: ModerationVerdict | null;
      } | null;
      return body?.verdict ?? null;
    })
    .catch(() => null);
  verdictCache.set(ref, task);
  return task;
}

export interface SmartMask {
  /** Content-aware decision: confident verdict, else the static flag. */
  sensitive: boolean;
  masked: boolean;
  reveal: () => void;
}

/**
 * Content-aware replacement for the raw `sensitive && maskUncensored`
 * check. Pass the caller's static flag and the served src; when smart
 * masking (and masking itself) is on, the frame's verdict is requested
 * once and overrides the static flag in both directions.
 */
export function useSmartMask(
  staticSensitive: boolean | undefined,
  src: string | null,
): SmartMask {
  const { settings } = useSettings();
  const [verdict, setVerdict] = useState<ModerationVerdict | null>(null);
  const [revealed, setRevealed] = useState(false);

  const enabled = settings.maskUncensored && settings.smartMask;
  const ref = enabled ? mediaRefFromSrc(src) : null;

  useEffect(() => {
    if (!ref) {
      setVerdict(null);
      return;
    }
    let alive = true;
    void requestVerdict(ref).then((v) => {
      if (alive) setVerdict(v);
    });
    return () => {
      alive = false;
    };
  }, [ref]);

  const sensitive = effectiveSensitive(Boolean(staticSensitive), verdict);

  // Reveal is per frame instance and resets whenever the source or the
  // sensitivity flips — a late "this is actually explicit" verdict must
  // not be silently overridden by an earlier reveal of tame content.
  useEffect(() => setRevealed(false), [src, sensitive]);

  return {
    sensitive,
    masked: enabled && sensitive && !revealed,
    reveal: useCallback(() => setRevealed(true), []),
  };
}

/** Test hook: clear the per-session verdict cache. */
export function resetModerationClientForTests(): void {
  verdictCache.clear();
}
```

- [ ] **Step 4: Swap `Media.tsx` over**

In `components/Media.tsx`:
1. Delete the entire `useMediaMask` function (lines ~19–35) and its comment block.
2. Add `import { useSmartMask } from "@/lib/moderation-client";`
3. Remove `useSettings` from the `@/lib/repositories/settings.repository` import (it was only used by `useMediaMask`; if the import becomes empty, delete the import line).
4. Replace all three call sites — in `VideoFrame`, `ImageFrame`, and `VideoStage` — `const { masked, reveal } = useMediaMask(sensitive, …);` with `const { masked, reveal } = useSmartMask(sensitive, …);` (arguments unchanged).

Run: `npm run typecheck` — expect clean.

- [ ] **Step 5: Swap `SceneChainBadge.tsx` over**

The hook must run before the early return, so hoist the ref computation:

```tsx
// components/story/SceneChainBadge.tsx
import { useSmartMask } from "@/lib/moderation-client";
// (drop the useSettings import — no longer used)

export function SceneChainBadge({ resolution, sensitive }: { resolution: EffectiveChainRef; sensitive?: boolean }) {
  const [zoomed, setZoomed] = useState(false);
  const chainRef =
    resolution.state === "manual" || resolution.state === "chained"
      ? resolution.ref
      : undefined;
  const { masked } = useSmartMask(sensitive, chainRef ? `/api/media?f=${chainRef}` : null);

  useEffect(() => { /* keep the existing Escape handler verbatim */ }, [zoomed]);

  if (resolution.state === "none") return null;
  const ref = chainRef;
  // … the rest of the component is unchanged …
```

(Drop the old `const { settings } = useSettings();` and `const masked = Boolean(sensitive) && settings.maskUncensored;` lines.)

- [ ] **Step 6: Add the settings toggle**

In `components/settings/GeneralSection.tsx`, inside the `mt-4 border-t border-border pt-4` div that holds "Mask 18+ content", add after that `Toggle`:

```tsx
        <Toggle
          label="AI smart masking"
          description="Judge each render's actual content with a vision model instead of trusting the Uncensored Mode flag — tame uncensored renders stop being blurred and explicit safe-mode renders get masked. Falls back to the render flag when the vision model is unavailable."
          checked={settings.smartMask}
          onChange={(next) => {
            setSmartMask(next);
            toast.push(
              next
                ? "Smart masking on — previews are judged by content."
                : "Smart masking off — the render flag decides masking.",
            );
          }}
        />
```

Import `setSmartMask` alongside `setMaskUncensored`.

- [ ] **Step 7: Run the full suite; Commit**

Run: `npm run typecheck && npx vitest run`
Expected: all green.

```bash
git add lib/moderation-client.ts components/Media.tsx components/story/SceneChainBadge.tsx components/settings/GeneralSection.tsx
git commit -m "feat(ui): content-aware useSmartMask in Media + chain badge; settings toggle"
```

---

### Task 7: Server warm hooks (executor absorption)

**Files:**
- Modify: `lib/jobs/executor.ts`

- [ ] **Step 1: Warm on absorb**

In `lib/jobs/executor.ts`:

1. Add import: `import { warmModeration } from "@/lib/services/moderation.service";`
2. In `absorbStoryScene`, right after the `log.info("job absorbed into story scene", …)` line, add:

```ts
    warmModeration(primary?.url ?? null, log);
```

3. In `absorbSoloAsset`, right after the `log.info("solo job absorbed into history", …)` line, add:

```ts
    warmModeration(primary?.url ?? null, log);
```

`warmModeration` is deliberately fire-and-forget (`void` inside) so absorption latency never changes, and provider-URL fallbacks (no `?f=` ref) are ignored.

- [ ] **Step 2: Run the executor + full suites; Commit**

Run: `npx vitest run lib/jobs/executor.test.ts && npx vitest run`
Expected: all green (warm hooks are log-observable only; their behavior is covered by the service tests).

```bash
git add lib/jobs/executor.ts
git commit -m "feat(moderation): warm verdicts when the server absorbs finished renders"
```

---

### Task 8: Live verification script + provider docs

**Files:**
- Create: `scripts/verify-moderation.mjs`
- Modify: `package.json` (add `"verify:moderation"`)
- Modify: `docs/sogni-api-guide.md` (record the Step-0 spike result)

- [ ] **Step 1: Write the live script**

```js
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

const REST_URL = process.env.SOGNI_REST_URL?.trim() || "https://api.sogni.ai";
const MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";

function resolveKey() {
  if (process.env.SOGNI_API_KEY?.trim()) return process.env.SOGNI_API_KEY.trim();
  const envLocal = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envLocal)) {
    const match = fs.readFileSync(envLocal, "utf-8").match(/^SOGNI_API_KEY\s*=\s*"?([^"\n]+)"?/m);
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
  const bytes = fs.readFileSync(file);
  const response = await fetch(`${REST_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a content classifier for an 18+ preview gate on AI-generated media. Reply with JSON only — no prose, no code fences: {\"sensitive\": <boolean>, \"category\": \"nudity\" | \"sexual_activity\" | \"suggestive\" | null, \"confidence\": <0..1>, \"reason\": \"<=200 chars\"}",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Classify this image for an 18+ content gate. Reply with JSON only." },
            { type: "image_url", image_url: { url: `data:${contentTypeFor(file)};base64,${bytes.toString("base64")}` } },
          ],
        },
      ],
      max_tokens: 700,
      stream: false,
    }),
  });
  if (!response.ok) {
    console.error(`✗ ${path.basename(file)} — HTTP ${response.status}`);
    failures += 1;
    continue;
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content?.trim() ?? "";
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  try {
    const verdict = JSON.parse(content.slice(start, end + 1));
    console.log(`✓ ${path.basename(file)} — sensitive=${verdict.sensitive} category=${verdict.category} confidence=${verdict.confidence} reason=${verdict.reason}`);
  } catch {
    console.error(`✗ ${path.basename(file)} — unparsable reply: ${content.slice(0, 160)}`);
    failures += 1;
  }
}
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Wire the npm script**

In `package.json` `scripts`, after `"verify:provider"`:

```json
    "verify:moderation": "node scripts/verify-moderation.mjs"
```

- [ ] **Step 3: Run the live spike (Step 0 of the spec)**

Pick one known-safe render and one known-explicit render from the media cache (`.media-cache/*.png` — check History thumbnails to identify), then:

Run: `npm run verify:moderation .media-cache/<safe-ref>.png .media-cache/<explicit-ref>.png`
Expected: two `✓` lines with plausible verdicts (safe image → `sensitive=false`; explicit image → `sensitive=true`). If the endpoint rejects `image_url` parts (HTTP 400) or refuses explicit imagery, STOP — record the result in the guide and in the spec status; the feature stays dormant (static behavior is already the fallback everywhere).

- [ ] **Step 4: Record the spike result in `docs/sogni-api-guide.md`**

Under the existing `## LLM surface (verified live 2026-09-15)` section, append a subsection with the actual date and observed behavior, e.g.:

```markdown
### Vision input (verified live <date>)

`deepseek-v4-flash-vision-exp-dspark-1m` accepts OpenAI-style multimodal
parts: `content: [{type: "text", …}, {type: "image_url", image_url: {url:
"data:image/png;base64,…"}}]`. JSON-only instruction adherence: <observed>.
Refusal behavior on explicit imagery: <observed>. Verified with
`npm run verify:moderation` (<what was sent>, <verdicts>).
```

Only commit this after a real run — the guide carries "verified live" claims.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-moderation.mjs package.json package-lock.json docs/sogni-api-guide.md
git commit -m "feat(moderation): live verify script + vision surface documented"
```

---

### Task 9: Full verification, GUI smoke, merge

- [ ] **Step 1: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all suites green (≈400+ tests).

- [ ] **Step 2: GUI smoke (browser, dev server on port 3100)**

1. `npm run dev -- -p 3100` (never port 3000 — that runs jobradar).
2. In the studio: Settings → General shows "Mask 18+ content" and the new "AI smart masking" toggle; toggling it off restores static behavior.
3. Generate or reuse one uncensored-mode render of a tame prompt → the tile starts blurred (static flag) and the veil lifts by itself within seconds (verdict = safe), with `[moderation] media classified` in the server log and a new entry in `.studio/moderation.json`.
4. Check `.studio/moderation.json` keys are 64-hex refs and verdicts match the log lines.
5. Story page: an 18+ scene tile and its chain badge mask/unmask together with the verdict.

- [ ] **Step 3: Merge**

```bash
# from the main tree
git merge feat/smart-masking --no-ff -m "Merge branch 'feat/smart-masking' — content-aware 18+ masking via vision LLM"
git worktree remove .worktrees/smart-masking
git branch -d feat/smart-masking
```

- [ ] **Step 4: Update spec status + memory**

- Edit `docs/superpowers/specs/2026-09-16-smart-masking-design.md` status line: `Status: implemented (merged <short-sha>, <date>)` and commit.
- Update the project memory (`smart-masking-spec.md` → implemented state, gotchas learned).

---

## Self-review notes

- **Spec coverage:** rubric/result contract (Task 1), vision transport + spike (Tasks 2, 8), verdict store (Task 3), service with cache/dedupe/cap/fallback (Task 4), route (Task 5), client hook + all mask call sites + settings toggle (Task 6), warm hooks (Task 7), verification + docs (Task 8), rollout + merge (Task 9). Gray-zone rule lives in `effectiveSensitive` (Task 1) and is enforced by `useSmartMask` (Task 6).
- **Deliberate non-goals (spec §"non-goals"):** no video frame sampling (mp4 refs → static), no `tasks.moderation` model pick, no per-asset manual override UI.
- **Type consistency:** `ModerationVerdict`/`ModerationSource` defined once in the domain module and imported everywhere; `useSmartMask(sensitive, src)` returns `{sensitive, masked, reveal}` — Media's three call sites and SceneChainBadge consume `masked`/`reveal` only.

/**
 * TypeSafe AI "Jev" System One client.
 *
 * Jev does not generate text: it answers typed questions (noul / choice /
 * score) about a `state` in one parallel pass, returning probabilities.
 * Endpoint: POST https://api.typesafe.ai/v1/systemone
 *
 * The studio treats Jev as an optional accelerator: when TYPESAFE_API_KEY is
 * absent (or the call fails or times out) every triage function degrades to
 * `null` and the caller proceeds with its existing behavior. Jev can speed
 * decisions up; it can never take a generation down.
 */

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
/** Jev answers in 70–500ms; past this we'd rather generate untriaged. */
const JEV_TIMEOUT_MS = 1_200;

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export function jevApiKey(): string | null {
  return process.env.TYPESAFE_API_KEY?.trim() || null;
}

/**
 * One call, any number of questions — Jev evaluates them in parallel, so
 * extra questions cost tokens, not latency. Returns null on any failure:
 * missing key, non-200, timeout, malformed body.
 */
export async function callJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JevResponse | null> {
  const apiKey = jevApiKey();
  if (!apiKey) return null;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? JEV_TIMEOUT_MS);
  const external = options.signal;
  if (external) external.addEventListener("abort", () => timeout.abort(), { once: true });

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: timeout.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as JevResponse;
    if (!body || typeof body !== "object" || !body.answers) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

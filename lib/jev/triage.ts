import { callJev, jevApiKey, type JevResponse } from "@/lib/jev/client";

/**
 * Prompt triage for the generation pipeline.
 *
 * One Jev call answers three questions about every incoming prompt:
 *  1. safety  — does the prompt request content the sensored path must block?
 *  2. vague   — is the prompt too underspecified to render well?
 *  3. style   — which style family does the prompt actually want?
 *
 * All of it degrades to `null` when Jev is unconfigured/unreachable — the
 * generation pipeline keeps its existing behavior (Settings-side uncensored
 * gate, deterministic enhancement) as the source of truth. Jev only refines.
 */

export interface PromptTriage {
  /** >0.7 probability the prompt requests blocked content. */
  unsafeProbability: number | null;
  /** >0.7 probability the prompt is too vague for a good render. */
  vagueProbability: number | null;
  /** Jev's read of the intended style family, with confidence. */
  styleHint: { choice: string; confidence: number } | null;
}

const STYLE_CRITERIA: Record<string, string> = {
  photoreal: "Photographs, real people or places, natural lighting, documentary feel",
  anime: "Anime, manga, cel shading, illustration with anime aesthetics",
  illustration: "Painted, drawn, cartoon, storybook or concept-art styles",
  design: "Logos, icons, posters, flat graphic design, text-heavy layouts",
};

/** A triage that changes nothing — used when Jev is unavailable. */
function triageUnavailable(): PromptTriage {
  return { unsafeProbability: null, vagueProbability: null, styleHint: null };
}

export function jevConfigured(): boolean {
  return jevApiKey() !== null;
}

export async function triagePrompt(prompt: string): Promise<PromptTriage> {
  if (!jevConfigured()) return triageUnavailable();

  const response: JevResponse | null = await callJev(
    { prompt },
    {
      requests_unsafe: {
        type: "noul",
        instructions:
          "The prompt requests content that would be blocked by a general-audience image service: sexual content involving anyone, minors in any inappropriate context, graphic gore, or realistic violence. Stylized fantasy action, dark themes, and horror atmosphere do NOT count.",
      },
      is_vague: {
        type: "noul",
        instructions:
          "The prompt is too underspecified to produce a satisfying image: it names a subject but gives almost no scene, style, mood, or composition detail (e.g. 'a cat', 'cool car'). Prompts with a clear subject plus setting or action or style are NOT vague.",
      },
      style_family: {
        type: "choice",
        instructions: "Which visual style family does the prompt most want?",
        criteria: STYLE_CRITERIA,
      },
    },
  );

  if (!response?.answers) return triageUnavailable();

  const unsafe = response.answers.requests_unsafe;
  const vague = response.answers.is_vague;
  const style = response.answers.style_family;

  return {
    unsafeProbability: unsafe?.type === "noul" ? unsafe.noul : null,
    vagueProbability: vague?.type === "noul" ? vague.noul : null,
    styleHint:
      style?.type === "choice" ? { choice: style.choice, confidence: style.confidence } : null,
  };
}

/**
 * Decision helper: should the sensored path hard-block this prompt?
 * Only when Jev is *confident* — a 0.55 is not a block. Borderline results
 * keep the existing Settings-gate behavior.
 */
export function shouldBlock(triage: PromptTriage): boolean {
  return triage.unsafeProbability !== null && triage.unsafeProbability > 0.85;
}

/**
 * Decision helper: silently upgrade a vague prompt before enhancement runs.
 * Returns extra context to append; empty string when no upgrade is warranted.
 */
export function vaguenessHint(triage: PromptTriage): string {
  if (triage.vagueProbability === null || triage.vagueProbability < 0.7) return "";
  // Deterministic, generic enrichment — the AI enhancer still does the heavy
  // lifting; this just gives it something to work with.
  return " detailed scene, considered composition, atmospheric lighting";
}

import type { AutoRun } from "./contracts";

/** Coarse preflight estimate (spec 17: "Estimate can start coarse"); per-job quotes refine it later. */
export function estimateAutoRunCost(command: { durationTargetMs: number; qualityStrategy: "economy" | "balanced" | "best" }): NonNullable<AutoRun["estimatedCost"]> {
  const minutes = Math.max(0.25, command.durationTargetMs / 60_000);
  const perMinuteMicros = command.qualityStrategy === "best" ? 4_000_000 : command.qualityStrategy === "balanced" ? 2_200_000 : 1_100_000;
  const mid = Math.round(minutes * perMinuteMicros);
  return { currency: "USD", minMicros: Math.round(mid * 0.7), maxMicros: Math.round(mid * 1.5) };
}

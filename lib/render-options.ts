import {
  ASPECTS,
  DURATIONS,
  RESOLUTIONS,
  type AspectKey,
  type DurationKey,
  type ResolutionKey,
} from "@/lib/constants";
import type { ModelVideoLimits } from "@/lib/domain/models";
import type { GenerationSettings } from "@/lib/types";

/**
 * Model-aware render options: the pickers in the prompt composer show only
 * presets the selected model can actually render, and a model switch snaps
 * the stored settings to the nearest renderable preset. With no known limits
 * (image models, catalogs without metadata) every preset stays available.
 */

const ALL_ASPECTS = Object.keys(ASPECTS) as AspectKey[];
const ALL_RESOLUTIONS = Object.keys(RESOLUTIONS) as ResolutionKey[];

export interface RenderOptionFilter {
  /** Empty = the model takes no aspect input (hide the picker). */
  aspects: readonly AspectKey[];
  /** Empty = the model takes no resolution input (hide the picker). */
  resolutions: readonly ResolutionKey[];
  /** Duration presets within the model's range; never empty for a video model. */
  durations: readonly DurationKey[];
}

function durationSeconds(duration: DurationKey): number {
  return Number(duration.replace("s", ""));
}

export function allowedOptions(limits?: ModelVideoLimits): RenderOptionFilter {
  if (!limits) {
    return {
      aspects: ALL_ASPECTS,
      resolutions: ALL_RESOLUTIONS,
      durations: DURATIONS,
    };
  }
  const inRange = (d: DurationKey) => {
    const seconds = durationSeconds(d);
    return seconds >= limits.duration.min && seconds <= limits.duration.max;
  };
  return {
    aspects: limits.ratios.length
      ? ALL_ASPECTS.filter((aspect) => limits.ratios.includes(aspect))
      : [],
    resolutions: limits.resolutions.length
      ? ALL_RESOLUTIONS.filter((resolution) => limits.resolutions.includes(resolution))
      : [],
    durations: DURATIONS.filter(inRange),
  };
}

/**
 * Settings patch that keeps the stored selections renderable by `limits`:
 * clamp the duration into range, and swap an aspect/resolution the new model
 * can't honour for a default the model does accept. Returns only the fields
 * that actually change.
 */
export function snapSettingsForModel(
  limits: ModelVideoLimits | undefined,
  settings: Pick<GenerationSettings, "duration" | "aspect" | "resolution">,
): Partial<Pick<GenerationSettings, "duration" | "aspect" | "resolution">> {
  if (!limits) return {};
  const allowed = allowedOptions(limits);
  const patch: Partial<Pick<GenerationSettings, "duration" | "aspect" | "resolution">> = {};

  const seconds = durationSeconds(settings.duration);
  if (!allowed.durations.includes(settings.duration) && allowed.durations.length) {
    // Closest preset: prefer the smallest one at or above the request, else
    // fall back to whichever end of the allowed list is nearer.
    const above = allowed.durations.find((d) => durationSeconds(d) >= seconds);
    patch.duration =
      above ??
      (Math.abs(durationSeconds(allowed.durations[0]) - seconds) <=
      Math.abs(durationSeconds(allowed.durations[allowed.durations.length - 1]) - seconds)
        ? allowed.durations[0]
        : allowed.durations[allowed.durations.length - 1]);
  }
  if (!allowed.aspects.includes(settings.aspect) && allowed.aspects.length) {
    patch.aspect = allowed.aspects.includes("16:9") ? "16:9" : allowed.aspects[0];
  }
  if (!allowed.resolutions.includes(settings.resolution) && allowed.resolutions.length) {
    patch.resolution = allowed.resolutions.includes("1080p") ? "1080p" : allowed.resolutions[0];
  }
  return patch;
}

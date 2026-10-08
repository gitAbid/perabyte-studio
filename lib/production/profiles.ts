import { z } from "zod";
import { ProductionApplicationError } from "./errors";
import type { ProductionProfile } from "./contracts";

const profileSchema = z.strictObject({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
  format: z.enum(["9:16", "16:9"]),
  language: z.string().trim().min(2).max(35),
  ageIntent: z.string().trim().min(1).max(80),
  targetFrames: z.number().int().safe().positive(),
  projectCapMinor: z.number().int().safe().nonnegative().nullable(),
  dailyCapMinor: z.number().int().safe().nonnegative().nullable(),
});
profileSchema.safeParse({});
export const ProductionProfileSchema = Object.freeze(profileSchema);

const defaults: ProductionProfile[] = [
  { id: "storybook-short-v1", format: "9:16", targetFrames: 1152, language: "en", ageIntent: "5-8", projectCapMinor: null, dailyCapMinor: null },
  { id: "storybook-long-v1", format: "16:9", targetFrames: 5760, language: "en", ageIntent: "5-8", projectCapMinor: null, dailyCapMinor: null },
];
for (const profile of defaults) Object.freeze(profile);
Object.freeze(defaults);

export function resolveProductionProfile(id: string, catalog: readonly unknown[] = defaults): ProductionProfile {
  const found = catalog.find(item => item !== null && typeof item === "object" && "id" in item && item.id === id);
  if (!found) throw new ProductionApplicationError("INVALID_INPUT", `Unknown production profile: ${id}`);
  const parsed = ProductionProfileSchema.safeParse(found);
  if (!parsed.success) throw new ProductionApplicationError("INVALID_INPUT", "Invalid production profile catalog entry");
  return { ...parsed.data };
}

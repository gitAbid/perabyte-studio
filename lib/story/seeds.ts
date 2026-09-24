/**
 * Deterministic story seeds. Every scene renders from a seed derived from the
 * story's single base seed (minted once at first Generate), so re-runs and
 * restarts reproduce the same roll instead of a fresh random one — and a
 * gate retry differs from the previous attempt only because the attempt
 * number enters the derivation.
 */

export function mintSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

/** FNV-1a over the id + attempt — stable across processes and restarts. */
function hashSeed(parts: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i += 1) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deriveSceneSeed(baseSeed: number, sceneId: string, attempt = 0): number {
  return hashSeed(`${baseSeed}:${sceneId}:${attempt}`) % 1_000_000;
}

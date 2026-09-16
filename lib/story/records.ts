import type { Asset } from "@/lib/types";

/**
 * Client-side story record API (the console half of the server runner).
 * The story page restores its active story id from sessionStorage / ?id=,
 * so the record it names can outlive the server's copy — deleted in another
 * tab, or the record store reset. These helpers let the console verify and
 * (re)create the record instead of dead-ending on "That story does not
 * exist."
 */

/** Upsert one story record. Returns false when the service rejects it or is
 * unreachable — callers decide whether that aborts or recovers. */
export async function putStoryAsset(asset: Asset): Promise<boolean> {
  try {
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(asset),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether the server still has this story. Only a definitive 404 answers
 * "gone" — an outage or server error is indeterminate, so the caller keeps
 * its current state instead of destroying it on a bad connection.
 */
export async function storyExistsOnServer(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/stories/${id}`, { cache: "no-store" });
    return response.status !== 404;
  } catch {
    return true;
  }
}

"use client";

/**
 * Client-side continuity-frame plumbing: derive the final frame of a video
 * in-browser (canvas seek — our media URLs are same-origin, so the canvas
 * stays untainted), upload frames to the media cache, and parse cache refs
 * back out of media URLs.
 */

export function refFromMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, "http://perabyte.invalid").searchParams.get("f");
  } catch {
    return null;
  }
}

/** Upload an image blob to the media cache; resolves to its cache ref. */
export async function uploadFrameRef(blob: Blob): Promise<string> {
  const response = await fetch("/api/media", {
    method: "POST",
    headers: { "content-type": blob.type || "image/jpeg" },
    body: blob,
  });
  const body = (await response.json().catch(() => ({}))) as { ref?: string; error?: string };
  if (!response.ok || !body.ref) {
    throw new Error(body.error ?? "That frame could not be uploaded. Please retry.");
  }
  return body.ref;
}

/** Seek a video to (just before) its end and grab the frame as a JPEG blob. */
export async function extractLastFrame(videoUrl: string): Promise<Blob> {
  const video = document.createElement("video");
  video.muted = true;
  video.src = videoUrl;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("The video could not be read for frame extraction."));
  });
  await new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error("The video could not be read for frame extraction."));
    video.currentTime = Math.max(0, (video.duration || 0) - 0.05);
  });
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not capture the video frame.");
  context.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("Your browser could not capture the video frame.");
  return blob;
}

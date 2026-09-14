/**
 * MP4 plausibility check for downloaded video bytes.
 *
 * A completed render is always a structurally complete MP4: an `ftyp` brand
 * box up front plus an index box (`moov` for progressive files, `moof` for
 * fragmented ones) and payload (`mdat`). Relays occasionally answer "done"
 * while their object storage still serves a placeholder — a bare `ftyp` box
 * padded with zeros — which decodes to nothing. Surfacing that as a broken
 * render (instead of a silent black player) is the point of this check.
 */

const MIN_MP4_BYTES = 32;

export function isPlausibleMp4(bytes: Buffer): boolean {
  if (bytes.length < MIN_MP4_BYTES) return false;
  if (bytes.subarray(4, 8).toString("latin1") !== "ftyp") return false;

  // Byte search rather than a full box walk: tolerant of exotic box orders
  // while still rejecting placeholders (ftyp + zero padding) and non-MP4
  // payloads (error pages, images), none of which carry an index box.
  const body = bytes.toString("latin1");
  return body.includes("moov") || body.includes("moof");
}

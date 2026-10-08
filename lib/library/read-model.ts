/**
 * Library read model (feature spec 16 — Library, Canon Lineage & Retention,
 * Creator Alpha "basic discovery" slice).
 *
 * THE single seam between the /library screen and the existing per-library
 * read layers. Rules honored here:
 *
 * - Pure module: no React, no node APIs, no fetches, no provider calls of any
 *   kind. The server page (app/library/page.tsx) reads rows through the same
 *   services the existing APIs use (characters / locations / records) and
 *   hands them to `buildLibraryModel`; the client filters the loaded set with
 *   `selectLibraryItems`. Alpha-basic search is client-side by design.
 * - Shared contracts are consumed, not redefined: rows come in as the existing
 *   `CharacterRow` / `LocationRow` / `Asset` shapes; the types below are UI
 *   view models only.
 * - /library is a discovery surface OVER the standalone libraries, never a
 *   replacement: every item links out to the surface that owns it
 *   (/character/[id], /locations, /results?id=…). No detail views here.
 * - Canon lineage: characters and environments are the reused canon anchors
 *   (lib/story/canon.ts validates casts and places against exactly these
 *   rows), so creative items carry the Canon badge. An item "carries
 *   provenance" when it references the canon it came from — a character saved
 *   as a variation of another (`CharacterRow.parentId`) or media generated
 *   with an attached cast (`Asset.meta.characterIds`). Canon revision numbers
 *   are optional on the ref so the badge renders "From Milo v3" the moment
 *   revision-backed refs exist (spec 16 §11 Agent B, post-Alpha), and plain
 *   "From Milo" until then.
 * - Favorites: this surface never writes to the per-library stores. A
 *   browser-local overlay (localStorage key `perabyte.library.favorites`,
 *   shape `{ [itemId]: boolean }`) overrides the server-side favorite flag
 *   per item; server persistence is post-Alpha per the spec. Items already
 *   favorited in their home library show as favorites here.
 */

import type { MediaPreviewState } from "@/components/production/primitives/media";
import { isSensitiveAsset } from "@/lib/domain/models";
import type { Asset } from "@/lib/types";
import type { CharacterRow } from "@/lib/repositories/character-row";
import type { LocationRow } from "@/lib/repositories/location-row";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type LibrarySection = "creative" | "media";
export type LibraryItemKind = "character" | "environment" | "image" | "video";
export type LibrarySortMode = "newest" | "oldest" | "name";

/** localStorage key for the browser-side favorites overlay (documented seam). */
export const LIBRARY_FAVORITES_STORAGE_KEY = "perabyte.library.favorites";

/** localStorage override map: itemId → favorite (wins over the server flag). */
export type LibraryFavorites = Record<string, boolean>;

/** One canon provenance ref carried by an item ("From <name> v3"). */
export type LibraryLineageRef = {
  /** Canon entity display name, e.g. "Milo". */
  name: string;
  kind: "character" | "environment";
  /** Canon revision number; rendered only when the ref carries one. */
  revision?: number;
  /** Detail surface of the canon entity, when one exists. */
  href?: string;
};

/** One discoverable row on /library (creative canon or generated media). */
export type LibraryItem = {
  id: string;
  kind: LibraryItemKind;
  section: LibrarySection;
  title: string;
  /** One-line human context — the prompt, description, or cast note. */
  detail: string;
  tags: string[];
  createdAt: number;
  /** Favorite flag as stored by the home library; the localStorage overlay wins when set. */
  favorite: boolean;
  /** 18+ media — masked on the discovery grid until revealed. */
  sensitive: boolean;
  /** The surface that owns this item; /library only links out. */
  href: string;
  /** Creative canon rows (characters, environments) — the reusable anchors. */
  canon: boolean;
  /** Canon refs this item came from; empty when no provenance is known. */
  lineage: LibraryLineageRef[];
  /** CSS aspect-ratio locking the preview frame, e.g. "3 / 4". */
  ratio: string;
  /** Fully described preview state for the shared MediaPreview primitive. */
  preview: MediaPreviewState;
};

export type LibraryModel = {
  characters: LibraryItem[];
  environments: LibraryItem[];
  images: LibraryItem[];
  videos: LibraryItem[];
};

/** Client-side Alpha query over the loaded set (spec 16: basic discovery). */
export type LibraryQuery = {
  text: string;
  kind: LibraryItemKind | "all";
  favoritesOnly: boolean;
  sort: LibrarySortMode;
  favorites: LibraryFavorites;
};

/* ------------------------------------------------------------------ */
/* Media URL helpers (mirror lib/renderer + the /api/media contract)   */
/* ------------------------------------------------------------------ */

/** Bare content-addressed media-cache ref, e.g. "3f9a….jpg" (media.repository). */
const MEDIA_REF_PATTERN = /^[0-9a-f]{64}\.[a-z0-9]{2,5}$/i;
/** Only the render provider may be proxied through /api/media (lib/renderer). */
const PROVIDER_HOST = "image.pollinations.ai";

/**
 * Display URL for any stored media value: bare media-cache refs resolve to
 * our own /api/media?f= origin, provider URLs are proxied via /api/media?u=
 * (same-origin so the img never hits opaque-response blocking), and anything
 * already displayable passes through untouched.
 */
function displayMediaUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (MEDIA_REF_PATTERN.test(value)) return `/api/media?f=${encodeURIComponent(value)}`;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === PROVIDER_HOST) {
      return `/api/media?u=${encodeURIComponent(value)}`;
    }
  } catch {
    /* not an absolute URL — could be a relative path or data URL; pass through */
  }
  return value;
}

function isVideoUrl(url: string | null | undefined): boolean {
  return !!url && /\.mp4(?=$|[?#&])/i.test(url);
}

/** Generation aspect keys → CSS ratios (unknown keys fall back to a square). */
function aspectRatioFor(aspect: string | undefined): string {
  switch (aspect) {
    case "16:9":
      return "16 / 9";
    case "9:16":
      return "9 / 16";
    case "4:5":
      return "4 / 5";
    case "3:2":
      return "3 / 2";
    default:
      return "1 / 1";
  }
}

/** Excerpt for card context: first line, hard-capped so cards stay light. */
function excerpt(text: string, max = 180): string {
  const firstLine = text.trim().split("\n")[0].trim();
  return firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
}

/* ------------------------------------------------------------------ */
/* Preview builders (state for the shared MediaPreview primitive)      */
/* ------------------------------------------------------------------ */

function imagePreview(
  src: string | null,
  alt: string,
  empty: { title: string; body: string },
): MediaPreviewState {
  if (!src) return { phase: "empty", title: empty.title, body: empty.body };
  return { phase: "ready", media: { kind: "image", src, alt } };
}

/**
 * Lightweight media thumbnail (spec 16 §2 "keep thumbnails lightweight"):
 * images show their render; videos prefer a still poster frame so a grid
 * never spins up a decoder per card — only a video with no still at all
 * falls back to the shared video preview (metadata preload).
 */
function mediaPreview(asset: Asset): MediaPreviewState {
  const primary = displayMediaUrl(asset.url);
  const poster = displayMediaUrl(asset.posterUrl);
  const alt = asset.title || "Generated media";
  const empty: { title: string; body: string } = {
    title: "No preview yet",
    body: "Open this item to see it at full size.",
  };

  if (asset.kind === "video") {
    if (primary && isVideoUrl(primary)) {
      const still = poster && !isVideoUrl(poster) ? poster : null;
      return still
        ? { phase: "ready", media: { kind: "image", src: still, alt } }
        : { phase: "ready", media: { kind: "video", src: primary, alt } };
    }
    if (poster && isVideoUrl(poster)) {
      return { phase: "ready", media: { kind: "video", src: poster, alt } };
    }
    return imagePreview(poster ?? primary, alt, empty);
  }

  const still = poster ?? primary;
  if (still && isVideoUrl(still)) {
    return primary && !isVideoUrl(primary)
      ? { phase: "ready", media: { kind: "image", src: primary, alt } }
      : { phase: "empty", title: empty.title, body: empty.body };
  }
  return imagePreview(still, alt, empty);
}

/* ------------------------------------------------------------------ */
/* Item builders                                                       */
/* ------------------------------------------------------------------ */

/** Free-text tags stored in asset metadata (`meta.tags`). */
function assetTags(asset: Asset): string[] {
  const tags = asset.meta?.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Canon lineage for one media asset: the attached cast (meta.characterIds),
 * resolved to names via the loaded characters. Unknown ids are skipped —
 * a badge never guesses a name. Media never cites environments today
 * (generation records do not carry that ref yet); the ref type is ready.
 */
function lineageFromCharacterIds(
  ids: string[],
  namesById: Map<string, string>,
): LibraryLineageRef[] {
  const refs: LibraryLineageRef[] = [];
  for (const id of ids) {
    const name = namesById.get(id);
    if (!name) continue;
    refs.push({ name, kind: "character", href: `/character/${encodeURIComponent(id)}` });
  }
  return refs.slice(0, 3); // keep cards calm; the detail surface tells the rest
}

function characterItem(row: CharacterRow, namesById: Map<string, string>): LibraryItem {
  const lineage: LibraryLineageRef[] = [];
  if (row.parentId) {
    const parentName = namesById.get(row.parentId);
    if (parentName) {
      lineage.push({
        name: parentName,
        kind: "character",
        href: `/character/${encodeURIComponent(row.parentId)}`,
      });
    }
  }
  return {
    id: row.id,
    kind: "character",
    section: "creative",
    title: row.name,
    detail: excerpt(row.spec.prompt || row.name),
    tags: (row.tags ?? []).slice(0, 8),
    createdAt: row.createdAt,
    favorite: row.favorite === true,
    sensitive: false,
    href: `/character/${encodeURIComponent(row.id)}`,
    canon: true,
    lineage,
    ratio: "3 / 4",
    preview: imagePreview(displayMediaUrl(row.thumbnail ?? null), row.name, {
      title: "No portrait yet",
      body: "Open this character to render their front view.",
    }),
  };
}

function environmentItem(row: LocationRow): LibraryItem {
  return {
    id: row.id,
    kind: "environment",
    section: "creative",
    title: row.name,
    detail: excerpt(row.description || row.name),
    tags: [],
    createdAt: row.createdAt,
    favorite: row.favorite === true,
    sensitive: false,
    // /locations is the legacy route that forwards to the Environment Studio.
    href: "/locations",
    canon: true,
    lineage: [],
    ratio: "16 / 9",
    preview: imagePreview(
      displayMediaUrl(row.ref ?? null),
      row.name,
      {
        title: "No reference plate yet",
        body: "Open this environment to upload its establishing shot.",
      },
    ),
  };
}

function mediaItem(
  asset: Asset,
  namesById: Map<string, string>,
  kind: "image" | "video",
): LibraryItem {
  const castIds = asset.meta?.characterIds;
  const lineage = Array.isArray(castIds)
    ? lineageFromCharacterIds(castIds.filter((id): id is string => typeof id === "string"), namesById)
    : [];
  return {
    id: asset.id,
    kind,
    section: "media",
    title: asset.title || "Untitled",
    detail: excerpt(asset.prompt),
    tags: assetTags(asset).slice(0, 8),
    createdAt: asset.createdAt,
    favorite: asset.favorite === true,
    sensitive: isSensitiveAsset(asset),
    href: `/results?id=${encodeURIComponent(asset.id)}`,
    canon: false,
    lineage,
    ratio: aspectRatioFor(asset.settings?.aspect),
    preview: mediaPreview(asset),
  };
}

/* ------------------------------------------------------------------ */
/* Model assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Assemble the discovery model from the existing per-library rows. Newest
 * first everywhere (the selectors re-sort client-side). Stories are
 * excluded — /stories remains their home (spec 16 §2: media stays separate).
 */
export function buildLibraryModel(input: {
  characters: CharacterRow[];
  locations: LocationRow[];
  records: Asset[];
}): LibraryModel {
  const namesById = new Map(input.characters.map((row) => [row.id, row.name]));
  const byNewest = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;

  const images = input.records
    .filter((asset) => asset.kind === "image")
    .map((asset) => mediaItem(asset, namesById, "image"))
    .sort(byNewest);
  const videos = input.records
    .filter((asset) => asset.kind === "video")
    .map((asset) => mediaItem(asset, namesById, "video"))
    .sort(byNewest);

  return {
    characters: input.characters.map((row) => characterItem(row, namesById)).sort(byNewest),
    environments: input.locations.map(environmentItem).sort(byNewest),
    images,
    videos,
  };
}

/** Every item in one flat list (selectors run over this). */
export function flattenLibraryItems(model: LibraryModel): LibraryItem[] {
  return [...model.characters, ...model.environments, ...model.images, ...model.videos];
}

/* ------------------------------------------------------------------ */
/* Favorites overlay (localStorage; documented Alpha seam)             */
/* ------------------------------------------------------------------ */

/** Read the overlay; malformed or blocked storage degrades to "no overrides". */
export function readLibraryFavorites(storage: Storage | null): LibraryFavorites {
  if (!storage) return {};
  try {
    const raw = storage.getItem(LIBRARY_FAVORITES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const favorites: LibraryFavorites = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && typeof value === "boolean") favorites[id] = value;
    }
    return favorites;
  } catch {
    return {};
  }
}

/** Persist the overlay; storage failures are silent (the session still works). */
export function writeLibraryFavorites(storage: Storage | null, favorites: LibraryFavorites): void {
  if (!storage) return;
  try {
    storage.setItem(LIBRARY_FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    /* storage blocked — favorites stay in memory for this visit */
  }
}

/** The overlay wins when set; otherwise the home library's flag stands. */
export function resolveFavorite(item: LibraryItem, favorites: LibraryFavorites): boolean {
  const override = favorites[item.id];
  return typeof override === "boolean" ? override : item.favorite;
}

/* ------------------------------------------------------------------ */
/* Selection (client-side Alpha search/filter/sort)                    */
/* ------------------------------------------------------------------ */

/** "From Milo" — with the canon revision when the ref carries one. */
export function formatLineage(ref: LibraryLineageRef): string {
  return ref.revision !== undefined ? `From ${ref.name} v${ref.revision}` : `From ${ref.name}`;
}

function matchesText(item: LibraryItem, term: string): boolean {
  return (
    item.title.toLowerCase().includes(term) ||
    item.detail.toLowerCase().includes(term) ||
    item.tags.some((tag) => tag.toLowerCase().includes(term)) ||
    item.lineage.some((ref) => ref.name.toLowerCase().includes(term))
  );
}

/**
 * Filter + sort one loaded list. Pure: returns a new array. Search covers
 * title, context line, tags, and lineage names (Alpha-basic client-side
 * search per spec 16 §2; server-side library search is listed under §9
 * services and lands post-Alpha).
 */
export function selectLibraryItems(items: LibraryItem[], query: LibraryQuery): LibraryItem[] {
  const term = query.text.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (query.kind !== "all" && item.kind !== query.kind) return false;
    if (query.favoritesOnly && !resolveFavorite(item, query.favorites)) return false;
    if (term && !matchesText(item, term)) return false;
    return true;
  });

  const sorted = filtered.slice();
  if (query.sort === "name") sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (query.sort === "oldest") sorted.sort((a, b) => a.createdAt - b.createdAt);
  else sorted.sort((a, b) => b.createdAt - a.createdAt);
  return sorted;
}

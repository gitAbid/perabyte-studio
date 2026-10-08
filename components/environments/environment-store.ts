"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { EnvironmentState } from "@/lib/production/contracts";

/**
 * Environment canon store (spec 07): the client-side canon library behind
 * /environments. External-store contract in the character-store style —
 * every mutation applies optimistically to an in-memory cache and mirrors
 * to localStorage, so a refresh, a second tab, or a lost connection never
 * loses saved environments.
 *
 * Legacy "Places" migration: on first hydration the store reads the legacy
 * rows from GET /api/locations (read-only — the legacy store stays intact so
 * the scene studio keeps working) and converts each one into an environment
 * canon entry, preserving the uploaded reference plate. A one-time flag keeps
 * the import idempotent; a failed import retries on the next page load.
 *
 * Canon rules (02_SHARED_CONTRACTS §1): a content-changing save appends a new
 * immutable revision — history is never rewritten. Restoring an older version
 * appends a revision with the old snapshot. Approval is bound to one exact
 * revision; editing after approval returns the badge to draft.
 *
 * Structured state follows the frozen EnvironmentState contract (C6):
 * zone / lighting / timeOfDay / weather ≤ 200 chars, persistentProps ≤ 50 —
 * stored as structured values, never folded into prompt prose.
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Derived supporting views (spec 07 §5–§6; the four the studio renders). */
export const DERIVED_VIEWS = [
  { id: "wide", label: "Wide", direction: "wide establishing view of the whole space" },
  { id: "entrance", label: "Entrance", direction: "the entrance or threshold of the space" },
  { id: "day", label: "Day", direction: "the same space in clear daylight" },
  { id: "night", label: "Night", direction: "the same space at night, lit after dark" },
] as const;

export type EnvironmentViewId = (typeof DERIVED_VIEWS)[number]["id"];

export function isEnvironmentViewId(value: string): value is EnvironmentViewId {
  return DERIVED_VIEWS.some((view) => view.id === value);
}

/** One rendered derived-view asset pinned to the canon. One asset per view
 * slot; re-rolling a view replaces only that slot (spec 07 §10 test 2). */
export interface EnvironmentViewAsset {
  id: string;
  viewId: EnvironmentViewId;
  /** Media-cache ref of the rendered view, when it came from the cache. */
  ref: string | null;
  /** Display URL (cache ref or provider URL). */
  url: string;
  createdAt: number;
}

/** The canon content one revision pins. Views are assets, not content — they
 * live on the entry so an approved plate stays stable across edits (§10 test 1). */
export interface EnvironmentSnapshot {
  name: string;
  /** Prose establishing-shot description (canon description, not scene state). */
  description: string;
  /** Canonical plate: media-cache ref when available. */
  plate: string | null;
  plateUrl: string | null;
  /** Structured state — EnvironmentState fields (C6), minus the revision id. */
  zone: string;
  lighting: string;
  timeOfDay: string;
  weather: string;
  persistentProps: string[];
  palette: string;
  /** Render style preset name used for plates and derived views. */
  style: string;
  layoutNotes: string;
}

export interface EnvironmentRevision {
  id: string;
  revision: number;
  createdAt: number;
  /** Human note about what this revision changed. */
  note: string;
  snapshot: EnvironmentSnapshot;
}

export interface EnvironmentCanonEntry extends EnvironmentSnapshot {
  id: string;
  views: EnvironmentViewAsset[];
  revisions: EnvironmentRevision[];
  /** Exact revision the approval is bound to; null while draft. */
  approvedRevisionId: string | null;
  favorite: boolean;
  origin: "created" | "migrated";
  /** Original legacy row id when this entry was imported from Places. */
  legacyId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Structured state bounds, mirroring the frozen EnvironmentStateSchema. */
export const ENVIRONMENT_FIELD_MAX = 200;
export const PERSISTENT_PROPS_MAX = 50;

/* ------------------------------------------------------------------ */
/* External store plumbing                                             */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "perabyte.environments.v1";
const LEGACY_IMPORT_FLAG = "perabyte.environments.places-import.v1";

const EMPTY: EnvironmentCanonEntry[] = [];
let cache: EnvironmentCanonEntry[] | null = null;
let hydration: Promise<EnvironmentCanonEntry[]> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clampField(value: string | undefined): string {
  return (value ?? "").trim().slice(0, ENVIRONMENT_FIELD_MAX);
}

function clampProps(props: string[] | undefined): string[] {
  return (props ?? [])
    .map((prop) => prop.trim().slice(0, ENVIRONMENT_FIELD_MAX))
    .filter(Boolean)
    .slice(0, PERSISTENT_PROPS_MAX);
}

function clampSnapshot(snapshot: EnvironmentSnapshot): EnvironmentSnapshot {
  return {
    ...snapshot,
    name: snapshot.name.trim().slice(0, 160) || "Untitled environment",
    description: snapshot.description.trim().slice(0, 600),
    zone: clampField(snapshot.zone),
    lighting: clampField(snapshot.lighting),
    timeOfDay: clampField(snapshot.timeOfDay),
    weather: clampField(snapshot.weather),
    persistentProps: clampProps(snapshot.persistentProps),
    palette: clampField(snapshot.palette),
    style: snapshot.style,
    layoutNotes: (snapshot.layoutNotes ?? "").trim().slice(0, 2000),
  };
}

/** Shape check for a row coming off storage — required fields validated,
 * malformed rows dropped (mirrors parseLocationRow). */
function parseEntry(raw: unknown): EnvironmentCanonEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.name !== "string") return null;
  if (typeof row.createdAt !== "number" || typeof row.updatedAt !== "number") return null;
  if (!Array.isArray(row.revisions) || !Array.isArray(row.views)) return null;
  return row as unknown as EnvironmentCanonEntry;
}

function readStorage(): EnvironmentCanonEntry[] {
  if (cache) return cache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed)
      ? parsed.map(parseEntry).filter((entry): entry is EnvironmentCanonEntry => entry !== null)
      : [];
  } catch {
    cache = []; // unreadable storage beats a crashed studio
  }
  return cache;
}

function persist(rows: EnvironmentCanonEntry[]) {
  cache = rows;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* storage blocked — the session still works from memory */
  }
  emit();
}

/* ------------------------------------------------------------------ */
/* Legacy "Places" migration (read-only import)                        */
/* ------------------------------------------------------------------ */

interface LegacyPlaceRow {
  id: string;
  name: string;
  description?: string;
  ref?: string;
  lighting?: string;
  palette?: string;
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
}

function entryFromLegacyPlace(row: LegacyPlaceRow): EnvironmentCanonEntry {
  const plateUrl = row.ref ? `/api/media?f=${encodeURIComponent(row.ref)}` : null;
  const snapshot: EnvironmentSnapshot = {
    name: row.name,
    description: row.description ?? "",
    plate: row.ref ?? null,
    plateUrl,
    zone: "",
    lighting: row.lighting ?? "",
    timeOfDay: "",
    weather: "",
    persistentProps: [],
    palette: row.palette ?? "",
    style: "Cinematic",
    layoutNotes: "",
  };
  const revision: EnvironmentRevision = {
    id: newId("rev"),
    revision: 1,
    createdAt: row.createdAt,
    note: "Imported from the legacy library with its uploaded plate.",
    snapshot,
  };
  return {
    ...snapshot,
    id: newId("env"),
    views: [],
    revisions: [revision],
    approvedRevisionId: null,
    favorite: row.favorite === true,
    origin: "migrated",
    legacyId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function importLegacyPlaces(rows: EnvironmentCanonEntry[]): Promise<EnvironmentCanonEntry[]> {
  let legacy: LegacyPlaceRow[] = [];
  try {
    const response = await fetch("/api/locations", { cache: "no-store" });
    if (!response.ok) return rows;
    const body = (await response.json().catch(() => ({}))) as { locations?: LegacyPlaceRow[] };
    legacy = Array.isArray(body.locations) ? body.locations : [];
  } catch {
    return rows; // server unreachable — retry on the next page load
  }
  const knownLegacy = new Set(rows.map((row) => row.legacyId).filter(Boolean));
  const imported = legacy
    .filter((row) => !knownLegacy.has(row.id))
    .map(entryFromLegacyPlace);
  if (imported.length === 0) return rows;
  try {
    window.localStorage.setItem(LEGACY_IMPORT_FLAG, "1");
  } catch {
    /* flag blocked — the legacyId skip above still keeps a re-run a no-op */
  }
  return [...imported, ...rows];
}

/**
 * One-time boot hydration: adopt the stored list and import legacy Places
 * rows once. Idempotent per page load; a failure resolves with whatever the
 * tab already has.
 */
export function ensureEnvironmentsHydrated(): Promise<EnvironmentCanonEntry[]> {
  if (hydration) return hydration;
  hydration = (async () => {
    let rows = readStorage();
    try {
      if (!window.localStorage.getItem(LEGACY_IMPORT_FLAG)) {
        rows = await importLegacyPlaces(rows);
        persist(rows);
      }
    } catch {
      /* storage unavailable — keep the in-memory list */
    }
    return rows;
  })();
  return hydration;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): EnvironmentCanonEntry[] {
  return readStorage();
}

function getServerSnapshot(): EnvironmentCanonEntry[] {
  return EMPTY;
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

export function getEnvironments(): EnvironmentCanonEntry[] {
  return readStorage();
}

export function getEnvironment(id: string): EnvironmentCanonEntry | undefined {
  return readStorage().find((entry) => entry.id === id);
}

export interface CreateEnvironmentInput extends Partial<EnvironmentSnapshot> {
  /** Media-cache ref of the chosen plate. */
  plateRef?: string | null;
  /** Display URL of the chosen plate (cache or provider URL). */
  plateUrl?: string | null;
}

export function createEnvironment(input: CreateEnvironmentInput): EnvironmentCanonEntry {
  const now = Date.now();
  const snapshot = clampSnapshot({
    name: input.name ?? "",
    description: input.description ?? "",
    plate: input.plateRef ?? null,
    plateUrl: input.plateUrl ?? null,
    zone: input.zone ?? "",
    lighting: input.lighting ?? "",
    timeOfDay: input.timeOfDay ?? "",
    weather: input.weather ?? "",
    persistentProps: input.persistentProps ?? [],
    palette: input.palette ?? "",
    style: input.style ?? "Cinematic",
    layoutNotes: input.layoutNotes ?? "",
  });
  const revision: EnvironmentRevision = {
    id: newId("rev"),
    revision: 1,
    createdAt: now,
    note: "Created with the selected plate.",
    snapshot,
  };
  const entry: EnvironmentCanonEntry = {
    ...snapshot,
    id: newId("env"),
    views: [],
    revisions: [revision],
    approvedRevisionId: null,
    favorite: false,
    origin: "created",
    createdAt: now,
    updatedAt: now,
  };
  persist([entry, ...readStorage()]);
  return entry;
}

/** The entry's current (latest) revision. */
export function currentRevision(entry: EnvironmentCanonEntry): EnvironmentRevision {
  return entry.revisions[entry.revisions.length - 1];
}

function snapshotOf(entry: EnvironmentCanonEntry): EnvironmentSnapshot {
  return {
    name: entry.name,
    description: entry.description,
    plate: entry.plate,
    plateUrl: entry.plateUrl,
    zone: entry.zone,
    lighting: entry.lighting,
    timeOfDay: entry.timeOfDay,
    weather: entry.weather,
    persistentProps: entry.persistentProps,
    palette: entry.palette,
    style: entry.style,
    layoutNotes: entry.layoutNotes,
  };
}

/**
 * Content-aware save: identical content touches nothing but updatedAt;
 * changed content appends a new immutable revision (contract §1) — earlier
 * revisions stay put and the approval badge drops back to draft.
 * Returns whether a new revision was created.
 */
export function updateEnvironment(
  id: string,
  patch: Partial<EnvironmentSnapshot>,
  note: string,
): boolean {
  let created = false;
  persist(
    readStorage().map((entry) => {
      if (entry.id !== id) return entry;
      const next = clampSnapshot({ ...snapshotOf(entry), ...patch });
      const current = currentRevision(entry);
      if (JSON.stringify(next) === JSON.stringify(current.snapshot)) {
        return { ...entry, ...next, updatedAt: Date.now() };
      }
      created = true;
      const revision: EnvironmentRevision = {
        id: newId("rev"),
        revision: current.revision + 1,
        createdAt: Date.now(),
        note,
        snapshot: next,
      };
      return { ...entry, ...next, revisions: [...entry.revisions, revision], updatedAt: Date.now() };
    }),
  );
  return created;
}

/** Pin a rendered derived view into its slot (re-roll replaces that slot only). */
export function setEnvironmentView(
  id: string,
  viewId: EnvironmentViewId,
  media: { ref: string | null; url: string },
): void {
  persist(
    readStorage().map((entry) => {
      if (entry.id !== id) return entry;
      const views = entry.views.filter((view) => view.viewId !== viewId);
      views.push({ id: newId("view"), viewId, ref: media.ref, url: media.url, createdAt: Date.now() });
      return { ...entry, views, updatedAt: Date.now() };
    }),
  );
}

export function removeEnvironmentView(id: string, viewId: EnvironmentViewId): void {
  persist(
    readStorage().map((entry) =>
      entry.id === id
        ? { ...entry, views: entry.views.filter((view) => view.viewId !== viewId), updatedAt: Date.now() }
        : entry,
    ),
  );
}

/** Approve the entry's current revision (only you approve — spec 03 §7). */
export function approveEnvironment(id: string): void {
  persist(
    readStorage().map((entry) => {
      if (entry.id !== id) return entry;
      return { ...entry, approvedRevisionId: currentRevision(entry).id, updatedAt: Date.now() };
    }),
  );
}

export function toggleEnvironmentFavorite(id: string): void {
  persist(
    readStorage().map((entry) =>
      entry.id === id ? { ...entry, favorite: !entry.favorite, updatedAt: Date.now() } : entry,
    ),
  );
}

export function removeEnvironments(ids: string[]): void {
  const doomed = new Set(ids);
  persist(readStorage().filter((entry) => !doomed.has(entry.id)));
}

/* ------------------------------------------------------------------ */
/* Derived views for the UI                                            */
/* ------------------------------------------------------------------ */

/** Approval vocabulary for ApprovalBadge: approved only when the pin still
 * points at the current revision; any edit returns it to draft. */
export function environmentApprovalState(
  entry: EnvironmentCanonEntry,
): "draft" | "approved" {
  return entry.approvedRevisionId !== null &&
    entry.approvedRevisionId === currentRevision(entry).id
    ? "approved"
    : "draft";
}

/** The frozen contract shape a scene composer consumes for this entry. */
export function environmentStateFor(
  entry: EnvironmentCanonEntry,
  revisionId?: string,
): EnvironmentState {
  const revision = revisionId
    ? entry.revisions.find((candidate) => candidate.id === revisionId) ?? currentRevision(entry)
    : currentRevision(entry);
  return {
    environmentCanonRevisionId: revision.id,
    ...(entry.zone ? { zone: entry.zone } : {}),
    ...(entry.lighting ? { lighting: entry.lighting } : {}),
    ...(entry.timeOfDay ? { timeOfDay: entry.timeOfDay } : {}),
    ...(entry.weather ? { weather: entry.weather } : {}),
    persistentProps: entry.persistentProps,
  };
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

export function useEnvironments(): { environments: EnvironmentCanonEntry[]; ready: boolean } {
  const environments = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    void ensureEnvironmentsHydrated();
  }, []);
  return { environments, ready };
}

/** Test hook: drop the cache and hydration state (node tests only). */
export function resetEnvironmentsForTests(): void {
  cache = null;
  hydration = null;
}

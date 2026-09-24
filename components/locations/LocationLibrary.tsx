"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LibraryShell } from "@/components/library/LibraryShell";
import { MenuItem } from "@/components/library/MenuItem";
import {
  CARD_CHECK,
  CARD_FALLBACK,
  CARD_MEDIA,
  CARD_MENU_BTN,
  CARD_INFO,
  CARD_INFO_META,
  CARD_INFO_REVEAL,
  CARD_SELECTED,
  CARD_SHELL,
  CARD_STAR,
  CARD_STAR_GHOST,
  CARD_STAR_ON,
  CARD_TITLE,
} from "@/components/library/card-styles";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  FieldShell,
  TextAreaField,
  formatDate,
  useToast,
} from "@/components/ui";
import { uploadFrameRef } from "@/lib/media/frame";
import type { LocationRow } from "@/lib/repositories/location-row";
import type { SortMode } from "@/lib/library-selectors";

/**
 * The location library: server-backed reference-plate grid with search,
 * favourites, manage mode, and a create/edit dialog (name, description,
 * lighting, palette, plate upload). Plates are plain uploads — AI plate
 * generation is wired in later.
 */

const CAPTION = "Places your scenes return to — a consistent anchor for every render.";

function newLocationId(): string {
  return `loc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Editable subset of a row; empty strings become absent fields on save. */
interface LocationDraft {
  id: string | null; // null = create
  name: string;
  description: string;
  lighting: string;
  palette: string;
  ref: string;
}

const EMPTY_DRAFT: LocationDraft = {
  id: null,
  name: "",
  description: "",
  lighting: "",
  palette: "",
  ref: "",
};

function draftFor(row: LocationRow | null): LocationDraft {
  if (!row) return { ...EMPTY_DRAFT };
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    lighting: row.lighting ?? "",
    palette: row.palette ?? "",
    ref: row.ref ?? "",
  };
}

export function LocationLibrary() {
  const toast = useToast();

  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [ready, setReady] = useState(false);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [favouritesOnly, setFavouritesOnly] = useState(false);

  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editor, setEditor] = useState<LocationDraft | null>(null);
  const [plateBusy, setPlateBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<LocationRow[] | null>(null);

  const plateInputRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/locations", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { locations?: LocationRow[] };
      if (Array.isArray(body.locations)) setLocations(body.locations);
    } catch {
      /* server unreachable — keep whatever the tab already has */
    } finally {
      setReady(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const favouriteCount = locations.filter((l) => l.favorite).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return locations
      .filter((l) => !favouritesOnly || l.favorite)
      .filter((l) =>
        q
          ? [l.name, l.description, l.lighting, l.palette].some((t) =>
              t?.toLowerCase().includes(q),
            )
          : true,
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : sort === "oldest"
            ? a.updatedAt - b.updatedAt
            : b.updatedAt - a.updatedAt,
      );
  }, [locations, query, favouritesOnly, sort]);

  function exitManage() {
    setManage(false);
    setSelected(new Set());
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Upsert one row to the server and fold it into the local grid. */
  async function putRow(row: LocationRow): Promise<boolean> {
    const res = await fetch("/api/locations", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      toast.push("That location could not be saved. Please retry.", "error");
      return false;
    }
    const body = (await res.json().catch(() => ({}))) as { location?: LocationRow };
    if (!body.location) return false;
    setLocations((prev) => [body.location!, ...prev.filter((l) => l.id !== body.location!.id)]);
    return true;
  }

  async function toggleFavorite(row: LocationRow) {
    const next = { ...row, favorite: !row.favorite, updatedAt: Date.now() };
    setLocations((prev) => prev.map((l) => (l.id === row.id ? next : l))); // optimistic
    const ok = await putRow(next);
    if (!ok) setLocations((prev) => prev.map((l) => (l.id === row.id ? row : l)));
  }

  async function saveDraft() {
    if (!editor) return;
    const name = editor.name.trim() || "Untitled location";
    setSaving(true);
    try {
      if (editor.id) {
        const current = locations.find((l) => l.id === editor.id);
        if (!current) return;
        const ok = await putRow({
          ...current,
          name,
          ...(editor.description.trim() ? { description: editor.description.trim() } : {}),
          ...(editor.lighting.trim() ? { lighting: editor.lighting.trim() } : {}),
          ...(editor.palette.trim() ? { palette: editor.palette.trim() } : {}),
          ...(editor.ref ? { ref: editor.ref } : {}),
          updatedAt: Date.now(),
        });
        if (!ok) return;
      } else {
        const now = Date.now();
        const ok = await putRow({
          id: newLocationId(),
          name,
          ...(editor.description.trim() ? { description: editor.description.trim() } : {}),
          ...(editor.lighting.trim() ? { lighting: editor.lighting.trim() } : {}),
          ...(editor.palette.trim() ? { palette: editor.palette.trim() } : {}),
          ...(editor.ref ? { ref: editor.ref } : {}),
          createdAt: now,
          updatedAt: now,
        });
        if (!ok) return;
      }
      toast.push(editor.id ? "Location updated." : "Location saved.", "success");
      setEditor(null);
    } finally {
      setSaving(false);
    }
  }

  async function uploadPlate(file: File) {
    setPlateBusy(true);
    try {
      const ref = await uploadFrameRef(file);
      setEditor((d) => (d ? { ...d, ref } : d));
      toast.push("Reference plate uploaded.", "success");
    } catch (error) {
      toast.push(
        error instanceof Error ? error.message : "That plate could not be uploaded.",
        "error",
      );
    } finally {
      setPlateBusy(false);
    }
  }

  function confirmDelete() {
    if (!deleteTargets?.length) return;
    const ids = deleteTargets.map((l) => l.id);
    const qs = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    void fetch(`/api/locations?${qs}`, { method: "DELETE" });
    setLocations((prev) => prev.filter((l) => !ids.includes(l.id)));
    toast.push(`${ids.length} location${ids.length === 1 ? "" : "s"} deleted.`, "success");
    setDeleteTargets(null);
    setSelected(new Set());
  }

  const deleteBody = deleteTargets
    ? `This deletes ${deleteTargets.length === 1 ? `“${deleteTargets[0].name}”` : `${deleteTargets.length} locations`} permanently. Scenes that referenced it keep their renders.`
    : "";

  const editorOpen = Boolean(editor);

  return (
    <LibraryShell
      title="Locations"
      caption={ready ? CAPTION : " "}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search names, descriptions, palettes"
      sort={sort}
      onSortChange={setSort}
      favouritesOnly={favouritesOnly}
      onToggleFavourites={() => setFavouritesOnly((v) => !v)}
      cta={
        <Button icon="plus" onClick={() => setEditor(draftFor(null))}>
          New location
        </Button>
      }
      manage={manage}
      onToggleManage={() => (manage ? exitManage() : setManage(true))}
      loading={!ready}
      empty={
        ready && locations.length === 0 ? (
          <EmptyState
            icon="image"
            title="No locations yet"
            body="Save a place with a reference plate, then reuse it across scenes so every render sits in the same world."
            action={
              <Button icon="plus" onClick={() => setEditor(draftFor(null))}>
                Add your first location
              </Button>
            }
          />
        ) : ready && visible.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matches"
            body="Try a different word, or clear the filters to see every location."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setFavouritesOnly(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : null
      }
      manageBar={
        <>
          <span className="text-[12.5px] font-semibold text-ink-soft">
            {selected.size} selected
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon="check"
            disabled={visible.length === 0}
            onClick={() =>
              setSelected(
                visible.every((l) => selected.has(l.id))
                  ? new Set()
                  : new Set(visible.map((l) => l.id)),
              )
            }
          >
            {visible.length > 0 && visible.every((l) => selected.has(l.id))
              ? "Deselect all"
              : "Select all"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="star"
            disabled={selected.size === 0}
            onClick={() => {
              selected.forEach((id) => {
                const l = locations.find((x) => x.id === id);
                if (l && !l.favorite) void toggleFavorite(l);
              });
              toast.push("Added to favourites.", "success");
            }}
          >
            Favourite
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            disabled={selected.size === 0}
            onClick={() => setDeleteTargets(locations.filter((l) => selected.has(l.id)))}
          >
            Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={exitManage}>
            Done
          </Button>
        </>
      }
    >
      {ready && visible.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {!manage && (
            <button
              type="button"
              aria-label="New location"
              onClick={() => setEditor(draftFor(null))}
              className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-border-strong bg-surface text-muted transition-colors hover:border-primary hover:text-primary"
            >
              <Icon name="plus" size={22} />
              <span className="text-[13px] font-semibold">New location</span>
            </button>
          )}
          {visible.map((location) => {
            const isSelected = selected.has(location.id);
            const metaLeft = [location.lighting, location.palette].filter(Boolean).join(" · ");
            return (
              <div
                key={location.id}
                className={`${CARD_SHELL} ${
                  manage && isSelected ? CARD_SELECTED : "border-border"
                }`}
              >
                {manage ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Select ${location.name}`}
                    onClick={() => toggleSelected(location.id)}
                    className="block w-full"
                  >
                    <LocationPlate location={location} />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`Edit ${location.name}`}
                    onClick={() => setEditor(draftFor(location))}
                    className="block w-full"
                  >
                    <LocationPlate location={location} />
                  </button>
                )}

                {/* Info scrim — always-on title, hover reveals the description */}
                <div className={CARD_INFO}>
                  <div className={CARD_TITLE}>{location.name}</div>
                  <div className={CARD_INFO_META}>
                    <span className="min-w-0 truncate">{metaLeft || "\u00a0"}</span>
                    <span className="shrink-0">{formatDate(location.updatedAt)}</span>
                  </div>
                  <div className={CARD_INFO_REVEAL}>
                    <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-white/90">
                      {location.description || "No description yet."}
                    </p>
                  </div>
                </div>

                {/* Overlay controls */}
                {manage ? (
                  <span
                    role="checkbox"
                    aria-checked={isSelected}
                    className={CARD_CHECK}
                  >
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={location.favorite ? "Remove favourite" : "Add favourite"}
                    onClick={() => void toggleFavorite(location)}
                    className={`${CARD_STAR} ${
                      location.favorite ? CARD_STAR_ON : CARD_STAR_GHOST
                    }`}
                  >
                    <Icon name="star" size={14} />
                  </button>
                )}
                {!manage && (
                  <button
                    type="button"
                    aria-label={`Actions for ${location.name}`}
                    aria-expanded={menuId === location.id}
                    onClick={() =>
                      setMenuId((id) => (id === location.id ? null : location.id))
                    }
                    className={CARD_MENU_BTN}
                  >
                    <Icon name="more" size={15} />
                  </button>
                )}
                {menuId === location.id && !manage && (
                  <>
                    <button
                      type="button"
                      aria-label="Close menu"
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => setMenuId(null)}
                    />
                    <div
                      role="menu"
                      className="absolute right-2.5 top-11 z-20 w-52 rounded-[14px] border border-border bg-raised p-1.5 shadow-lift"
                    >
                      <MenuItem
                        icon="sliders"
                        label="Edit location"
                        onSelect={() => {
                          setEditor(draftFor(location));
                          setMenuId(null);
                        }}
                      />
                      <MenuItem
                        icon="star"
                        label={location.favorite ? "Remove favourite" : "Add favourite"}
                        onSelect={() => {
                          void toggleFavorite(location);
                          setMenuId(null);
                        }}
                      />
                      <div className="my-1 h-px bg-border" />
                      <MenuItem
                        icon="trash"
                        label="Delete"
                        tone="danger"
                        onSelect={() => {
                          setDeleteTargets([location]);
                          setMenuId(null);
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create / edit dialog */}
      {editorOpen && editor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editor.id ? "Edit location" : "New location"}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/40 p-4"
        >
          <div className="my-8 w-full max-w-lg rounded-[20px] border border-border bg-raised p-6 shadow-lift">
            <h2 className="text-base font-bold text-ink">
              {editor.id ? "Edit location" : "New location"}
            </h2>
            <div className="mt-5 space-y-4">
              <FieldShell label="Name" htmlFor="location-name">
                <input
                  id="location-name"
                  value={editor.name}
                  autoFocus
                  placeholder="e.g. The docks at dawn"
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                />
              </FieldShell>
              <TextAreaField
                label="Description"
                value={editor.description}
                maxLength={600}
                rows={3}
                placeholder="Prose establishing shot: what the camera sees when a scene opens here."
                onChange={(value) => setEditor({ ...editor, description: value })}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell label="Lighting" htmlFor="location-lighting">
                  <input
                    id="location-lighting"
                    value={editor.lighting}
                    placeholder="e.g. overcast, sodium lamps"
                    onChange={(e) => setEditor({ ...editor, lighting: e.target.value })}
                    className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                  />
                </FieldShell>
                <FieldShell label="Palette" htmlFor="location-palette">
                  <input
                    id="location-palette"
                    value={editor.palette}
                    placeholder="e.g. teal and rust"
                    onChange={(e) => setEditor({ ...editor, palette: e.target.value })}
                    className="h-11 w-full rounded-[12px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
                  />
                </FieldShell>
              </div>

              {/* Reference plate: plain upload for now; AI plate generation
                  is wired in later by the story-consistency runner. */}
              <FieldShell
                label="Reference plate"
                hint="A photo-style anchor image of the place, reused across renders."
              >
                <div className="flex flex-wrap items-center gap-3">
                  {editor.ref ? (
                    <MediaFrame
                      src={`/api/media?f=${editor.ref}`}
                      alt="Reference plate preview"
                      ratio="16/9"
                      className="w-28 rounded-[10px]"
                    />
                  ) : (
                    <span className="flex h-[63px] w-28 items-center justify-center rounded-[10px] border border-dashed border-border-strong bg-surface text-muted">
                      <Icon name="image" size={18} />
                    </span>
                  )}
                  <input
                    ref={plateInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadPlate(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="upload"
                    loading={plateBusy}
                    onClick={() => plateInputRef.current?.click()}
                  >
                    {editor.ref ? "Replace plate" : "Upload plate"}
                  </Button>
                  <Button variant="secondary" size="sm" icon="sparkle" disabled>
                    Generate plate (coming soon)
                  </Button>
                </div>
              </FieldShell>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditor(null)}>
                Cancel
              </Button>
              <Button size="sm" loading={saving} onClick={() => void saveDraft()}>
                {editor.id ? "Save changes" : "Save location"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTargets)}
        title={
          deleteTargets && deleteTargets.length > 1
            ? `Delete ${deleteTargets.length} locations?`
            : `Delete “${deleteTargets?.[0]?.name ?? ""}”?`
        }
        body={deleteBody}
        onCancel={() => setDeleteTargets(null)}
        onConfirm={confirmDelete}
      />
    </LibraryShell>
  );
}

/** Plate image with a placeholder tile when no reference is set yet. */
function LocationPlate({ location }: { location: LocationRow }) {
  if (location.ref) {
    return (
      <MediaFrame
        src={`/api/media?f=${location.ref}`}
        alt={location.name}
        ratio="16/10"
        rounded="rounded-[15px]"
        className={CARD_MEDIA}
      />
    );
  }
  return (
    <div className={`${CARD_FALLBACK} aspect-[16/10] rounded-[15px]`}>
      <Badge>No plate yet</Badge>
    </div>
  );
}

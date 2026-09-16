"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LibraryShell } from "@/components/library/LibraryShell";
import { PromptDialog } from "@/components/library/PromptDialog";
import { TagEditorDialog } from "@/components/library/TagEditorDialog";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  LinkButton,
  formatDate,
  useToast,
} from "@/components/ui";
import { MAX_SCENE_CHARACTERS } from "@/lib/character";
import {
  removeCharacters,
  toggleCharacterFavorite,
  updateCharacter,
  addCharacter,
  useCharacters,
  type SavedCharacter,
} from "@/lib/character-store";
import {
  castUsage,
  characterFamilies,
  cloneForDuplicate,
  collectCharacterTags,
  selectCharacters,
  type SortMode,
} from "@/lib/library-selectors";
import {
  setSoloCharacters,
  setStoryCharacters,
  useSettings,
} from "@/lib/repositories/settings.repository";

/**
 * The character library: server-backed poster grid with search, tag/family
 * filters, favourites, manage mode, and one-click duplicate / vary / cast.
 * Editing opens the wizard at /character/[id]; this page owns management.
 */
export function CharacterLibrary() {
  const toast = useToast();
  const router = useRouter();
  const { characters, ready } = useCharacters();
  const { settings, ready: settingsReady } = useSettings();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [familyId, setFamilyId] = useState<string | null>(null);

  const [manage, setManage] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SavedCharacter | null>(null);
  const [tagTargets, setTagTargets] = useState<SavedCharacter[] | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<SavedCharacter[] | null>(null);

  const parentNames = useMemo(
    () => new Map(characters.map((c) => [c.id, c.name] as const)),
    [characters],
  );
  const families = useMemo(() => characterFamilies(characters), [characters]);
  const allTags = useMemo(() => collectCharacterTags(characters), [characters]);

  const visible = useMemo(
    () =>
      selectCharacters(characters, { query, favouritesOnly, sort, activeTags, familyId }),
    [characters, query, favouritesOnly, sort, activeTags, familyId],
  );

  const favouriteCount = characters.filter((c) => c.favorite).length;
  const hasFilters = Boolean(query) || favouritesOnly || activeTags.length > 0 || familyId;

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

  function detachFromCasts(id: string) {
    if (settings.soloCharacterIds.includes(id)) {
      setSoloCharacters(settings.soloCharacterIds.filter((cid) => cid !== id));
    }
    if (settings.storyCharacterIds.includes(id)) {
      setStoryCharacters(settings.storyCharacterIds.filter((cid) => cid !== id));
    }
  }

  function confirmDelete() {
    if (!deleteTargets?.length) return;
    const ids = deleteTargets.map((c) => c.id);
    ids.forEach(detachFromCasts);
    removeCharacters(ids);
    toast.push(
      `${ids.length} character${ids.length === 1 ? "" : "s"} deleted.`,
      "success",
    );
    setDeleteTargets(null);
    setSelected(new Set());
  }

  function addToCast(cast: "solo" | "story", character: SavedCharacter) {
    const current =
      cast === "solo" ? settings.soloCharacterIds : settings.storyCharacterIds;
    if (current.includes(character.id)) return;
    if (current.length >= MAX_SCENE_CHARACTERS) {
      toast.push(
        `The ${cast === "solo" ? "Solo" : "Story"} cast is full (${MAX_SCENE_CHARACTERS}). Remove someone first.`,
        "error",
      );
      return;
    }
    const next = [...current, character.id];
    if (cast === "solo") setSoloCharacters(next);
    else setStoryCharacters(next);
    toast.push(`“${character.name}” added to the ${cast === "solo" ? "Solo" : "Story"} cast.`, "success");
  }

  function saveTags(targets: SavedCharacter[], tags: string[]) {
    targets.forEach((c) => updateCharacter(c.id, { tags: tags.length ? tags : undefined }));
    toast.push(
      targets.length === 1 ? "Tags updated." : `Tags applied to ${targets.length} characters.`,
      "success",
    );
    setTagTargets(null);
  }

  function duplicate(c: SavedCharacter) {
    const copy = cloneForDuplicate(c);
    addCharacter(copy.name, c.spec, c.thumbnail, c.tags?.length ? { tags: c.tags } : undefined);
    toast.push(`“${copy.name}” created.`, "success");
  }

  const deleteBody = deleteTargets
    ? [
        `This deletes ${deleteTargets.length === 1 ? `“${deleteTargets[0].name}”` : `${deleteTargets.length} characters`} permanently.`,
        deleteTargets.some((c) => castUsage(c.id, settings.soloCharacterIds, settings.storyCharacterIds).solo ||
          castUsage(c.id, settings.soloCharacterIds, settings.storyCharacterIds).story)
          ? "Characters used in a Solo or Story cast are detached from it first."
          : null,
        "Their variations stay in the library.",
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <LibraryShell
      title="Characters"
      caption={
        settingsReady
          ? `${characters.length} character${characters.length === 1 ? "" : "s"} · ${favouriteCount} favorite${favouriteCount === 1 ? "" : "s"}`
          : " "
      }
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search names, prompts, tags"
      sort={sort}
      onSortChange={setSort}
      favouritesOnly={favouritesOnly}
      onToggleFavourites={() => setFavouritesOnly((v) => !v)}
      cta={
        <LinkButton href="/character/new" icon="plus">
          New character
        </LinkButton>
      }
      manage={manage}
      onToggleManage={() => (manage ? exitManage() : setManage(true))}
      loading={!ready}
      empty={
        ready && characters.length === 0 ? (
          <EmptyState
            icon="character"
            title="No characters yet"
            body="Design your first character, then reuse them across Solo renders and Story scenes."
            action={
              <LinkButton href="/character/new" icon="plus">
                Create your first character
              </LinkButton>
            }
          />
        ) : ready && visible.length === 0 ? (
          <EmptyState
            icon="search"
            title="No matches"
            body="Try a different word, or clear the filters to see every character."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setActiveTags([]);
                  setFamilyId(null);
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
                visible.every((c) => selected.has(c.id))
                  ? new Set()
                  : new Set(visible.map((c) => c.id)),
              )
            }
          >
            {visible.length > 0 && visible.every((c) => selected.has(c.id))
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
                const c = characters.find((x) => x.id === id);
                if (c && !c.favorite) toggleCharacterFavorite(id);
              });
              toast.push("Added to favourites.", "success");
            }}
          >
            Favourite
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="chip"
            disabled={selected.size === 0}
            onClick={() =>
              setTagTargets(characters.filter((c) => selected.has(c.id)))
            }
          >
            Add tag
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            disabled={selected.size === 0}
            onClick={() => setDeleteTargets(characters.filter((c) => selected.has(c.id)))}
          >
            Delete selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={exitManage}>
            Done
          </Button>
        </>
      }
      filters={
        <>
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={activeTags.includes(tag)}
              onClick={() =>
                setActiveTags((prev) =>
                  prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
                )
              }
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                activeTags.includes(tag)
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
              }`}
            >
              {tag}
            </button>
          ))}
          {families.map(({ parent, count }) => (
            <button
              key={parent.id}
              type="button"
              aria-pressed={familyId === parent.id}
              onClick={() => setFamilyId(familyId === parent.id ? null : parent.id)}
              className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                familyId === parent.id
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-raised text-ink-soft hover:border-border-strong hover:text-ink"
              }`}
            >
              <Icon name="character" size={12} />
              Family: {parent.name} · {count}
            </button>
          ))}
        </>
      }
    >
      {ready && visible.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {!manage && (
            <Link
              href="/character/new"
              aria-label="New character"
              className="flex aspect-[4/5] flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-border-strong bg-surface text-muted transition-colors hover:border-primary hover:text-primary"
            >
              <Icon name="plus" size={22} />
              <span className="text-[13px] font-semibold">New character</span>
            </Link>
          )}
          {visible.map((character) => {
            const usage = castUsage(
              character.id,
              settings.soloCharacterIds,
              settings.storyCharacterIds,
            );
            const isSelected = selected.has(character.id);
            const tags = character.tags ?? [];
            return (
              <div
                key={character.id}
                className={`group relative rounded-[16px] border bg-raised p-2 shadow-card transition-shadow hover:shadow-lift ${
                  manage && isSelected ? "border-primary" : "border-border"
                }`}
              >
                {/* Thumbnail / select toggle */}
                {manage ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Select ${character.name}`}
                    onClick={() => toggleSelected(character.id)}
                    className="block w-full"
                  >
                    <CharacterThumb character={character} parentName={character.parentId ? parentNames.get(character.parentId) : undefined} />
                  </button>
                ) : (
                  <Link
                    href={`/character/${character.id}`}
                    aria-label={`Open ${character.name}`}
                    className="block"
                  >
                    <CharacterThumb character={character} parentName={character.parentId ? parentNames.get(character.parentId) : undefined} />
                  </Link>
                )}

                {/* Favourite star / manage checkbox, top-left */}
                {manage ? (
                  <span
                    className={`absolute left-3.5 top-3.5 flex size-6 items-center justify-center rounded-full border-2 ${
                      isSelected
                        ? "border-primary bg-primary-strong text-white"
                        : "border-white/70 bg-black/30 text-transparent"
                    }`}
                  >
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={
                      character.favorite ? "Remove favourite" : "Add favourite"
                    }
                    onClick={() => toggleCharacterFavorite(character.id)}
                    className={`absolute left-3.5 top-3.5 flex size-7 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-opacity ${
                      character.favorite
                        ? "text-warning opacity-100"
                        : "text-white opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <Icon name="star" size={14} />
                  </button>
                )}

                {/* Actions menu, top-right */}
                {!manage && (
                  <div className="absolute right-3.5 top-3.5">
                    <button
                      type="button"
                      aria-label={`Actions for ${character.name}`}
                      aria-expanded={menuId === character.id}
                      onClick={() =>
                        setMenuId((id) => (id === character.id ? null : character.id))
                      }
                      className="flex size-7 items-center justify-center rounded-full bg-black/35 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 aria-expanded:opacity-100"
                    >
                      <Icon name="more" size={15} />
                    </button>
                    {menuId === character.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Close menu"
                          className="fixed inset-0 z-10 cursor-default"
                          onClick={() => setMenuId(null)}
                        />
                        <div
                          role="menu"
                          className="absolute right-0 top-9 z-20 w-52 rounded-[14px] border border-border bg-raised p-1.5 shadow-lift"
                        >
                          <MenuLink icon="user" label="Open & edit" href={`/character/${character.id}`} onDone={() => setMenuId(null)} />
                          <MenuItem
                            icon="copy"
                            label="Rename"
                            onSelect={() => {
                              setRenameTarget(character);
                              setMenuId(null);
                            }}
                          />
                          <MenuItem
                            icon="layers"
                            label="Duplicate"
                            onSelect={() => {
                              duplicate(character);
                              setMenuId(null);
                            }}
                          />
                          <MenuItem
                            icon="sparkle"
                            label="Create variation"
                            onSelect={() => {
                              router.push(`/character/new?parent=${character.id}`);
                            }}
                          />
                          {!usage.solo && (
                            <MenuItem
                              icon="plus"
                              label="Add to Solo cast"
                              onSelect={() => {
                                addToCast("solo", character);
                                setMenuId(null);
                              }}
                            />
                          )}
                          {!usage.story && (
                            <MenuItem
                              icon="plus"
                              label="Add to Story cast"
                              onSelect={() => {
                                addToCast("story", character);
                                setMenuId(null);
                              }}
                            />
                          )}
                          <MenuItem
                            icon="star"
                            label="Add tag"
                            onSelect={() => {
                              setTagTargets([character]);
                              setMenuId(null);
                            }}
                          />
                          <div className="my-1 h-px bg-border" />
                          <MenuItem
                            icon="trash"
                            label="Delete"
                            tone="danger"
                            onSelect={() => {
                              setDeleteTargets([character]);
                              setMenuId(null);
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Meta */}
                <div className="px-1 pb-1 pt-2">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-[13.5px] font-bold text-ink">
                      {character.name}
                    </span>
                    {usage.solo && <Badge tone="primary">Solo</Badge>}
                    {usage.story && <Badge tone="primary">Story</Badge>}
                  </div>
                  {character.parentId && (
                    <p className="mt-0.5 truncate text-[11.5px] text-muted">
                      ↳ {parentNames.get(character.parentId) ?? "Variation"}
                    </p>
                  )}
                  {tags.length > 0 && (
                    <p className="mt-0.5 truncate text-[11.5px] text-ink-soft">
                      {tags.slice(0, 2).join(" · ")}
                      {tags.length > 2 ? ` +${tags.length - 2}` : ""}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted">
                    {formatDate(character.updatedAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PromptDialog
        open={Boolean(renameTarget)}
        title="Rename character"
        label="Name"
        initial={renameTarget?.name ?? ""}
        onSave={(name) => {
          if (renameTarget) updateCharacter(renameTarget.id, { name });
          setRenameTarget(null);
          toast.push("Character renamed.", "success");
        }}
        onCancel={() => setRenameTarget(null)}
      />

      <TagEditorDialog
        open={Boolean(tagTargets)}
        title={tagTargets && tagTargets.length > 1 ? `Tag ${tagTargets.length} characters` : "Edit tags"}
        initial={tagTargets?.length === 1 ? tagTargets[0].tags ?? [] : []}
        onSave={(tags) => tagTargets && saveTags(tagTargets, tags)}
        onCancel={() => setTagTargets(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTargets)}
        title={
          deleteTargets && deleteTargets.length > 1
            ? `Delete ${deleteTargets.length} characters?`
            : `Delete “${deleteTargets?.[0]?.name ?? ""}”?`
        }
        body={deleteBody}
        onCancel={() => setDeleteTargets(null)}
        onConfirm={confirmDelete}
      />
    </LibraryShell>
  );
}

/** Portrait thumbnail with a letter-tile fallback and lineage chip. */
function CharacterThumb({
  character,
  parentName,
}: {
  character: SavedCharacter;
  parentName?: string;
}) {
  if (character.thumbnail) {
    return (
      <MediaFrame
        src={character.thumbnail}
        alt={character.name}
        ratio="4/5"
        rounded="rounded-[12px]"
        className="w-full border border-border"
      />
    );
  }
  return (
    <div className="flex aspect-[4/5] w-full items-center justify-center rounded-[12px] border border-border bg-surface-2">
      <span className="text-[34px] font-extrabold text-muted">
        {character.name.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  href,
  onSelect,
  onDone,
  tone = "default",
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  href?: string;
  onSelect?: () => void;
  onDone?: () => void;
  tone?: "default" | "danger";
}) {
  const className = `flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${
    tone === "danger"
      ? "text-danger hover:bg-danger-soft"
      : "text-ink-soft hover:bg-surface-2"
  }`;
  if (href) {
    return (
      <Link href={href} role="menuitem" className={className} onClick={onDone}>
        <Icon name={icon} size={15} />
        {label}
      </Link>
    );
  }
  return (
    <button type="button" role="menuitem" className={className} onClick={onSelect}>
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}

function MenuLink(props: { icon: Parameters<typeof Icon>[0]["name"]; label: string; href: string; onDone?: () => void }) {
  return <MenuItem {...props} />;
}

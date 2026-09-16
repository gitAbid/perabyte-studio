"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { LibraryShell } from "@/components/library/LibraryShell";
import { MenuItem } from "@/components/library/MenuItem";
import { PromptDialog } from "@/components/library/PromptDialog";
import { TagEditorDialog } from "@/components/library/TagEditorDialog";
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
  CARD_USAGE_CHIP,
} from "@/components/library/card-styles";
import {
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
            const lineage = character.parentId
              ? parentNames.get(character.parentId)
              : undefined;
            const metaLeft = [
              lineage ? `\u21b3 ${lineage}` : character.parentId ? "Variation" : "",
              ...tags.slice(0, 2),
            ]
              .filter(Boolean)
              .join(" \u00b7 ");
            const media = <CharacterThumb character={character} />;
            return (
              <div
                key={character.id}
                className={`${CARD_SHELL} ${
                  manage && isSelected ? CARD_SELECTED : "border-border"
                }`}
              >
                {manage ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    aria-label={`Select ${character.name}`}
                    onClick={() => toggleSelected(character.id)}
                    className="block w-full"
                  >
                    {media}
                  </button>
                ) : (
                  <Link
                    href={`/character/${character.id}`}
                    aria-label={`Open ${character.name}`}
                    className="block"
                  >
                    {media}
                  </Link>
                )}

                {/* Info scrim — always-on title, hover reveals the prompt */}
                <div className={CARD_INFO}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={CARD_TITLE}>{character.name}</span>
                    {(usage.solo || usage.story) && (
                      <span className="flex shrink-0 gap-1">
                        {usage.solo && <span className={CARD_USAGE_CHIP}>Solo</span>}
                        {usage.story && <span className={CARD_USAGE_CHIP}>Story</span>}
                      </span>
                    )}
                  </div>
                  <div className={CARD_INFO_META}>
                    <span className="min-w-0 truncate">{metaLeft || "\u00a0"}</span>
                    <span className="shrink-0">{formatDate(character.updatedAt)}</span>
                  </div>
                  <div className={CARD_INFO_REVEAL}>
                    <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-white/90">
                      {character.spec.prompt}
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
                    aria-label={
                      character.favorite ? "Remove favourite" : "Add favourite"
                    }
                    onClick={() => toggleCharacterFavorite(character.id)}
                    className={`${CARD_STAR} ${
                      character.favorite ? CARD_STAR_ON : CARD_STAR_GHOST
                    }`}
                  >
                    <Icon name="star" size={14} />
                  </button>
                )}
                {!manage && (
                  <button
                    type="button"
                    aria-label={`Actions for ${character.name}`}
                    aria-expanded={menuId === character.id}
                    onClick={() =>
                      setMenuId((id) => (id === character.id ? null : character.id))
                    }
                    className={CARD_MENU_BTN}
                  >
                    <Icon name="more" size={15} />
                  </button>
                )}
                {menuId === character.id && !manage && (
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
                      <MenuItem icon="user" label="Open & edit" href={`/character/${character.id}`} onDone={() => setMenuId(null)} />
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
                        icon="chip"
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
function CharacterThumb({ character }: { character: SavedCharacter }) {
  if (character.thumbnail) {
    return (
      <MediaFrame
        src={character.thumbnail}
        alt={character.name}
        ratio="4/5"
        rounded="rounded-[15px]"
        className={CARD_MEDIA}
      />
    );
  }
  return (
    <div className={`${CARD_FALLBACK} aspect-[4/5] rounded-[15px]`}>
      <span className="text-[38px] font-bold text-muted/60">
        {character.name.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}


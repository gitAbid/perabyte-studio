"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { MediaFrame } from "@/components/Media";
import { Badge, Button, EmptyState, LinkButton, useToast } from "@/components/ui";
import {
  DEFAULT_CHARACTER_SPEC,
  sanitizeSpec,
  sheetViewById,
  type CharacterSpec,
  type SheetViewId,
} from "@/lib/character";
import { downloadMedia } from "@/lib/generation";
import { cloneForDuplicate } from "@/lib/library-selectors";
import {
  addCharacter,
  ensureCharactersHydrated,
  getCharacter,
  updateCharacter,
  type SavedCharacter,
} from "@/lib/character-store";
import type { CharacterIdentity } from "@/lib/repositories/character-row";
import { useAssets } from "@/lib/store";

/**
 * Character detail: the landing page for a saved character — poster, the
 * latest character-sheet views, every render tagged to the character and the
 * full specification, with Edit / Copy / New generation as the actions. The
 * wizard lives one click away at /character/[id]/edit.
 */

/** The bare media-cache ref of a generated `/api/media?f=<ref>` URL (same
 * extraction the sheet panel uses for its img2img chaining). */
function mediaRefFromUrl(url: string): string | null {
  try {
    return new URL(url, "http://perabyte.invalid").searchParams.get("f");
  } catch {
    return null;
  }
}
export function CharacterDetail({ characterId }: { characterId: string }) {
  const toast = useToast();
  const router = useRouter();

  const [character, setCharacter] = useState<SavedCharacter | null>(null);
  const [missing, setMissing] = useState(false);
  const { assets } = useAssets();

  useEffect(() => {
    let cancelled = false;
    void ensureCharactersHydrated().then((rows) => {
      if (cancelled) return;
      const found = rows.find((r) => r.id === characterId) ?? getCharacter(characterId);
      if (found) setCharacter(found);
      else setMissing(true);
    });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  // Every render tagged to this character, newest first.
  const renders = useMemo(
    () =>
      assets
        .filter((a) => {
          const ids = a.meta?.characterIds;
          return Array.isArray(ids) && (ids as string[]).includes(characterId);
        })
        .sort((a, b) => b.createdAt - a.createdAt),
    [assets, characterId],
  );

  // Latest sheet: view order in meta.sheetOrder mirrors `variants`.
  const sheetViews = useMemo(() => {
    const latestSheet = renders.find((a) => Array.isArray(a.meta?.sheetOrder));
    if (!latestSheet) return [];
    const order = latestSheet.meta?.sheetOrder as string[];
    const views: {
      id: SheetViewId;
      label: string;
      url: string;
      ref: string | null;
    }[] = [];
    order.forEach((id, index) => {
      const url = latestSheet.variants[index];
      const view = sheetViewById(id);
      if (url && view) {
        views.push({ id: view.id, label: view.label, url, ref: mediaRefFromUrl(url) });
      }
    });
    return views;
  }, [renders]);

  const posterAsset = renders.find((a) => a.url === character?.thumbnail) ?? renders[0];
  const posterUrl = character?.thumbnail || posterAsset?.url || null;
  const posterRatio = posterAsset?.settings.aspect.replace(":", "/") || "9/16";

  if (missing) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 sm:px-6">
        <EmptyState
          icon="character"
          title="Character not found"
          body="This character may have been deleted, or the link is out of date."
          action={
            <LinkButton href="/character" variant="secondary">
              Back to library
            </LinkButton>
          }
        />
      </div>
    );
  }

  if (!character) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-4 py-16 sm:px-6">
        <div className="flex justify-center">
          <div
            aria-hidden
            className="size-10 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary"
          />
        </div>
      </div>
    );
  }

  const spec = sanitizeSpec(
    { ...DEFAULT_CHARACTER_SPEC, ...character.spec },
    true,
  );
  const identityFront = character.identity?.front ?? null;

  function handleCopy() {
    const copy = cloneForDuplicate(character!);
    const created = addCharacter(copy.name, character!.spec, character!.thumbnail);
    toast.push(`“${created.name}” created.`, "success");
    router.push(`/character/${created.id}`);
  }

  function handleSetPoster(url: string) {
    updateCharacter(characterId, { thumbnail: url });
    setCharacter((current) => (current ? { ...current, thumbnail: url } : current));
    toast.push("Poster updated.", "success");
  }

  /** Pin a sheet view as the canonical identity image for keyframe
   * re-anchoring — `front` is the primary; angles/seed are not tracked here. */
  function handleSetIdentity(ref: string) {
    const identity: CharacterIdentity = { front: ref };
    updateCharacter(characterId, { identity });
    setCharacter((current) => (current ? { ...current, identity } : current));
    toast.push("Identity image pinned.", "success");
  }

  function handleClearIdentity() {
    // `null` survives JSON.stringify (undefined is dropped en route) — the
    // service maps it to a real deletion.
    updateCharacter(characterId, { identity: null as unknown as CharacterIdentity });
    setCharacter((current) =>
      current ? { ...current, identity: undefined } : current,
    );
    toast.push("Identity image cleared.", "success");
  }

  function handleDownload() {
    if (posterUrl) downloadMedia(posterUrl, `perabyte-${character!.name}-${Date.now()}`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 py-5 sm:px-6 lg:py-7">
      <div className="flex items-center gap-2.5">
        <LinkButton
          href="/character"
          variant="ghost"
          size="sm"
          icon="arrow-left"
          aria-label="Back to character library"
        >
          Library
        </LinkButton>
        <div className="min-w-0 flex-1">
          <h1 className="min-w-0 truncate text-[17px] font-extrabold tracking-[-0.02em] text-ink sm:text-[19px]">
            {character.name}
          </h1>
          <p className="text-[11.5px] text-muted">
            {character.parentId ? "Variation · " : ""}
            Saved {new Date(character.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {identityFront && (
            <Badge tone="primary">
              <Icon name="user" size={11} />
              Identity set
              <button
                type="button"
                title="Clear identity image"
                aria-label="Clear identity image"
                onClick={handleClearIdentity}
                className="inline-flex items-center justify-center rounded-full transition-colors hover:bg-primary/20"
              >
                <Icon name="close" size={11} />
              </button>
            </Badge>
          )}
          <Button variant="secondary" size="sm" icon="copy" onClick={handleCopy}>
            <span className="hidden sm:inline">Copy</span>
          </Button>
          <LinkButton
            href={`/character/new?parent=${characterId}`}
            variant="secondary"
            size="sm"
            icon="plus"
          >
            <span className="hidden sm:inline">New generation</span>
          </LinkButton>
          <LinkButton href={`/character/${characterId}/edit`} size="sm" icon="sliders">
            <span className="hidden sm:inline">Edit</span>
          </LinkButton>
        </div>
      </div>

      <div className="mt-5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:items-start lg:gap-6">
        {/* Media column */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="rounded-[20px] border border-border bg-raised p-4 shadow-card sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13.5px] font-bold text-ink">Poster</p>
              <Button variant="ghost" size="sm" icon="download" onClick={handleDownload}>
                Download
              </Button>
            </div>
            <div
              className="mx-auto mt-3 w-full"
              style={{ maxWidth: `calc(66vh * ${posterRatio.replace("/", " / ")})` }}
            >
              {posterUrl ? (
                <MediaFrame
                  src={posterUrl}
                  alt={`${character.name} poster`}
                  ratio={posterRatio}
                  rounded="rounded-[16px]"
                  sensitive
                  priority
                />
              ) : (
                <div className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-border-strong bg-surface text-center">
                  <Icon name="character" size={22} className="text-muted" />
                  <p className="max-w-[220px] text-[12px] text-muted">
                    No renders yet — open Edit and render the character sheet.
                  </p>
                </div>
              )}
            </div>
          </div>

          {sheetViews.length > 0 && (
            <div className="rounded-[20px] border border-border bg-raised p-4 shadow-card sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13.5px] font-bold text-ink">Character sheet</p>
                <Badge tone="primary">
                  {sheetViews.length} of 6 views
                </Badge>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {sheetViews.map((view) => {
                  const isIdentity = view.ref !== null && view.ref === identityFront;
                  return (
                    <div
                      key={view.id}
                      className="group relative overflow-hidden rounded-[12px] border border-border bg-surface"
                    >
                      <p className="absolute left-1.5 top-1.5 z-10 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                        {view.label}
                      </p>
                      <button
                        type="button"
                        title={isIdentity ? "Clear identity image" : "Use as identity"}
                        aria-label={
                          isIdentity
                            ? `Clear ${view.label} view as identity`
                            : `Use ${view.label} view as identity`
                        }
                        aria-pressed={isIdentity}
                        disabled={view.ref === null}
                        onClick={() => {
                          if (view.ref === null) return;
                          if (isIdentity) handleClearIdentity();
                          else handleSetIdentity(view.ref);
                        }}
                        className={
                          "absolute right-1.5 top-1.5 z-10 inline-flex size-7 items-center justify-center rounded-full backdrop-blur-sm transition-colors focus-visible:opacity-100 disabled:opacity-40 " +
                          (isIdentity
                            ? "bg-primary-strong text-white opacity-100"
                            : "bg-black/55 text-white opacity-0 hover:bg-black/75 group-hover:opacity-100")
                        }
                      >
                        <Icon name="user" size={13} />
                      </button>
                      <MediaFrame
                        src={view.url}
                        alt={`${character.name} — ${view.label} view`}
                        ratio={view.id === "front" || view.id === "back" ? posterRatio : "1/1"}
                        rounded="rounded-[11px]"
                        sensitive
                      />
                      <div className="absolute inset-x-1.5 bottom-1.5 z-10 flex items-center justify-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <a
                          href={view.url}
                          download={`${character.name}-${view.id}.png`}
                          title={`Download ${view.label}`}
                          aria-label={`Download ${view.label} view`}
                          className="inline-flex size-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                        >
                          <Icon name="download" size={13} />
                        </a>
                        <button
                          type="button"
                          title={`Set ${view.label} as poster`}
                          aria-label={`Set ${view.label} view as poster`}
                          onClick={() => handleSetPoster(view.url)}
                          className="inline-flex size-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
                        >
                          <Icon name="star" size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {renders.length > 0 && (
            <div className="rounded-[20px] border border-border bg-raised p-4 shadow-card sm:p-5">
              <p className="text-[13.5px] font-bold text-ink">
                Renders <span className="font-medium text-muted">({renders.length})</span>
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {renders.map((render) => (
                  <Link
                    key={render.id}
                    href={`/results?id=${render.id}`}
                    aria-label={`Open render ${render.title}`}
                    className="group/render relative block w-full overflow-hidden rounded-[10px] border border-border transition-opacity hover:opacity-90"
                  >
                    <MediaFrame
                      src={render.url}
                      alt={render.title}
                      ratio="4/5"
                      rounded="rounded-[10px]"
                      sensitive
                    />
                  </Link>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] text-muted">
                Open a render for its full details — prompt, model, seeds and settings.
              </p>
            </div>
          )}
        </div>

        {/* Specifications column */}
        <aside className="mt-4 lg:sticky lg:top-6 lg:mt-0">
          <div className="rounded-[20px] border border-border bg-raised p-4 shadow-card sm:p-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
                <Icon name="character" size={15} />
              </span>
              <p className="text-[13.5px] font-bold text-ink">Specifications</p>
            </div>

            <div className="mt-3 space-y-1">
              {(spec.freeform
                ? ([
                    ["Identity", "Prompt-only (Simple mode)"],
                    ["Style", spec.style],
                  ] as const)
                : ([
                    ["Gender", spec.gender],
                    ["Age", `${spec.age} years old`],
                    ["Ethnicity", spec.ethnicity === "Not specified" ? "—" : spec.ethnicity],
                    ["Country", spec.country === "Not specified" ? "—" : spec.country],
                    ["Build", spec.build],
                    ["Skin tone", spec.skinTone],
                    ["Face", `${spec.faceShape} · ${spec.facialFeatures}`],
                    ["Expression", spec.expression],
                    ["Hair", `${spec.hairColor} · ${spec.hairStyle}`],
                    ["Eyes", `${spec.eyeColor} · ${spec.eyeShape}`],
                    ["Outfit", spec.outfit],
                    ["Accessories", spec.accessories],
                    ["Body details", spec.bodyDetails],
                    ["Style", spec.style],
                  ] as const)
              ).map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 text-[12px] text-muted">{label}</span>
                  <span className="truncate text-right text-[12px] font-semibold text-ink">
                    {value}
                  </span>
                </div>
              ))}
              {(spec.tattoos || spec.piercings || spec.facialHair) && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-muted">Extras</span>
                  <span className="text-right text-[12px] font-semibold text-ink">
                    {[
                      spec.tattoos && "Tattoos",
                      spec.piercings && "Piercings",
                      spec.facialHair && "Facial hair",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </div>
              )}
            </div>

            {spec.personality.trim() && (
              <div className="mt-3 rounded-[12px] border border-border bg-surface p-2.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                  Personality
                </p>
                <p className="mt-1 text-[12px] leading-snug text-ink-soft">
                  {spec.personality}
                </p>
              </div>
            )}

            <div className="mt-3 border-t border-border pt-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
                Prompt
              </p>
              <p className="mt-1.5 max-h-32 overflow-y-auto rounded-[10px] border border-border bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-soft">
                {spec.prompt || "—"}
              </p>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <LinkButton href={`/character/${characterId}/edit`} icon="sliders">
                Modify & re-render
              </LinkButton>
              <p className="text-center text-[11.5px] text-muted">
                “New generation” seeds a copy you can reconfigure before rendering.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

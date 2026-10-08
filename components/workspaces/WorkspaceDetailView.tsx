"use client";

/**
 * /workspaces/[id] — workspace home (feature spec 05 §6 primary screen).
 *
 * Client component: loads GET /api/workspaces/:id plus the read-only canon
 * library walk (./api.ts), and renders the workspace's About, Cast,
 * Environments, World Bible, Production Recipe, and spending-limit sections.
 * Every mutation is PATCH /api/workspaces/:id with expectedSaveVersion CAS;
 * a 409 STALE_REVISION reloads the latest workspace and shows the spec's
 * "someone else changed this workspace — review and retry" banner while every
 * editor keeps its values so the creator can retry the same change.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, FieldShell, LinkButton, TextAreaField, formatDate, formatTime } from "@/components/ui";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { WorkspaceContextChip } from "@/components/production/primitives/workspace";
import {
  formatFailure,
  isStaleRevisionFailure,
  loadCanonContext,
  loadWorkspace,
  patchWorkspace,
  type CanonEntityOption,
  type RequestFailure,
  type WorkspaceProductionSummary,
  RATING_DESCRIPTIONS,
  WORKSPACE_NAME_MAX,
  WORKSPACE_RATINGS,
} from "./api";
import { CastPicker, EnvironmentPicker } from "./CastPicker";
import { RecipeForm } from "./RecipeForm";
import {
  WorldBibleEntryEditor,
  draftFromEntry,
  newEntryId,
  parseTags,
  type WorldBibleEntryDraft,
} from "./WorldBibleEntryEditor";
import type { Workspace, WorldBibleEntry } from "@/lib/production/contracts";

type SectionId = "about" | "cast" | "environments" | "worldBible" | "recipe";
type SaveState = "idle" | "saving" | "saved" | "failed";

type DetailPhase =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "error"; failure: RequestFailure }
  | { kind: "ready"; workspace: Workspace };

type CanonPhase =
  | { kind: "loading" }
  | { kind: "error"; failure: RequestFailure }
  | { kind: "ready"; options: CanonEntityOption[]; projects: WorkspaceProductionSummary[]; incomplete: boolean };

const SECTION_LABELS: Record<SectionId, string> = {
  about: "workspace details",
  cast: "cast",
  environments: "environments",
  worldBible: "World Bible",
  recipe: "production recipe",
};

export function WorkspaceDetailView({ workspaceId }: { workspaceId: string }) {
  const [phase, setPhase] = useState<DetailPhase>({ kind: "loading" });
  const [canon, setCanon] = useState<CanonPhase>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [canonToken, setCanonToken] = useState(0);

  const [saveStates, setSaveStates] = useState<Partial<Record<SectionId, SaveState>>>({});
  const [saveFailure, setSaveFailure] = useState<{ section: SectionId; failure: RequestFailure } | null>(null);
  const [conflictSection, setConflictSection] = useState<SectionId | null>(null);

  useEffect(() => {
    let stopped = false;
    setPhase({ kind: "loading" });
    void loadWorkspace(workspaceId).then((result) => {
      if (stopped) return;
      if (result.ok) setPhase({ kind: "ready", workspace: result.workspace });
      else if (result.failure.status === 404) setPhase({ kind: "notFound" });
      else setPhase({ kind: "error", failure: result.failure });
    });
    return () => {
      stopped = true;
    };
  }, [workspaceId, reloadToken]);

  useEffect(() => {
    let stopped = false;
    setCanon({ kind: "loading" });
    void loadCanonContext().then((result) => {
      if (stopped) return;
      if (result.ok) setCanon({ kind: "ready", options: result.options, projects: result.projects, incomplete: result.incomplete });
      else setCanon({ kind: "error", failure: result.failure });
    });
    return () => {
      stopped = true;
    };
  }, [canonToken]);

  const retryCanon = useCallback(() => setCanonToken((token) => token + 1), []);
  const reloadWorkspace = useCallback(() => setReloadToken((token) => token + 1), []);

  /** One CAS save path for every section; keeps editor values on any failure. */
  const applyPatch = useCallback(
    async (section: SectionId, command: Record<string, unknown>): Promise<boolean> => {
      setSaveStates((current) => ({ ...current, [section]: "saving" }));
      setSaveFailure(null);
      setConflictSection(null);
      const result = await patchWorkspace(workspaceId, command);
      if (result.ok) {
        setPhase({ kind: "ready", workspace: result.workspace });
        setSaveStates((current) => ({ ...current, [section]: "saved" }));
        return true;
      }
      if (isStaleRevisionFailure(result.failure)) {
        setConflictSection(section);
        const fresh = await loadWorkspace(workspaceId);
        if (fresh.ok) setPhase({ kind: "ready", workspace: fresh.workspace });
        else if (fresh.failure.status === 404) setPhase({ kind: "notFound" });
      } else {
        setSaveFailure({ section, failure: result.failure });
      }
      setSaveStates((current) => ({ ...current, [section]: "failed" }));
      return false;
    },
    [workspaceId],
  );

  if (phase.kind === "loading") {
    return (
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="workspaces.workspace.detail">
        <div role="status" data-testid="workspaces.workspace.loading" className="rounded-[12px] border border-border bg-raised px-6 py-14 text-center text-sm text-muted">
          Loading workspace…
        </div>
      </div>
    );
  }

  if (phase.kind === "notFound") {
    return (
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="workspaces.workspace.detail">
        <div data-testid="workspaces.workspace.notFound" className="mt-6">
          <EmptyState
            icon="layers"
            title="This workspace doesn't exist"
            body="It may have been deleted, or the link is wrong. Your other workspaces are safe."
            action={<LinkButton href="/workspaces" variant="secondary" icon="arrow-left">All workspaces</LinkButton>}
            testId="workspaces.workspace.notFound.state"
          />
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="workspaces.workspace.detail">
        <div className="mt-6 space-y-4" data-testid="workspaces.workspace.error">
          <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
            <p className="text-[13px] font-bold text-ink">The workspace could not be loaded.</p>
            <p className="mt-1 text-[13px] leading-snug text-ink">{formatFailure(phase.failure)}</p>
            <p className="mt-1 text-[12px] text-muted">Nothing was changed — you can retry.</p>
          </div>
          <Button variant="secondary" size="sm" icon="refresh" onClick={reloadWorkspace} data-testid="workspaces.workspace.retry">
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const workspace = phase.workspace;

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6" data-testid="workspaces.workspace.detail">
      <Link
        href="/workspaces"
        className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
        data-testid="workspaces.workspace.back"
      >
        <span aria-hidden="true">←</span> All workspaces
      </Link>

      <header className="mt-3 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-[27px] font-medium leading-none tracking-[-0.04em] text-ink sm:text-[32px]">{workspace.name}</h1>
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <WorkspaceContextChip name={workspace.name} rating={workspace.rating} testId="workspaces.workspace.chip" />
            <span className="text-[12px] text-muted">
              Updated {formatDate(workspace.updatedAt)} {formatTime(workspace.updatedAt)}
            </span>
          </div>
          {workspace.rating === "Adult" ? (
            <p className="mt-2 max-w-xl text-[12.5px] text-warning" data-testid="workspaces.workspace.adultPolicy">
              Adult workspace: finished videos can only be shared by exporting files. Public in-app publishing is
              never available for this workspace.
            </p>
          ) : null}
        </div>
        <LinkButton href="/production/new" size="sm" icon="plus" data-testid="workspaces.production.new">
          Create episode
        </LinkButton>
      </header>

      {conflictSection ? (
        <div
          role="alert"
          data-testid="workspaces.workspace.conflict"
          className="mt-5 rounded-[8px] border border-warning/40 bg-warning-soft/60 px-3.5 py-3"
        >
          <p className="text-[13px] font-bold text-ink">Someone else changed this workspace — review and retry.</p>
          <p className="mt-1 text-[13px] leading-snug text-ink">
            Your change to the {SECTION_LABELS[conflictSection]} was not saved. The latest version of the
            workspace is now shown; check the {SECTION_LABELS[conflictSection]} below and save again.
          </p>
        </div>
      ) : null}

      {saveFailure ? (
        <div role="alert" data-testid="workspaces.workspace.saveError" className="mt-5 rounded-[8px] border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
          <p className="text-[13px] font-bold text-ink">
            The {SECTION_LABELS[saveFailure.section]} could not be saved.
          </p>
          <p className="mt-1 text-[13px] leading-snug text-ink">{formatFailure(saveFailure.failure)}</p>
          <p className="mt-1 text-[12px] text-muted">Your edits are kept — you can retry.</p>
        </div>
      ) : null}

      <div className="mt-6 space-y-6">
        <AboutSection workspace={workspace} saveState={saveStates.about ?? "idle"} onSave={applyPatch} />
        <MembershipSection
          section="cast"
          title="Cast"
          description="Characters this workspace can use. Every episode stays on-model with them."
          workspace={workspace}
          saveState={saveStates.cast ?? "idle"}
          canon={canon}
          retryCanon={retryCanon}
          onSave={applyPatch}
        />
        <MembershipSection
          section="environments"
          title="Environments"
          description="Places this workspace can return to, consistent from episode to episode."
          workspace={workspace}
          saveState={saveStates.environments ?? "idle"}
          canon={canon}
          retryCanon={retryCanon}
          onSave={applyPatch}
        />
        <WorldBibleSection workspace={workspace} saveState={saveStates.worldBible ?? "idle"} onSave={applyPatch} />
        <RecipeSection workspace={workspace} saveState={saveStates.recipe ?? "idle"} onSave={applyPatch} />
        <ProductionsSection workspace={workspace} canon={canon} />
        <BudgetNote workspace={workspace} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function SavedNote({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <span role="status" className="text-[12.5px] font-semibold text-success">
      {label}
    </span>
  );
}

function UnsavedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="text-[12px] text-muted">Unsaved changes</span>;
}

/* ------------------------------------------------------------------ */
/* About (name + rating)                                               */
/* ------------------------------------------------------------------ */

function AboutSection({
  workspace,
  saveState,
  onSave,
}: {
  workspace: Workspace;
  saveState: SaveState;
  onSave: (section: SectionId, command: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(workspace.name);
  const [rating, setRating] = useState<Workspace["rating"]>(workspace.rating);

  const dirty = name.trim() !== workspace.name || rating !== workspace.rating;
  const nameValid = name.trim().length >= 1 && name.trim().length <= WORKSPACE_NAME_MAX;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) {
      setName(workspace.name);
      setRating(workspace.rating);
    }
  }, [workspace]);

  const saving = saveState === "saving";

  return (
    <Card as="section">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">About</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        The workspace&apos;s name and who it is for. The rating sets what kind of stories belong here.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <FieldShell label="Workspace name" htmlFor="workspace-about-name" counter={`${name.trim().length}/${WORKSPACE_NAME_MAX}`}>
          <input
            id="workspace-about-name"
            value={name}
            maxLength={WORKSPACE_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink focus:border-primary focus:outline-none"
            data-testid="workspaces.about.name"
          />
        </FieldShell>

        <FieldShell label="Audience rating" htmlFor="workspace-about-rating" hint={RATING_DESCRIPTIONS[rating]}>
          <select
            id="workspace-about-rating"
            value={rating}
            onChange={(event) => setRating(event.target.value as Workspace["rating"])}
            className="h-11 w-full appearance-none rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm font-medium text-ink focus:border-primary focus:outline-none"
            data-testid="workspaces.about.rating"
          >
            {WORKSPACE_RATINGS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </FieldShell>
      </div>

      {rating === "Adult" ? (
        <p className="mt-3 text-[12.5px] text-warning">
          Adult workspaces can only be shared by exporting finished video files — public in-app publishing is
          never available for them.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon="check"
          disabled={!dirty || !nameValid || saving}
          loading={saving}
          onClick={() => {
            const command: Record<string, unknown> = { expectedSaveVersion: workspace.saveVersion };
            if (name !== workspace.name) command.name = name.trim();
            if (rating !== workspace.rating) command.rating = rating;
            void onSave("about", command);
          }}
          data-testid="workspaces.about.save"
        >
          Save
        </Button>
        <SavedNote show={saveState === "saved" && !dirty} label="Saved." />
        <UnsavedNote show={dirty && !saving} />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Cast / Environments membership                                      */
/* ------------------------------------------------------------------ */

function MembershipSection({
  section,
  title,
  description,
  workspace,
  saveState,
  canon,
  retryCanon,
  onSave,
}: {
  section: "cast" | "environments";
  title: string;
  description: string;
  workspace: Workspace;
  saveState: SaveState;
  canon: CanonPhase;
  retryCanon: () => void;
  onSave: (section: SectionId, command: Record<string, unknown>) => Promise<boolean>;
}) {
  const savedIds = section === "cast" ? workspace.characterCanonIds : workspace.environmentCanonIds;
  const [draftIds, setDraftIds] = useState<string[]>(savedIds);

  const savedKey = savedIds.join("\n");
  const draftKey = draftIds.join("\n");
  const dirty = savedKey !== draftKey;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraftIds(savedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const options = useMemo(() => {
    if (canon.kind !== "ready") return [];
    return canon.options.filter((option) => (section === "cast" ? option.entityKind === "character" : option.entityKind === "environment"));
  }, [canon, section]);

  const saving = saveState === "saving";

  function toggle(entityId: string) {
    setDraftIds((current) => (current.includes(entityId) ? current.filter((id) => id !== entityId) : [...current, entityId]));
  }

  return (
    <Card as="section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">{title}</h2>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">{description}</p>
        </div>
        <Badge tone="neutral">{savedIds.length} selected</Badge>
      </div>

      <div className="mt-4">
        {section === "cast" ? (
          <CastPicker
            options={options}
            selectedIds={draftIds}
            onToggle={toggle}
            loading={canon.kind === "loading"}
            failure={canon.kind === "error" ? canon.failure : null}
            incomplete={canon.kind === "ready" ? canon.incomplete : false}
            onRetryOptions={retryCanon}
          />
        ) : (
          <EnvironmentPicker
            options={options}
            selectedIds={draftIds}
            onToggle={toggle}
            loading={canon.kind === "loading"}
            failure={canon.kind === "error" ? canon.failure : null}
            incomplete={canon.kind === "ready" ? canon.incomplete : false}
            onRetryOptions={retryCanon}
          />
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          size="sm"
          icon="check"
          disabled={!dirty || saving}
          loading={saving}
          onClick={() => {
            void onSave(section, { expectedSaveVersion: workspace.saveVersion, [section === "cast" ? "characterCanonIds" : "environmentCanonIds"]: draftIds });
          }}
          data-testid={`workspaces.${section}.save`}
        >
          Save {title.toLowerCase()}
        </Button>
        <SavedNote show={saveState === "saved" && !dirty} label="Saved." />
        <UnsavedNote show={dirty && !saving} />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* World Bible                                                         */
/* ------------------------------------------------------------------ */

type WorldBibleDraft = { summary: string; entries: WorldBibleEntryDraft[] };

function draftFromWorldBible(worldBible: Workspace["worldBible"]): WorldBibleDraft {
  return { summary: worldBible.summary, entries: worldBible.entries.map(draftFromEntry) };
}

/** Trim-normalized fingerprint so a just-saved (server-trimmed) edit is not "dirty". */
function comparableWorldBibleDraft(draft: WorldBibleDraft): string {
  return JSON.stringify({
    summary: draft.summary,
    entries: draft.entries.map((entry) => ({
      id: entry.id,
      title: entry.title.trim(),
      body: entry.body.trim(),
      tags: parseTags(entry.tagsText) ?? [],
    })),
  });
}

function WorldBibleSection({
  workspace,
  saveState,
  onSave,
}: {
  workspace: Workspace;
  saveState: SaveState;
  onSave: (section: SectionId, command: Record<string, unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<WorldBibleDraft>(() => draftFromWorldBible(workspace.worldBible));
  const [editing, setEditing] = useState<{ key: string; draft: WorldBibleEntryDraft } | null>(null);

  const dirty = comparableWorldBibleDraft(draft) !== comparableWorldBibleDraft(draftFromWorldBible(workspace.worldBible));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFromWorldBible(workspace.worldBible));
  }, [workspace.worldBible]);

  const saving = saveState === "saving";
  const atEntryLimit = draft.entries.length >= 500;

  const entryIssues = draft.entries
    .map((entry, index) => {
      if (entry.title.trim().length === 0) return `Rule ${index + 1} needs a title.`;
      if (entry.body.trim().length === 0) return `Rule “${entry.title.trim() || index + 1}” needs a description.`;
      return null;
    })
    .filter((issue): issue is string => issue !== null);

  function upsertEntry(entry: WorldBibleEntry) {
    setDraft((current) => {
      const exists = current.entries.some((candidate) => candidate.id === entry.id);
      const entries = exists
        ? current.entries.map((candidate) => (candidate.id === entry.id ? { id: entry.id, title: entry.title, body: entry.body, tagsText: entry.tags.join(", ") } : candidate))
        : [...current.entries, { id: entry.id, title: entry.title, body: entry.body, tagsText: entry.tags.join(", ") }];
      return { ...current, entries };
    });
    setEditing(null);
  }

  function removeEntry(id: string) {
    setDraft((current) => ({ ...current, entries: current.entries.filter((candidate) => candidate.id !== id) }));
    setEditing(null);
  }

  function save() {
    if (entryIssues.length > 0 || !dirty) return;
    const entries: WorldBibleEntry[] = draft.entries.map((entry) => ({
      id: entry.id,
      title: entry.title.trim(),
      body: entry.body.trim(),
      tags: entry.tagsText.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    }));
    void onSave("worldBible", {
      expectedSaveVersion: workspace.saveVersion,
      worldBible: { version: workspace.worldBible.version + 1, summary: draft.summary, entries },
    });
  }

  return (
    <Card as="section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">World Bible</h2>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted">
            The rules of your show&apos;s world: how characters look and act, how places behave, the tone to keep.
            PeraByte follows these in every episode of this workspace.
          </p>
        </div>
        <Badge tone="neutral">
          Version {workspace.worldBible.version} · {workspace.worldBible.entries.length} rule{workspace.worldBible.entries.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="mt-4">
        <TextAreaField
          label="World summary"
          value={draft.summary}
          maxLength={20_000}
          rows={3}
          onChange={(value) => setDraft((current) => ({ ...current, summary: value }))}
          placeholder="One short paragraph about this world, e.g. “A cozy seaside town where animals run the shops.”"
          hint="Optional — the big picture of this world in a few sentences."
        />
      </div>

      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">
            Rules ({draft.entries.length})
          </p>
          {!editing && !atEntryLimit ? (
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              onClick={() => setEditing({ key: `new-${newEntryId()}`, draft: { id: newEntryId(), title: "", body: "", tagsText: "" } })}
              data-testid="workspaces.world-bible.add"
            >
              Add a rule
            </Button>
          ) : null}
        </div>

        {editing ? (
          <div className="mt-3">
            <WorldBibleEntryEditor
              key={editing.key}
              heading={draft.entries.some((candidate) => candidate.id === editing.draft.id) ? "Edit rule" : "New rule"}
              draft={editing.draft}
              onSave={upsertEntry}
              onCancel={() => setEditing(null)}
              onRemove={draft.entries.some((candidate) => candidate.id === editing.draft.id) ? () => removeEntry(editing.draft.id) : undefined}
              testPrefix="workspaces.world-bible.entry"
            />
          </div>
        ) : null}

        {draft.entries.length === 0 && !editing ? (
          <p role="status" data-testid="workspaces.world-bible.empty" className="mt-3 rounded-[8px] border border-dashed border-border-strong bg-surface px-4 py-6 text-center text-[13px] text-muted">
            No rules yet. Add the things that must stay true in every episode — a character&apos;s look, a place&apos;s
            mood, words to avoid.
          </p>
        ) : (
          <ul className="mt-3 space-y-2.5" data-testid="workspaces.world-bible.entries">
            {draft.entries
              .filter((entry) => !editing || editing.draft.id !== entry.id)
              .map((entry, index) => (
              <li key={entry.id} className="rounded-[10px] border border-border bg-surface px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-bold text-ink">{entry.title.trim() || `Rule ${index + 1}`}</p>
                    <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-ink-soft">{entry.body}</p>
                  </div>
                  {!editing ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="pen"
                      onClick={() => setEditing({ key: entry.id, draft: entry })}
                      data-testid="workspaces.world-bible.entry.edit"
                    >
                      Edit
                    </Button>
                  ) : null}
                </div>
                {entry.tagsText.trim().length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Tags">
                    {entry.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => (
                      <li key={tag} className="rounded-[5px] bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-soft">
                        {tag}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {entryIssues.length > 0 ? (
        <ul role="alert" className="mt-3 space-y-1 text-[12.5px] text-danger" data-testid="workspaces.world-bible.issues">
          {entryIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          size="sm"
          icon="check"
          disabled={!dirty || entryIssues.length > 0 || saving || editing !== null}
          loading={saving}
          onClick={save}
          data-testid="workspaces.world-bible.save"
        >
          Save World Bible
        </Button>
        <SavedNote show={saveState === "saved" && !dirty} label="Saved as a new version." />
        <UnsavedNote show={dirty && !saving} />
        <span className="text-[12px] text-muted">
          Saving creates version {workspace.worldBible.version + 1}. Episodes already made keep the version they
          were created with.
        </span>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Production recipe                                                   */
/* ------------------------------------------------------------------ */

function RecipeSection({
  workspace,
  saveState,
  onSave,
}: {
  workspace: Workspace;
  saveState: SaveState;
  onSave: (section: SectionId, command: Record<string, unknown>) => Promise<boolean>;
}) {
  return (
    <Card as="section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Production recipe</h2>
        <Badge tone="neutral">Version {workspace.productionRecipe.version}</Badge>
      </div>
      <div className="mt-4">
        <RecipeForm
          recipe={workspace.productionRecipe}
          saveState={saveState}
          onSave={(value) => {
            void onSave("recipe", {
              expectedSaveVersion: workspace.saveVersion,
              productionRecipe: { ...value, version: workspace.productionRecipe.version + 1 },
            });
          }}
        />
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Productions in this workspace                                       */
/* ------------------------------------------------------------------ */

const STAGE_LABELS: Record<string, string> = {
  setup: "Setting up",
  canon: "Cast ready",
  script: "Script started",
  shots: "In progress",
  audio: "Sound pass",
  export: "Finishing",
  complete: "Done",
};

function ProductionsSection({ workspace, canon }: { workspace: Workspace; canon: CanonPhase }) {
  const productions = canon.kind === "ready" ? canon.projects.filter((project) => project.workspaceId === workspace.id) : [];

  return (
    <Card as="section">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Productions</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        Episodes made in this workspace. Each one keeps its own copy of the cast, places, and rules from the
        moment it started — later workspace edits never change them.
      </p>

      {canon.kind === "loading" ? (
        <p role="status" className="mt-3 text-[13px] text-muted" data-testid="workspaces.productions.loading">
          Checking for productions…
        </p>
      ) : canon.kind === "error" ? (
        <p role="note" className="mt-3 text-[13px] text-muted" data-testid="workspaces.productions.unavailable">
          Productions could not be checked right now — your workspace is unaffected.
        </p>
      ) : productions.length === 0 ? (
        <div className="mt-3" data-testid="workspaces.productions.empty">
          <EmptyState
            icon="play"
            title="No episodes yet"
            body='Turn this world into its first episode with "Create episode" above — the cast, places, and rules you set here carry over automatically.'
            testId="workspaces.productions.empty.state"
          />
        </div>
      ) : (
        <ul className="mt-3 space-y-2.5" data-testid="workspaces.productions.list">
          {productions.map((production) => (
            <li key={production.id}>
              <Link
                href={`/production/${production.id}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-raised px-4 py-3 transition-colors hover:border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                data-testid="workspaces.production.open"
              >
                <span className="min-w-0 truncate text-sm font-semibold text-ink">{production.name}</span>
                <span className="flex items-center gap-3">
                  <Badge tone={production.stage === "complete" ? "success" : "primary"}>
                    {STAGE_LABELS[production.stage] ?? "In progress"}
                  </Badge>
                  <span className="text-[12px] tabular-nums text-muted">{formatDate(production.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Spending limit link                                                 */
/* ------------------------------------------------------------------ */

function BudgetNote({ workspace }: { workspace: Workspace }) {
  return (
    <Card as="section">
      <h2 className="text-[13px] font-bold uppercase tracking-[0.14em] text-accent">Spending limit</h2>
      {workspace.budgetPolicyId ? (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft" data-testid="workspaces.budget.connected">
          This workspace uses a spending limit set in Settings.{" "}
          <Link href="/settings" className="font-semibold text-primary underline underline-offset-4" data-testid="workspaces.budget.link">
            Review spending settings
          </Link>
          .
        </p>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft" data-testid="workspaces.budget.none">
          No spending limit is connected to this workspace yet.{" "}
          <Link href="/settings" className="font-semibold text-primary underline underline-offset-4" data-testid="workspaces.budget.link">
            Open Settings
          </Link>{" "}
          to set one.
        </p>
      )}
    </Card>
  );
}

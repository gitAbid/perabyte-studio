import { randomUUID } from "node:crypto";
import {
  AutoRunSchema, CreateAutoRunCommandSchema, StoryBeatSchema,
  type AutoRun, type AutoRunStage, type AutoRunStageKind, type StoryBeat,
} from "../../production/contracts";
import { ProductionApplicationError } from "../../production/errors";
import type { ProductionStore, ProductionWritePort } from "../../repositories/production/ports";
import { createStoryRevision } from "./revisions";
import { createShotPlan } from "./shot-plan";
import { getInstalledPolicy } from "./policy-service";
import { estimateAutoRunCost } from "../../production/auto-run-estimate";

export { estimateAutoRunCost };
import { isTextProvider, type TextProvider } from "../../providers/types";

/**
 * Auto Draft orchestration (spec 14, M5). One idea → a rough First Cut with no
 * manual prompt writing. The run is a persisted state machine (C17): stages
 * advance ONE step per `advanceAutoRun` call (idempotent, crash-safe — the page
 * or a worker polls it), the budget kernel keeps enforcing per-job admission on
 * every paid lane, and NOTHING is ever auto-approved: visual lanes stop the run
 * at `awaiting_review` with deep links, and the creator approves through the
 * existing per-item flows.
 *
 * Stage map (Auto Draft scope):
 *   story      — idea → script draft via the local text-engine chain → StoryRevision (free engines; policy-gated like every text path)
 *   storyboard — active story → shot plan + animatic via the existing plan service (deterministic, free)
 *   anchors    — completed once every shot has an approved anchor (creator runs the gated generations from the deep link; the run tracks)
 *   takes      — completed once every shot has a selected take (same pattern)
 *   audio      — Auto Draft skips generation: `skipped` unless an adapter is wired (Full Auto, post-Alpha)
 *   assembly   — completed once a playable export exists (creator triggers the gated assembly; the run tracks)
 *
 * Failure isolation: anchors/takes observe per-shot artifacts, so one failed
 * shot never fails the run — the stage stays running and names the laggards.
 * Cancel stops further advancement but keeps every completed artifact. Boot
 * resume: runs in `running` state are simply advanced again (every stage check
 * re-derives from stored state).
 */

const STAGE_ORDER: readonly AutoRunStageKind[] = ["story", "storyboard", "anchors", "takes", "audio", "assembly"];

export interface AutoRunServiceOptions {
  now?: () => number;
  idFactory?: () => string;
}

function fail(code: "INVALID_INPUT" | "UNKNOWN_REFERENCE" | "STALE_REVISION" | "BUDGET_BLOCKED" | "CAPABILITY_MISMATCH", message: string, details: { action?: string; retryable?: boolean } = {}): never {
  throw new ProductionApplicationError(code, message, { retryable: false, ...details });
}

function freshStages(idFactory: () => string): AutoRunStage[] {
  return STAGE_ORDER.map((kind, order) => ({
    id: idFactory(),
    kind,
    state: "pending" as const,
    order,
    sceneId: null,
    targetId: null,
    childJobIds: [],
    error: null,
    startedAt: null,
    completedAt: null,
  }));
}


export function createAutoRun(store: ProductionStore, rawCommand: unknown, options: AutoRunServiceOptions = {}): AutoRun {
  const parsed = CreateAutoRunCommandSchema.safeParse(rawCommand);
  if (!parsed.success) fail("INVALID_INPUT", `Invalid auto-run command: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const command = parsed.data;
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const run: AutoRun = AutoRunSchema.parse({
    version: 1,
    id: idFactory(),
    ...command,
    estimatedCost: estimateAutoRunCost(command),
    state: "awaiting_confirmation",
    stages: freshStages(idFactory),
    saveVersion: 1,
    confirmedAt: null,
    createdAt: now(),
    updatedAt: now(),
  });
  return store.transaction((tx) => {
    if (!tx.getProject(command.projectId)) fail("UNKNOWN_REFERENCE", "Project not found");
    tx.insertAutoRun(run);
    return run;
  });
}

function persist(tx: ProductionWritePort, run: AutoRun, now: number): AutoRun {
  const next: AutoRun = { ...run, saveVersion: run.saveVersion + 1, updatedAt: now };
  if (!tx.compareAndSetAutoRun(next, run.saveVersion)) fail("STALE_REVISION", "Auto run changed elsewhere — reload and retry", { retryable: true });
  return next;
}

function setStage(run: AutoRun, kind: AutoRunStageKind, patch: Partial<AutoRunStage>): AutoRun {
  return { ...run, stages: run.stages.map((stage) => (stage.kind === kind ? { ...stage, ...patch } : stage)) };
}

function loadRun(store: ProductionStore, runId: string): AutoRun {
  const run = store.read.getAutoRun(runId);
  if (!run) fail("UNKNOWN_REFERENCE", "Auto run not found");
  return run;
}

/** Confirm gates on the machine's reviewed spend policy, then flips the run to running. */
export async function confirmAutoRun(store: ProductionStore, runId: string, options: AutoRunServiceOptions = {}): Promise<AutoRun> {
  const now = options.now ?? Date.now;
  const run = loadRun(store, runId);
  if (run.state !== "awaiting_confirmation") return run;
  const policy = await getInstalledPolicy();
  if (!policy.configured) {
    fail("BUDGET_BLOCKED", "Auto run requires a reviewed spend policy before it can start.", { action: "Install it in Settings → Budget & authorization, then confirm the run again." });
  }
  return store.transaction((tx) => persist(tx, { ...setStage(run, "story", { state: "queued" }), state: "running", confirmedAt: now() }, now()));
}

export function listProjectAutoRuns(store: ProductionStore, projectId: string): AutoRun[] {
  return store.read.listAutoRuns(projectId);
}

export function cancelAutoRun(store: ProductionStore, runId: string, options: AutoRunServiceOptions = {}): AutoRun {
  const now = options.now ?? Date.now;
  const run = loadRun(store, runId);
  if (run.state === "completed" || run.state === "canceled") return run;
  return store.transaction((tx) => persist(tx, {
    ...run,
    state: "canceled",
    stages: run.stages.map((stage) =>
      stage.state === "queued" || stage.state === "running" || stage.state === "pending"
        ? { ...stage, state: "canceled" as const, completedAt: now() }
        : stage),
  }, now()));
}

/* ── Story stage: idea → script draft ──────────────────────────────────────── */

const BEAT_MARKER = /^##\s*BEAT:\s*(.+)$/;

/**
 * Deterministic beat parser for the story stage's engine output. Beats are
 * `## BEAT: <action>` sections; `NARRATOR: …` lines become narration, other
 * `NAME: …` lines become dialogue lines. Unparseable output fails with an
 * actionable error — never a silent guess.
 */
export function parseAutoStoryDraft(raw: string): { scriptText: string; beats: StoryBeat[] } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const beats: Array<{ action: string; narration: string; dialogue: Array<{ characterId: string; text: string }> }> = [];
  let current: (typeof beats)[number] | null = null;
  for (const line of lines) {
    const marker = line.match(BEAT_MARKER);
    if (marker) {
      current = { action: marker[1]!.trim(), narration: "", dialogue: [] };
      beats.push(current);
      continue;
    }
    if (!current) continue;
    const spoken = line.match(/^([A-Z][A-Z0-9 _-]{0,40}):\s*(.+)$/);
    if (spoken) {
      const name = spoken[1]!.trim();
      const text = spoken[2]!.trim();
      if (name.toUpperCase() === "NARRATOR") current.narration = current.narration ? `${current.narration} ${text}` : text;
      else current.dialogue.push({ characterId: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "character", text });
    }
  }
  if (beats.length === 0) {
    fail("INVALID_INPUT", "The story draft had no `## BEAT:` sections, so no storyboard could be derived.", { action: "Retry the run — the text engine returned an unusable draft." });
  }
  const scriptText = beats
    .map((beat) => [`BEAT: ${beat.action}`, beat.narration ? `NARRATOR: ${beat.narration}` : null, ...beat.dialogue.map((line) => `${line.characterId.toUpperCase()}: ${line.text}`)].filter(Boolean).join("\n"))
    .join("\n\n");
  const parsedBeats = beats.map((beat, order) => StoryBeatSchema.parse({
    id: `beat-auto-${order + 1}`,
    action: beat.action,
    narration: beat.narration,
    dialogue: beat.dialogue,
    order,
  }));
  return { scriptText, beats: parsedBeats };
}

function autoStoryPrompt(idea: string, durationTargetMs: number): string {
  const beats = Math.max(3, Math.min(12, Math.round(durationTargetMs / 15_000)));
  return [
    "You are a short-film story writer. Write the story for this idea as a beat sheet.",
    `Target runtime: about ${Math.round(durationTargetMs / 1000)} seconds, so roughly ${beats} beats.`,
    "Format EVERY beat exactly like this example, with no other headings:",
    "## BEAT: The lighthouse lamp dies",
    "NARRATOR: The storm swallows the light.",
    "MIRA: Hold on, old friend.",
    "",
    "Idea:",
    idea,
  ].join("\n");
}

/* ── Advance ───────────────────────────────────────────────────────────────── */

export interface AutoRunAdvanceDeps {
  /** Story stage only: the local text-engine chain provider (F1 pattern). */
  textProvider: TextProvider | null;
  /** Shot-plan service bound (maxShots etc. live in the route's existing options). */
  planOptions?: Parameters<typeof createShotPlan>[2];
}

/**
 * Advance one stage of a running run. Safe to call repeatedly and from any
 * process — every transition re-derives from stored state. Returns the updated
 * run; `state` transitions to `awaiting_review` whenever the next lane needs a
 * human decision, and to `completed` when assembly has a playable export.
 */
export async function advanceAutoRun(store: ProductionStore, runId: string, deps: AutoRunAdvanceDeps, options: AutoRunServiceOptions = {}): Promise<AutoRun> {
  const now = options.now ?? Date.now;
  let run = loadRun(store, runId);
  if (run.state === "awaiting_confirmation" || run.state === "canceled" || run.state === "completed") return run;

  const stage = (kind: AutoRunStageKind) => run.stages.find((entry) => entry.kind === kind)!;
  const nextPending = STAGE_ORDER.map((kind) => stage(kind)).find((entry) => entry.state === "pending" || entry.state === "queued" || entry.state === "running");
  if (!nextPending) {
    const completed: AutoRun = { ...run, state: "completed" };
    return store.transaction((tx) => persist(tx, completed, now()));
  }

  switch (nextPending.kind) {
    case "story": {
      const project = store.read.getProject(run.projectId);
      if (!project) fail("UNKNOWN_REFERENCE", "Project not found");
      if (project.activeStoryRevisionId) {
        run = setStage(run, "story", { state: "completed", targetId: project.activeStoryRevisionId, completedAt: now() });
        run = setStage(run, "storyboard", { state: "queued" });
        break;
      }
      if (!deps.textProvider || !isTextProvider(deps.textProvider)) {
        fail("CAPABILITY_MISMATCH", "No text engine is enabled for the story stage.", { action: "Enable a text engine in Settings → Providers (a free built-in works)." });
      }
      const provider = deps.textProvider;
      const model = provider.listTextModels()[0];
      const generated = await provider.generateText({ systemPrompt: "You write concise, visual short-film beat sheets.", userPrompt: autoStoryPrompt(run.idea, run.durationTargetMs), ...(model ? { modelId: model.id } : {}) });
      const draft = parseAutoStoryDraft(generated.text);
      const project2 = store.read.getProject(run.projectId)!;
      const revision = createStoryRevision(store, {
        projectId: run.projectId,
        expectedStoryRevisionId: project2.activeStoryRevisionId,
        scriptText: draft.scriptText,
        beats: draft.beats.map(({ order: _order, ...beat }) => beat),
        canonRevisionIds: project2.activeCanonRevisionIds,
      });
      run = setStage(run, "story", { state: "completed", targetId: revision.id, completedAt: now() });
      run = setStage(run, "storyboard", { state: "queued" });
      // Story approval is a human gate (zero auto-approvals, spec 14): park until
      // the creator approves the draft through the normal story UI.
      run = { ...run, state: "awaiting_review" };
      break;
    }
    case "storyboard": {
      const project = store.read.getProject(run.projectId);
      if (!project?.activeStoryRevisionId) fail("STALE_REVISION", "Storyboard stage reached with no active story revision");
      const story = store.read.getStoryRevision(project.activeStoryRevisionId);
      if (!story) fail("UNKNOWN_REFERENCE", "Active story revision is missing");
      const storyApproved = store.read.listApprovals("story", story.id).some((entry) => entry.targetHash === story.contentHash && entry.decision === "approved");
      if (!storyApproved) {
        // Not approved yet (or the draft changed since): keep the run parked and
        // name exactly what the creator needs to do.
        run = setStage(run, "storyboard", { state: "queued", error: null });
        run = { ...run, state: "awaiting_review" };
        break;
      }
      const activePins = project.activeCanonRevisionIds
        .map((id) => store.read.getCanonRevision(id))
        .filter((revision): revision is NonNullable<typeof revision> => revision !== null);
      const locationPin = activePins.find((revision) => revision.entityKind === "location");
      if (!locationPin) {
        fail("INVALID_INPUT", "The project has no pinned location canon, so the storyboard cannot hold the world steady.", { action: "Pin a location in the project's world, then advance the run again." });
      }
      const stylePin = activePins.find((revision) => revision.entityKind === "style");
      const fallbackPin = stylePin?.id ?? locationPin.id;
      const shots = story.beats.map((beat, index) => ({
        shotId: `shot-auto-${index + 1}`,
        beatIds: [beat.id],
        visualIntent: beat.action,
        motionIntent: "steady, held framing",
        castBindings: [],
        locationRevisionId: locationPin.id,
        propRevisionIds: [] as string[],
        styleRevisionId: fallbackPin,
        framing: "wide" as const,
        continuation: null,
        targetFrames: Math.max(24, Math.min(240, Math.round((run.durationTargetMs / Math.max(1, story.beats.length)) / 1000 * 24))),
      }));
      const plan = createShotPlan(store, {
        projectId: run.projectId,
        storyRevisionId: story.id,
        approvedStoryHash: story.contentHash,
        shots,
      }, deps.planOptions ?? { now: options.now ?? Date.now, idFactory: options.idFactory ?? randomUUID, maxShots: 10_000 });
      run = setStage(run, "storyboard", { state: "completed", targetId: plan.shotPlanRevision.id, completedAt: now() });
      run = { ...run, state: "awaiting_review" };
      run = setStage(run, "anchors", { state: "running", startedAt: now() });
      break;
    }
    case "anchors":
    case "takes": {
      // Observer stages: the creator runs the per-shot gated generations from
      // the storyboard deep link; the run tracks completion and never pays.
      const read = store.read;
      const projectNow = read.getProject(run.projectId);
      const animatic = projectNow?.activeAnimaticRevisionId ? read.getAnimaticRevision(projectNow.activeAnimaticRevisionId) : null;
      const shotRevisions = (animatic?.slots ?? [])
        .map((slot) => read.getShotRevision(slot.shotRevisionId))
        .filter((shot): shot is NonNullable<typeof shot> => shot !== null);
      if (nextPending.kind === "anchors") {
        const allApproved = shotRevisions.length > 0 && shotRevisions.every((shot) =>
          read.listAnchorsForShot(shot.id).some((candidate) =>
            read.listApprovals("anchor", candidate.id).some((entry) => entry.decision === "approved")));
        if (allApproved) {
          run = setStage(run, "anchors", { state: "completed", completedAt: now() });
          run = setStage(run, "takes", { state: "running", startedAt: now() });
        }
      } else {
        const allSelected = shotRevisions.length > 0 && shotRevisions.every((shot) => read.getSelectedTake(run.projectId, shot.id) !== null);
        if (allSelected) {
          run = setStage(run, "takes", { state: "completed", completedAt: now() });
          run = setStage(run, "audio", { state: "skipped", completedAt: now(), error: "Auto Draft skips audio generation (Full Auto, post-Alpha)." });
          run = setStage(run, "assembly", { state: "running", startedAt: now() });
          run = { ...run, state: "awaiting_review" };
        }
      }
      break;
    }
    case "audio":
      // Unreachable in Auto Draft (skipped by the takes transition); kept for Full Auto.
      run = setStage(run, "audio", { state: "skipped", completedAt: now() });
      break;
    case "assembly": {
      const exportsList = store.read.listProjectExports(run.projectId);
      const playable = exportsList.find((entry) => entry.status === "ready_for_review" || entry.status === "approved");
      if (playable) {
        run = setStage(run, "assembly", { state: "completed", targetId: playable.id, completedAt: now() });
        run = { ...run, state: "completed" };
      }
      break;
    }
  }
  return store.transaction((tx) => persist(tx, run, now()));
}

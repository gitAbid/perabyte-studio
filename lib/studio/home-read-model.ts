/**
 * Studio Home read models — THE single seam between the /studio screen and data.
 *
 * DATA WIRING (Wave 1, workspaces lane): the functions below now read the REAL
 * records through the production store read layer (the same read port the
 * /api/workspaces and /api/production routes use) and map them onto the UI view
 * models declared here. No UI code under app/studio changed.
 *
 * Rules honored here (feature spec 04, sections 7 and 9):
 * - Studio Home never issues provider/model calls of any kind.
 * - Shared contracts (docs/perabyte_studio_feature_specs/02_SHARED_CONTRACTS.md)
 *   are consumed, not redefined: the types below are UI view models mapped FROM
 *   the shared `Workspace` type and the production lifecycle projection.
 * - Every read degrades gracefully: if the store cannot be opened, Studio Home
 *   renders its teaching empty states instead of erroring the page.
 */

import { isEnvironmentKind, type ProductionJob } from "@/lib/production/contracts";
import { withProductionStore } from "@/lib/production/runtime";
import { listCharacters } from "@/lib/services/characters.service";
import { listLocations } from "@/lib/services/locations.service";

/** Row for the "Workspaces" section, derived from the shared `Workspace`. */
export type StudioWorkspaceSummary = {
  id: string;
  name: string;
  rating: "General" | "Mature" | "Adult";
  /** Epoch millis — matches the UtcMillis convention in lib/production/contracts.ts. */
  updatedAt: number;
};

/**
 * Coarse lifecycle state Studio Home is allowed to show. Fine-grained scene /
 * shot / take state stays inside the Production feature.
 */
export type StudioProductionStage =
  | "drafting"
  | "in_progress"
  | "first_cut_ready"
  | "needs_attention";

/** Row for the "Continue working" section, derived from the project summaries. */
export type StudioProductionSummary = {
  id: string;
  name: string;
  workspaceId: string | null;
  workspaceName: string | null;
  stage: StudioProductionStage;
  /** Epoch millis the production was last touched. */
  updatedAt: number;
  /**
   * One calm, human sentence for the status badge (spec 04 section 8: failed
   * jobs get ONE calm badge; provider detail stays in Diagnostics).
   */
  statusNote: string | null;
};

export type StudioOnboardingStepId =
  | "create_workspace"
  | "add_character"
  | "add_environment"
  | "start_production";

export type StudioOnboardingStep = {
  id: StudioOnboardingStepId;
  label: string;
  description: string;
  /** Where completing the step sends the creator. */
  href: string;
  done: boolean;
};

export type StudioOnboardingStatus = {
  /** True until the creator finishes (or skips) the guided steps. */
  firstRun: boolean;
  steps: StudioOnboardingStep[];
};

export type StudioHomeReadModel = {
  workspaces: StudioWorkspaceSummary[];
  recentProductions: StudioProductionSummary[];
  onboarding: StudioOnboardingStatus;
};

/** Home surfaces stay small: the most recent slice of each list. */
const HOME_WORKSPACE_LIMIT = 3;
const HOME_PRODUCTION_LIMIT = 12;
/** Job statuses that mean "the creator should look at this episode". */
const ATTENTION_JOB_STATUSES: ReadonlySet<ProductionJob["status"]> = new Set([
  "failed",
  "blocked",
  "submission_unknown",
]);

function logUnavailable(what: string, error: unknown): void {
  console.error(`studio home: ${what} unavailable; showing the empty state instead`, error);
}

/**
 * Workspaces most relevant to the creator, most recent first — real records
 * from the workspace store (shared `Workspace` contract), newest slice only.
 */
export async function listRecentWorkspaces(): Promise<StudioWorkspaceSummary[]> {
  try {
    const workspaces = await withProductionStore((store) => store.read.listWorkspaces());
    return workspaces
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1))
      .slice(0, HOME_WORKSPACE_LIMIT)
      .map((workspace) => ({ id: workspace.id, name: workspace.name, rating: workspace.rating, updatedAt: workspace.updatedAt }));
  } catch (error) {
    logUnavailable("the workspace list", error);
    return [];
  }
}

/** Coarse stage mapping: setup/canon/script drafting, mid-pipeline running, done ready. */
function deriveProductionStage(projectStage: string, needsAttention: boolean): StudioProductionStage {
  if (needsAttention) return "needs_attention";
  if (projectStage === "export" || projectStage === "complete") return "first_cut_ready";
  if (projectStage === "setup" || projectStage === "canon" || projectStage === "script") return "drafting";
  return "in_progress";
}

const STAGE_NOTE: Record<StudioProductionStage, string> = {
  drafting: "Taking shape — cast, places, and script.",
  in_progress: "Scenes are being made and approved.",
  first_cut_ready: "A cut is ready to watch.",
  needs_attention: "Something interrupted this episode. Open it to see what happened and retry.",
};

/** Ready-to-review entries outrank generic resume actions (spec 04 §8). */
const STAGE_RANK: Record<StudioProductionStage, number> = {
  first_cut_ready: 0,
  needs_attention: 0,
  in_progress: 1,
  drafting: 2,
};

/**
 * Recent productions with a lifecycle summary, most recent first, ready-to-review
 * entries ranked so "Review Episode" can outrank generic resume actions
 * (spec 04 acceptance test 2). Reads the same store the project list API uses;
 * failed/blocked jobs surface as one calm "needs attention" state per episode.
 */
export async function listRecentProductions(): Promise<StudioProductionSummary[]> {
  try {
    const rows = await withProductionStore((store) =>
      store.read.listProjects(null, HOME_PRODUCTION_LIMIT).projects.map((summary) => {
        const jobs = store.read.listProjectJobs(summary.id);
        const needsAttention = jobs.some((job) => ATTENTION_JOB_STATUSES.has(job.status));
        const workspaceId = store.read.getProject(summary.id)?.workspaceId ?? null;
        const workspaceName = workspaceId ? store.read.getWorkspace(workspaceId)?.name ?? null : null;
        return { summary, needsAttention, workspaceId, workspaceName };
      }),
    );
    return rows
      .map(({ summary, needsAttention, workspaceId, workspaceName }): StudioProductionSummary => {
        const stage = deriveProductionStage(summary.stage, needsAttention);
        return {
          id: summary.id,
          name: summary.name,
          workspaceId,
          workspaceName,
          stage,
          updatedAt: summary.updatedAt,
          statusNote: STAGE_NOTE[stage],
        };
      })
      .sort(
        (left, right) =>
          STAGE_RANK[left.stage] - STAGE_RANK[right.stage] ||
          right.updatedAt - left.updatedAt ||
          (left.id < right.id ? -1 : 1),
      );
  } catch (error) {
    logUnavailable("the production list", error);
    return [];
  }
}

/**
 * Character/environment canon signals for onboarding. Both sources count:
 * the saved libraries the /character and /environments screens show today, and
 * production canon characters/environments referenced by workspaces or pinned
 * by projects. When the canon studios fully replace the libraries, the library
 * reads here are the only lines to revisit.
 */
async function deriveCanonExists(): Promise<{ character: boolean; environment: boolean }> {
  let character = false;
  let environment = false;
  try {
    character = listCharacters().length > 0;
  } catch (error) {
    logUnavailable("the character library", error);
  }
  try {
    environment = listLocations().length > 0;
  } catch (error) {
    logUnavailable("the environment library", error);
  }
  if (character && environment) return { character, environment };
  try {
    const canon = await withProductionStore((store) => {
      let characterCanon = false;
      let environmentCanon = false;
      for (const workspace of store.read.listWorkspaces()) {
        if (workspace.characterCanonIds.length > 0) characterCanon = true;
        if (workspace.environmentCanonIds.length > 0) environmentCanon = true;
      }
      if (!characterCanon || !environmentCanon) {
        for (const summary of store.read.listProjects(null, 24).projects) {
          const project = store.read.getProject(summary.id);
          if (!project) continue;
          for (const revision of store.read.listCanonRevisions(project.activeCanonRevisionIds)) {
            if (revision.entityKind === "character") characterCanon = true;
            if (isEnvironmentKind(revision.entityKind)) environmentCanon = true;
          }
        }
      }
      return { characterCanon, environmentCanon };
    });
    return { character: character || canon.characterCanon, environment: environment || canon.environmentCanon };
  } catch (error) {
    logUnavailable("production canon", error);
    return { character, environment };
  }
}

/**
 * Guided first-run onboarding: which steps exist and which are done, derived
 * from real records — a workspace exists, a character exists, an environment
 * exists, a production was started. `firstRun` stays true until every step is
 * done (there is no skip store yet).
 */
export async function onboardingStatus(): Promise<StudioOnboardingStatus> {
  const [canonExists, hasWorkspace, hasProduction] = await Promise.all([
    deriveCanonExists(),
    (async (): Promise<boolean> => {
      try {
        const workspaces = await withProductionStore((store) => store.read.listWorkspaces());
        return workspaces.length > 0;
      } catch (error) {
        logUnavailable("the workspace list", error);
        return false;
      }
    })(),
    (async (): Promise<boolean> => {
      try {
        const page = await withProductionStore((store) => store.read.listProjects(null, 1));
        return page.projects.length > 0;
      } catch (error) {
        logUnavailable("the production list", error);
        return false;
      }
    })(),
  ]);

  const steps: StudioOnboardingStep[] = [
    {
      id: "create_workspace",
      label: "Create a workspace",
      description: "Give your show a home for its characters and places.",
      href: "/workspaces",
      done: hasWorkspace,
    },
    {
      id: "add_character",
      label: "Add a character",
      description: "PeraByte keeps their look consistent across every scene.",
      href: "/character",
      done: canonExists.character,
    },
    {
      id: "add_environment",
      label: "Add an environment",
      description: "Return to the same places in every episode.",
      href: "/environments",
      done: canonExists.environment,
    },
    {
      id: "start_production",
      label: "Start your first production",
      description: "One sentence of story becomes a first cut.",
      href: "/production/new",
      done: hasProduction,
    },
  ];

  return { firstRun: !steps.every((step) => step.done), steps };
}

/** Convenience loader: one await for the whole page. Used by app/studio/page.tsx. */
export async function loadStudioHome(): Promise<StudioHomeReadModel> {
  const [workspaces, recentProductions, onboarding] = await Promise.all([
    listRecentWorkspaces(),
    listRecentProductions(),
    onboardingStatus(),
  ]);
  return { workspaces, recentProductions, onboarding };
}

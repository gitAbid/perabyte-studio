import type {
  AnchorCandidate,
  Approval,
  AccountBudgetPolicy,
  AccountEvidence,
  Asset,
  AnimaticRevision,
  AudioMixRevision,
  BudgetAuthorization,
  BudgetExecution,
  BudgetQuote,
  BudgetReservation,
  CanonRevision,
  CapabilityReceipt,
  ExportRecord,
  HonoredInputsReceipt,
  JsonValue,
  MetricEvent,
  MoneyScope,
  ProductionJob,
  ProductionQuote,
  ProductionSnapshot,
  ProviderRequestSnapshot,
  Project,
  QuoteAccountBinding,
  ReconciliationEvidence,
  RenderManifest,
  AutoRun,
  Scene,
  ShotPlanRevision,
  ShotRevision,
  StoryRevision,
  Take,
  VisionAssessment,
  Workspace,
} from "../../production/contracts";
export type { ProviderRequestSnapshot } from "../../production/contracts";
import type { ProductionErrorCode } from "../../production/errors";
import type { ExecutionProofLink, ProofArtifact, ProviderCredentialGeneration, QuoteProofLink } from "../../production/provider-proof";

export type ProviderInputReference = ProviderRequestSnapshot["inputs"][number];

export type ProjectSummary = {
  id: string;
  name: string;
  profileId: string;
  updatedAt: number;
  stage: "setup" | "canon" | "script" | "shots" | "anchors" | "takes" | "audio" | "export" | "complete";
  saveVersion: number;
};

export interface ProjectListPage {
  projects: ProjectSummary[];
  nextCursor: string | null;
}

export type BudgetScope = MoneyScope;
export type LedgerScope = BudgetScope & ({ kind: "project"; projectId: string } | { kind: "account_day"; utcDay: string });
export interface StoredEvidence { sequence: number; evidence: ReconciliationEvidence; semanticHash: string }
export interface BudgetLedgerEntry { reservation: BudgetReservation; events: StoredEvidence[] }
export interface InsertOutcome<T> { record: T; created: boolean }

export interface BudgetReadPort {
  getAccountPolicyRevision(revisionId: string): AccountBudgetPolicy | null;
  getLatestAccountPolicy(scope: BudgetScope): AccountBudgetPolicy | null;
  getBudgetAuthorizationRevision(revisionId: string): BudgetAuthorization | null;
  getLatestBudgetAuthorization(projectId: string, policyId: string): BudgetAuthorization | null;
  getAccountEvidence(id: string): AccountEvidence | null;
  getLatestAccountEvidence(providerId: string, credentialBindingId: string): AccountEvidence | null;
  getBudgetQuote(id: string): BudgetQuote | null;
  getBudgetQuoteForMediaQuote(mediaQuoteId: string): BudgetQuote | null;
  getQuoteAccountBinding(budgetQuoteId: string): QuoteAccountBinding | null;
  getBudgetExecution(executionId: string): BudgetExecution | null;
  getBudgetReservation(id: string): BudgetReservation | null;
  getReservationByExecution(executionId: string): BudgetReservation | null;
  getReservationByIdempotency(projectId: string, idempotencyKey: string): BudgetReservation | null;
  getReconciliationEvent(providerId: string, accountId: string, eventKey: string): StoredEvidence | null;
  listBudgetLedger(scope: LedgerScope): BudgetLedgerEntry[];
}

export interface ProviderProofReadPort {
  getProofArtifact(hash: string): ProofArtifact | null;
  getProviderCredentialGeneration(providerId: string): ProviderCredentialGeneration | null;
  getQuoteProof(budgetQuoteId: string): QuoteProofLink | null;
  getExecutionProof(executionId: string): ExecutionProofLink | null;
}

export interface ProductionReadPort extends BudgetReadPort, ProviderProofReadPort {
  getProject(projectId: string): Project | null;
  listProjects(cursor: string | null, limit: number): ProjectListPage;
  getCanonRevision(revisionId: string): CanonRevision | null;
  getLatestCanonRevision(entityId: string): CanonRevision | null;
  getCanonRevisionByHash(entityId: string, contentHash: string): CanonRevision | null;
  listCanonRevisions(revisionIds: string[]): CanonRevision[];
  getStoryRevision(revisionId: string): StoryRevision | null;
  getShotRevision(revisionId: string): ShotRevision | null;
  getShotPlanRevision(revisionId: string): ShotPlanRevision | null;
  getAnimaticRevision(revisionId: string): AnimaticRevision | null;
  getAudioMixRevision(revisionId: string): AudioMixRevision | null;
  getAsset(assetId: string): Asset | null;
  getAnchor(anchorId: string): AnchorCandidate | null;
  getApproval(approvalId: string): Approval | null;
  listApprovals(targetKind: Approval["targetKind"], targetId: string): Approval[];
  getTake(takeId: string): Take | null;
  /** Returns the selected take and the project-global CAS version (null take, version 0 initially). */
  getTakeSelection(projectId: string, shotId: string): TakeSelection;
  getSelectedTake(projectId: string, shotId: string): Take | null;
  listTakesForShot(shotRevisionId: string): Take[];
  listAnchorsForShot(shotRevisionId: string): AnchorCandidate[];
  getManifest(manifestId: string): RenderManifest | null;
  getExport(exportId: string): ExportRecord | null;
  listProjectExports(projectId: string): ExportRecord[];
  getJob(jobId: string): ProductionJob | null;
  getJobByIdempotencyKey(projectId: string, idempotencyKey: string): ProductionJob | null;
  listProjectJobs(projectId: string): ProductionJob[];
  listJobEvents(jobId: string, afterSequence: number): JobEventRecord[];
  getCapabilityReceipt(providerId: string, modelId: string): CapabilityReceipt | null;
  getQuote(quoteId: string): ProductionQuote | null;
  getHonoredInputsReceipt(receiptId: string): HonoredInputsReceipt | null;
  getWorkspace(workspaceId: string): Workspace | null;
  getAutoRun(autoRunId: string): AutoRun | null;
  listAutoRuns(projectId: string): AutoRun[];
  listRunningAutoRuns(): AutoRun[];
  listWorkspaces(): Workspace[];
  getProductionSnapshot(snapshotId: string): ProductionSnapshot | null;
  listProductionSnapshots(projectId: string): ProductionSnapshot[];
  getScene(sceneId: string): Scene | null;
  /** Null-safe story revision match; a null storyRevisionId selects scenes not tied to a story revision. */
  listScenes(projectId: string, storyRevisionId: string | null): Scene[];
  listProjectScenes(projectId: string): Scene[];
  /** Product metric events (C19) for one project, ordered by event time then id. */
  listMetricEvents(projectId: string): MetricEvent[];
}

export interface JobEventRecord {
  jobId: string;
  sequence: number;
  at: number;
  status: ProductionJob["status"];
  message: string;
  progress: number | null;
}

export interface TakeSelection {
  takeId: string | null;
  /** Project-global version, monotonically incremented on every successful shot selection. */
  version: number;
}

export interface JobLease {
  jobId: string;
  leaseToken: string;
  leaseUntil: number;
  heartbeatAt: number;
}

export interface OutboxIntent {
  id: string;
  jobId: string;
  createdAt: number;
  claimedAt: number | null;
  claimToken: string | null;
}

export interface DurableMediaRecord {
  asset: Asset;
  verifiedAt: number;
  checksumVerified: true;
}

export interface BudgetWritePort extends BudgetReadPort {
  appendAccountPolicy(record: AccountBudgetPolicy, expectedRevision: number | null): boolean;
  appendBudgetAuthorization(record: BudgetAuthorization, expectedRevision: number | null): boolean;
  insertAccountEvidence(record: AccountEvidence): InsertOutcome<AccountEvidence>;
  insertBudgetQuote(record: BudgetQuote, binding: QuoteAccountBinding | null): InsertOutcome<BudgetQuote>;
  registerBudgetExecution(execution: BudgetExecution): InsertOutcome<BudgetExecution>;
  insertBudgetReservation(record: BudgetReservation): InsertOutcome<BudgetReservation>;
  appendReconciliationEvidence(evidence: ReconciliationEvidence): InsertOutcome<StoredEvidence>;
}

export interface ProviderProofWritePort extends ProviderProofReadPort {
  insertProofArtifact(record: ProofArtifact): InsertOutcome<ProofArtifact>;
  compareAndSetProviderCredentialGeneration(record: ProviderCredentialGeneration, expectedRevision: number | null): boolean;
  insertQuoteProof(record: QuoteProofLink): InsertOutcome<QuoteProofLink>;
  insertExecutionProof(record: ExecutionProofLink): InsertOutcome<ExecutionProofLink>;
}

export interface ProductionWritePort extends ProductionReadPort, BudgetWritePort, ProviderProofWritePort {
  insertProject(project: Project): void;
  compareAndSetProject(project: Project, expectedSaveVersion: number): boolean;
  insertCanonRevision(revision: CanonRevision): void;
  insertStoryRevision(revision: StoryRevision): void;
  insertShotRevisions(revisions: ShotRevision[]): void;
  insertShotPlanRevision(revision: ShotPlanRevision): void;
  insertAnimaticRevision(revision: AnimaticRevision): void;
  insertRevisionDependencies(revisionId: string, dependencyIds: string[]): void;
  listDependentRevisionIds(revisionId: string): string[];
  insertAudioMixRevision(revision: AudioMixRevision): void;
  insertAsset(record: DurableMediaRecord): void;
  insertAnchor(candidate: AnchorCandidate): void;
  appendApproval(approval: Approval): void;
  insertTake(take: Take): void;
  /** CAS against Project.takeSelectionVersion; success updates the selection and increments that global version atomically. */
  compareAndSetSelectedTake(projectId: string, shotId: string, takeId: string | null, expectedVersion: number): boolean;
  /** CAS against Project.audioMixVersion; success selects the immutable mix and increments its version atomically. */
  compareAndSetAudioMix(projectId: string, audioMixRevisionId: string, expectedVersion: number): boolean;
  insertManifest(manifest: RenderManifest): void;
  insertExport(exportRecord: ExportRecord): void;
  compareAndSetExport(exportRecord: ExportRecord, expectedStatus: ExportRecord["status"]): boolean;
  insertQuote(quote: ProductionQuote): void;
  insertCapabilityReceipt(receipt: CapabilityReceipt): void;
  insertHonoredInputsReceipt(receipt: HonoredInputsReceipt): void;
  insertWorkspace(workspace: Workspace): void;
  insertAutoRun(autoRun: AutoRun): void;
  compareAndSetAutoRun(autoRun: AutoRun, expectedSaveVersion: number): boolean;
  /** CAS against Workspace.saveVersion; mirrors Project CAS semantics for name/member/rating/recipe/world-bible edits. */
  compareAndSetWorkspace(workspace: Workspace, expectedSaveVersion: number): boolean;
  insertProductionSnapshot(snapshot: ProductionSnapshot): void;
  /** Idempotent by scene id; overwrites content columns while preserving the original createdAt. */
  upsertScene(scene: Scene): void;
  /** Appends one product metric event (C19); id is the primary key so duplicates throw and callers stay best-effort. */
  insertMetricEvent(event: MetricEvent): void;
  insertJob(job: ProductionJob, outboxIntent: OutboxIntent): void;
  /**
   * Inserts a durable unclaimed intent for an existing job only; returns false if that job already has one.
   * Call only during trusted explicit resolution of an unknown submission, in the same transaction that
   * persists its provider reference/receipt and reconciled job state. Never use to retry a paid submission.
   */
  ensureOutbox(intent: OutboxIntent): boolean;
  claimOutbox(now: number, claimToken: string, leaseUntil: number, limit: number): OutboxIntent[];
  claimJob(jobId: string, now: number, lease: JobLease): ProductionJob | null;
  heartbeatJob(jobId: string, leaseToken: string, heartbeatAt: number, leaseUntil: number): boolean;
  updateLeasedJob(job: ProductionJob, leaseToken: string): boolean;
  appendJobEvent(event: JobEventRecord): void;
  releaseOutbox(intentId: string, claimToken: string): boolean;
  /** Removes only the outbox intent held by the matching unexpired claim; job/history remain immutable. */
  acknowledgeOutbox(intentId: string, claimToken: string): boolean;
  /** Extends only the matching outbox claim while both caller and store clocks see it as live. */
  heartbeatOutbox(intentId: string, claimToken: string, now: number, leaseUntil: number): boolean;
  /** Compare-and-sets a nonterminal job to cancel_requested without changing its request/result/lease snapshot. */
  requestJobCancellation(jobId: string, expectedStatus: ProductionJob["status"], requestedAt: number): boolean;
}

export type SynchronousValue<T> = T extends PromiseLike<unknown> ? never : T;

/** A transaction callback must be synchronous; no provider or media I/O belongs inside it. */
export interface ProductionStore {
  read: ProductionReadPort;
  transaction<T>(work: (tx: ProductionWritePort) => SynchronousValue<T>): SynchronousValue<T>;
}

export interface ProviderSubmissionAck {
  providerRef: string;
  honoredInputs: HonoredInputsReceipt;
}

export interface ProviderMediaResult {
  providerRef: string;
  state: "running" | "completed" | "failed" | "canceled";
  temporaryUrl: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  frames: number | null;
  errorCode: ProductionErrorCode | null;
  errorMessage: string | null;
}

export interface ProviderPort {
  readonly providerId: string;
  discoverCapabilities(modelId: string): Promise<CapabilityReceipt>;
  quote(request: ProviderQuoteRequest): Promise<ProductionQuote>;
  submit(request: ProviderRequestSnapshot, capability: CapabilityReceipt): Promise<ProviderSubmissionAck>;
  poll(providerRef: string): Promise<ProviderMediaResult>;
  cancel(providerRef: string): Promise<void>;
}

export interface ProviderQuoteRequest {
  projectId: string;
  providerId: string;
  modelId: string;
  operation: ProductionQuote["operation"];
  inputSnapshot: { revisionIds: string[]; assetIds: string[]; parameters: Record<string, JsonValue> };
}

export interface ImageProviderPort extends ProviderPort {
  readonly capability: "image";
}

export interface VideoProviderPort extends ProviderPort {
  readonly capability: "video";
}

export interface SpeechProviderPort {
  readonly providerId: string;
  readonly capability: "speech";
  discoverCapabilities(modelId: string): Promise<CapabilityReceipt>;
  quote(request: ProviderQuoteRequest): Promise<ProductionQuote>;
  generateSpeech(request: ProviderRequestSnapshot, capability: CapabilityReceipt): Promise<ProviderSubmissionAck>;
  poll(providerRef: string): Promise<ProviderMediaResult>;
  cancel(providerRef: string): Promise<void>;
}

export interface MusicProviderPort {
  readonly providerId: string;
  readonly capability: "music";
  discoverCapabilities(modelId: string): Promise<CapabilityReceipt>;
  quote(request: ProviderQuoteRequest): Promise<ProductionQuote>;
  generateMusic(request: ProviderRequestSnapshot, capability: CapabilityReceipt): Promise<ProviderSubmissionAck>;
  poll(providerRef: string): Promise<ProviderMediaResult>;
  cancel(providerRef: string): Promise<void>;
}

export interface VisionProviderPort {
  readonly providerId: string;
  readonly capability: "vision";
  discoverCapabilities(modelId: string): Promise<CapabilityReceipt>;
  assess(request: ProviderRequestSnapshot): Promise<VisionAssessment>;
}

export interface AssemblyRequest {
  jobId: string;
  manifest: RenderManifest;
  signal?: AbortSignal;
}

export interface AssemblyResult {
  asset: DurableMediaRecord;
  qcReportId: string;
  qcPassed: boolean;
}

export interface AssemblyPort {
  compile(request: AssemblyRequest): Promise<AssemblyResult>;
}

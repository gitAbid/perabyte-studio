import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AccountBudgetPolicySchema, AccountEvidenceSchema, BudgetAuthorizationSchema,
  BudgetExecutionSchema, BudgetQuoteSchema, BudgetReservationSchema, JobSchema,
  MoneyScopeSchema, QuoteAccountBindingSchema, QuoteSchema, ReconciliationEvidenceSchema,
} from "../../production/contracts";
import type {
  AccountBudgetPolicy, AccountEvidence, AnchorCandidate, Approval, Asset, AnimaticRevision,
  AudioMixRevision, BudgetAuthorization, BudgetExecution, BudgetQuote, BudgetReservation,
  CapabilityReceipt, CanonRevision, ExportRecord, HonoredInputsReceipt, MoneyScope, ProductionJob,
  ProductionQuote, Project, QuoteAccountBinding, ReconciliationEvidence, RenderManifest,
  ShotPlanRevision, ShotRevision, StoryRevision, Take,
} from "../../production/contracts";
import { canonicalJson, hashCanonicalJson } from "../../production/hash";
import {
  ExecutionProofLinkSchema, ProofArtifactSchema, ProviderCredentialGenerationSchema,
  QuoteProofLinkSchema, proofPayload,
} from "../../production/provider-proof";
import type { ExecutionProofLink, ProofArtifact, ProviderCredentialGeneration, QuoteProofLink } from "../../production/provider-proof";
import { foldReservation, utcBudgetDay } from "../../production/budget";
import { IdSchema } from "../../production/contracts";
import type {
  BudgetLedgerEntry, BudgetScope, DurableMediaRecord, InsertOutcome, JobEventRecord,
  JobLease, LedgerScope, OutboxIntent, ProductionReadPort, ProductionStore,
  ProductionWritePort, ProjectListPage, ProjectSummary, StoredEvidence, TakeSelection,
} from "./ports";

type Kind = "canon" | "story" | "shot" | "shotPlan" | "animatic" | "audioMix" | "asset" | "anchor" | "approval" | "take" | "manifest" | "export" | "job" | "quote" | "capability" | "honoredInputs";
const REVISION_KINDS = new Set<Kind>(["canon", "story", "shot", "shotPlan", "animatic", "audioMix"]);
type RecordValue = CanonRevision | StoryRevision | ShotRevision | ShotPlanRevision | AnimaticRevision | AudioMixRevision | Asset | AnchorCandidate | Approval | Take | RenderManifest | ExportRecord | ProductionJob | ProductionQuote | CapabilityReceipt | HonoredInputsReceipt;
const migrations = [
  { version: 1, name: "001.sql", sql: readFileSync(new URL("./migrations/001.sql", import.meta.url), "utf8") },
  { version: 2, name: "002-budget.sql", sql: readFileSync(new URL("./migrations/002-budget.sql", import.meta.url), "utf8") },
  { version: 3, name: "003-approval-commands.sql", sql: readFileSync(new URL("./migrations/003-approval-commands.sql", import.meta.url), "utf8") },
  { version: 4, name: "004-provider-proof.sql", sql: readFileSync(new URL("./migrations/004-provider-proof.sql", import.meta.url), "utf8") },
];
const json = <T>(value: string | null | undefined): T | null => value == null ? null : JSON.parse(value) as T;
const toJson = (value: unknown) => JSON.stringify(value);
const STARTUP_BUSY_TIMEOUT_MS = 250;
const STARTUP_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;
const STARTUP_BUSY_DEADLINE_MS = 1800;
const STARTUP_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isSqliteBusy(error: unknown): boolean {
  const code=(error as {code?:unknown}|null)?.code;
  return typeof code==="string"&&code.startsWith("SQLITE_BUSY");
}

function withStartupBusyRetry<T>(operation:()=>T,deadline:number,stage:string):T {
  let attempt=0;
  while(true) {
    try { return operation(); }
    catch(error) {
      if(!isSqliteBusy(error)) throw error;
      const remaining=deadline-performance.now();
      if(attempt>=STARTUP_BUSY_RETRY_DELAYS_MS.length||remaining<=0) {
        throw new Error(`SQLite ${stage} remained busy after bounded startup retries`,{cause:error});
      }
      const delay=Math.min(STARTUP_BUSY_RETRY_DELAYS_MS[attempt],remaining);
      if(delay>0) Atomics.wait(STARTUP_WAIT,0,0,delay);
      attempt+=1;
    }
  }
}

export interface SqliteProductionStore extends ProductionStore { close(): void; integrityCheck(): { ok: boolean; messages: string[] }; schemaVersion(): number; pragmas(): { journalMode: string; foreignKeys: number; synchronous: number; busyTimeout: number }; }
export interface SqliteStoreOptions { dataDir?: string; dbPath?: string; now?: () => number; }

export function openProductionStore(options: SqliteStoreOptions = {}): SqliteProductionStore {
  const dbPath = resolve(options.dbPath ?? `${options.dataDir ?? ".studio"}/production.sqlite`);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath, { timeout: STARTUP_BUSY_TIMEOUT_MS });
  const storeNow = options.now ?? Date.now;
  try {
    const startupDeadline=performance.now()+STARTUP_BUSY_DEADLINE_MS;
    db.pragma(`busy_timeout = ${STARTUP_BUSY_TIMEOUT_MS}`);
    withStartupBusyRetry(()=>{
      const mode=db.pragma("journal_mode = WAL",{simple:true});
      if(mode!=="wal") throw new Error(`SQLite WAL mode was not enabled (got ${String(mode)})`);
    },startupDeadline,"WAL setup");
    db.pragma("foreign_keys = ON"); db.pragma("synchronous = FULL");
    const migrate = db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      const applied = db.prepare("SELECT version,name FROM schema_migrations ORDER BY version").all() as {version:number;name:string}[];
      for (let index = 0; index < applied.length; index += 1) {
        const expected = migrations[index];
        if (!expected || applied[index].version !== expected.version || applied[index].name !== expected.name) {
          throw new Error(`Invalid production schema migration history at version ${applied[index].version}`);
        }
      }
      for (const migration of migrations.slice(applied.length)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(migration.version, migration.name, storeNow());
      }
    });
    withStartupBusyRetry(()=>migrate.immediate(),startupDeadline,"migration startup");
  } catch (error) {
    db.close();
    throw error;
  }
  const recordInsert = db.prepare("INSERT INTO records(kind,id,project_id,natural_key,payload) VALUES(?,?,?,?,?)");
  const recordGet = db.prepare("SELECT payload FROM records WHERE kind=? AND id=?");
  const insert = (kind: Kind, value: RecordValue, projectId: string | null = null, naturalKey: string | null = null, idOverride?: string) => recordInsert.run(kind, idOverride ?? ("id" in value ? value.id : `${value.providerId}:${value.modelId}`), projectId, naturalKey, toJson(value));
  const get = <T>(kind: Kind, id: string): T | null => json<T>((recordGet.get(kind, id) as { payload: string } | undefined)?.payload);
  const list = <T>(kind: Kind, where = "", args: unknown[] = []): T[] => (db.prepare(`SELECT payload FROM records WHERE kind=? ${where} ORDER BY id`).all(kind, ...args) as { payload: string }[]).map(row => JSON.parse(row.payload) as T);
  const decodeBudget = <T>(payload: string | null | undefined, parser: {parse(value: unknown): T}): T | null => payload == null ? null : parser.parse(JSON.parse(payload));
  const readPolicyRevision = (revisionId: string): AccountBudgetPolicy | null => decodeBudget((db.prepare("SELECT payload FROM budget_policy_revisions WHERE revision_id=?").get(revisionId) as {payload:string}|undefined)?.payload, AccountBudgetPolicySchema);
  const readAuthorizationRevision = (revisionId: string): BudgetAuthorization | null => decodeBudget((db.prepare("SELECT payload FROM budget_authorization_revisions WHERE revision_id=?").get(revisionId) as {payload:string}|undefined)?.payload, BudgetAuthorizationSchema);
  const readBudgetQuote = (id: string): BudgetQuote | null => decodeBudget((db.prepare("SELECT payload FROM budget_quotes WHERE id=?").get(id) as {payload:string}|undefined)?.payload, BudgetQuoteSchema);
  const readBinding = (quoteId: string): QuoteAccountBinding | null => decodeBudget((db.prepare("SELECT payload FROM budget_quote_bindings WHERE budget_quote_id=?").get(quoteId) as {payload:string}|undefined)?.payload, QuoteAccountBindingSchema);
  const readEvidence = (id: string): AccountEvidence | null => decodeBudget((db.prepare("SELECT payload FROM budget_account_evidence WHERE id=?").get(id) as {payload:string}|undefined)?.payload, AccountEvidenceSchema);
  const readExecution = (id: string): BudgetExecution | null => decodeBudget((db.prepare("SELECT payload FROM budget_executions WHERE execution_id=?").get(id) as {payload:string}|undefined)?.payload, BudgetExecutionSchema);
  const readReservation = (id: string): BudgetReservation | null => decodeBudget((db.prepare("SELECT payload FROM budget_reservations WHERE id=?").get(id) as {payload:string}|undefined)?.payload, BudgetReservationSchema);
  const readProofArtifact = (hash: string): ProofArtifact | null => {
    const row=db.prepare("SELECT hash,kind,canonical_payload AS canonicalPayload,created_at AS createdAt FROM provider_proof_artifacts WHERE hash=?").get(hash) as {hash:string;kind:string;canonicalPayload:string;createdAt:number}|undefined;
    if (!row) return null;
    try { const artifact=ProofArtifactSchema.parse({schemaVersion:1,hash:row.hash,canonicalPayload:row.canonicalPayload,createdAt:row.createdAt});if(proofPayload(artifact).kind!==row.kind) throw new Error();return artifact; }
    catch { throw new Error("Stored provider proof failed integrity validation"); }
  };
  const readCredentialGeneration = (providerId: string): ProviderCredentialGeneration | null => {
    const row=db.prepare("SELECT g.provider_id AS providerId,g.revision,g.generation_id AS generationId,g.account_id AS accountId,g.credential_fingerprint AS credentialFingerprint,g.changed_at AS changedAt FROM provider_credential_heads h JOIN provider_credential_generations g ON g.provider_id=h.provider_id AND g.revision=h.revision AND g.generation_id=h.generation_id WHERE h.provider_id=?").get(providerId) as Record<string,unknown>|undefined;
    if (!row) return null;
    try { return ProviderCredentialGenerationSchema.parse({schemaVersion:1,...row}); } catch { throw new Error("Stored provider credential generation failed integrity validation"); }
  };
  const validateQuoteProof = (candidate: QuoteProofLink): QuoteProofLink => {
    let link:QuoteProofLink;try{link=QuoteProofLinkSchema.parse(candidate);}catch{throw new Error("Provider quote proof link is invalid");}
    const artifact=readProofArtifact(link.artifactHash);
    if (!artifact) throw new Error("Provider quote proof artifact is missing");
    const payload=proofPayload(artifact);
    if (payload.kind!=="media_quote") throw new Error("Provider quote proof artifact has the wrong kind");
    const budgetQuote=readBudgetQuote(link.budgetQuoteId),binding=readBinding(link.budgetQuoteId),evidence=readEvidence(payload.accountEvidence.id);
    const mediaQuote=decodeBudget((db.prepare("SELECT payload FROM records WHERE kind='quote' AND id=?").get(link.mediaQuoteId) as {payload:string}|undefined)?.payload,QuoteSchema);
    const accountArtifact=readProofArtifact(payload.accountProofHash),policyArtifact=readProofArtifact(payload.policyProofHash);
    if (!budgetQuote||!binding||!evidence||!mediaQuote||!accountArtifact||!policyArtifact||accountArtifact.hash!==payload.accountProofHash||policyArtifact.hash!==payload.policyProofHash) throw new Error("Provider quote proof references are incomplete");
    const accountPayload=proofPayload(accountArtifact),policyPayload=proofPayload(policyArtifact);
    if (accountPayload.kind!=="account_session"||policyPayload.kind!=="reviewed_policy") throw new Error("Provider quote proof references the wrong artifact kind");
    if (link.mediaQuoteId!==payload.mediaQuote.id||link.mediaQuoteId!==mediaQuote.id||canonicalJson(mediaQuote)!==canonicalJson(payload.mediaQuote)||canonicalJson(budgetQuote)!==canonicalJson(payload.budgetQuote)||canonicalJson(binding)!==canonicalJson(payload.binding)||canonicalJson(evidence)!==canonicalJson(payload.accountEvidence)||payload.budgetQuote.id!==link.budgetQuoteId||payload.budgetQuote.mediaQuoteId!==link.mediaQuoteId||payload.accountEvidence.reference!==`sha256:${payload.accountProofHash}`||accountPayload.generation.providerId!==payload.mediaQuote.providerId||accountPayload.generation.accountId!==evidence.accountId||accountPayload.generation.generationId!==payload.accountEvidence.credentialBindingId||accountPayload.generation.generationId!==payload.binding.credentialBindingId||canonicalJson(accountPayload.session)!==canonicalJson(payload.session)||accountPayload.observedAt>payload.createdAt||payload.createdAt>=accountPayload.expiresAt||policyPayload.providerId!==payload.mediaQuote.providerId||payload.createdAt<policyPayload.capturedAt||payload.expiresAt>policyPayload.expiresAt||payload.expiresAt>accountPayload.expiresAt) throw new Error("Provider quote proof does not match its immutable finance and account records");
    return link;
  };
  const validateExecutionProof = (candidate: ExecutionProofLink): ExecutionProofLink => {
    let link:ExecutionProofLink;try{link=ExecutionProofLinkSchema.parse(candidate);}catch{throw new Error("Provider execution proof link is invalid");}
    const artifact=readProofArtifact(link.artifactHash);
    if (!artifact) throw new Error("Provider execution proof artifact is missing");
    const payload=proofPayload(artifact);
    if (payload.kind!=="execution_session") throw new Error("Provider execution proof artifact has the wrong kind");
    const execution=readExecution(link.executionId),reservation=readReservation(link.reservationId),job=get<ProductionJob>("job",link.executionId);
    const quoteLinkRow=db.prepare("SELECT budget_quote_id AS budgetQuoteId FROM provider_quote_proofs WHERE media_quote_id=?").get(payload.mediaQuoteId) as {budgetQuoteId:string}|undefined;
    if (!execution||!reservation||!job||!quoteLinkRow) throw new Error("Provider execution proof references are incomplete");
    const quoteLink=readQuoteProofByBudget(quoteLinkRow.budgetQuoteId),quoteArtifact=quoteLink?readProofArtifact(quoteLink.artifactHash):null;
    const accountArtifact=readProofArtifact(payload.accountProofHash);
    if (!quoteLink||!quoteArtifact||!accountArtifact||payload.execution.kind!=="media_job"||canonicalJson(execution)!==canonicalJson(payload.execution)||canonicalJson(reservation.execution)!==canonicalJson(execution)||reservation.execution.executionId!==link.executionId||reservation.id!==link.reservationId||reservation.execution.kind!=="media_job"||reservation.budgetQuoteId!==payload.budgetQuoteId||reservation.quoteBindingId!==payload.quoteBindingId||reservation.accountEvidenceId!==payload.accountEvidenceId||payload.quoteProofHash!==quoteLink.artifactHash||payload.accountEvidenceId!==reservation.accountEvidenceId||payload.execution.executionSemanticHash!==reservation.execution.executionSemanticHash||job.requestHash!==payload.execution.requestHash||hashCanonicalJson(job.requestSnapshot)!==job.requestHash) throw new Error("Provider execution proof does not match its immutable execution and reservation");
    const snapshot=job.requestSnapshot as {resultTarget?:{inputsHash?:unknown}};
    if (!snapshot.resultTarget||snapshot.resultTarget.inputsHash!==payload.execution.executionSemanticHash) throw new Error("Provider execution semantic binding is invalid");
    const quotePayload=proofPayload(quoteArtifact),workerPayload=proofPayload(accountArtifact);
    if (quotePayload.kind!=="media_quote"||workerPayload.kind!=="account_session"||workerPayload.session.role!=="worker"||canonicalJson(workerPayload.generation)!==canonicalJson(payload.generation)||canonicalJson(workerPayload.session)!==canonicalJson(payload.session)||workerPayload.observedAt>payload.observedAt||payload.observedAt>=workerPayload.expiresAt||workerPayload.generation.providerId!==reservation.providerId||workerPayload.generation.accountId!==reservation.accountId||workerPayload.generation.generationId!==reservation.credentialBindingId||quotePayload.mediaQuote.id!==payload.mediaQuoteId||quotePayload.budgetQuote.id!==payload.budgetQuoteId||quotePayload.binding.id!==payload.quoteBindingId||quotePayload.accountEvidence.id!==payload.accountEvidenceId||quotePayload.executionSemanticHash!==payload.execution.executionSemanticHash||canonicalJson(quotePayload.capability)!==canonicalJson(payload.capability)||payload.expiresAt>quotePayload.expiresAt||payload.expiresAt>quotePayload.budgetQuote.expiresAt||payload.expiresAt>quotePayload.capability.expiresAt!) throw new Error("Provider execution proof does not match its quote, worker session, or capability");
    return link;
  };
  const readQuoteProofByBudget = (budgetQuoteId: string): QuoteProofLink | null => {
    const row=db.prepare("SELECT budget_quote_id AS budgetQuoteId,media_quote_id AS mediaQuoteId,artifact_hash AS artifactHash FROM provider_quote_proofs WHERE budget_quote_id=?").get(budgetQuoteId) as {budgetQuoteId:string;mediaQuoteId:string;artifactHash:string}|undefined;
    return row?validateQuoteProof({schemaVersion:1,...row}):null;
  };
  const readExecutionProofById = (executionId: string): ExecutionProofLink | null => {
    const row=db.prepare("SELECT execution_id AS executionId,reservation_id AS reservationId,artifact_hash AS artifactHash FROM provider_execution_proofs WHERE execution_id=?").get(executionId) as {executionId:string;reservationId:string;artifactHash:string}|undefined;
    return row?validateExecutionProof({schemaVersion:1,...row}):null;
  };
  const readStoredEvidence = (sequence: number, evidence: ReconciliationEvidence, semanticHash: string): StoredEvidence => ({ sequence, evidence, semanticHash });
  const eventsForReservation = (reservationId: string): StoredEvidence[] => (db.prepare("SELECT sequence,payload,semantic_hash AS semanticHash FROM budget_reconciliation_events WHERE reservation_id=? ORDER BY sequence").all(reservationId) as {sequence:number;payload:string;semanticHash:string}[]).map(row => readStoredEvidence(row.sequence,ReconciliationEvidenceSchema.parse(JSON.parse(row.payload)),row.semanticHash));
  const readLedger = (scopeValue: LedgerScope): BudgetLedgerEntry[] => {
    const scope = MoneyScopeSchema.parse({providerId:scopeValue.providerId,accountId:scopeValue.accountId,currency:scopeValue.currency,unit:scopeValue.unit});
    if (scopeValue.kind === "project") IdSchema.parse(scopeValue.projectId);
    else if (scopeValue.kind === "account_day") {
      const stamp = Date.parse(`${scopeValue.utcDay}T00:00:00.000Z`);
      if (!Number.isFinite(stamp) || utcBudgetDay(stamp) !== scopeValue.utcDay) throw new TypeError("Invalid UTC day scope");
    } else throw new TypeError("Invalid budget ledger scope");
    const clauses = ["provider_id=?", "account_id=?", "currency_key=?", "unit=?"];
    const args: unknown[] = [scope.providerId,scope.accountId,scope.currency ?? "",scope.unit];
    if (scopeValue.kind === "project") { clauses.push("project_id=?"); args.push(scopeValue.projectId); }
    else { clauses.push("utc_day=?"); args.push(scopeValue.utcDay); }
    const rows = db.prepare(`SELECT id,payload FROM budget_reservations WHERE ${clauses.join(" AND ")} ORDER BY reserved_at,id`).all(...args) as {id:string;payload:string}[];
    return rows.map(row => ({reservation:BudgetReservationSchema.parse(JSON.parse(row.payload)),events:eventsForReservation(row.id)}));
  };
  let savepointCounter=0;
  const atomicBudgetWrite = <T>(work:()=>T):T => {
    const name=`budget_write_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result=work();db.exec(`RELEASE ${name}`);return result; }
    catch(error) { db.exec(`ROLLBACK TO ${name}`);db.exec(`RELEASE ${name}`);throw error; }
  };
  const ref = db.prepare("INSERT INTO record_refs(owner_kind,owner_id,role,ordinal,target_kind,target_id) VALUES(?,?,?,?,?,?)");
  const refsFor = (ownerKind: Kind, ownerId: string, role: string, targetKind: Kind, ids: string[]) => ids.forEach((id, ordinal) => ref.run(ownerKind, ownerId, role, ordinal, targetKind, id));
  const syncProjectRefs = (p: Project) => {
    db.prepare("DELETE FROM project_refs WHERE project_id=?").run(p.id);
    const add = db.prepare("INSERT INTO project_refs(project_id,role,ordinal,target_kind,target_id) VALUES(?,?,?,?,?)");
    p.activeCanonRevisionIds.forEach((id, ordinal) => add.run(p.id, "canon", ordinal, "canon", id));
    for (const [role, kind, id] of [["story", "story", p.activeStoryRevisionId], ["shotPlan", "shotPlan", p.activeShotPlanRevisionId], ["animatic", "animatic", p.activeAnimaticRevisionId], ["audioMix", "audioMix", p.activeAudioMixRevisionId]] as const) {
      if (id) add.run(p.id, role, 0, kind, id);
    }
  };
  const kindForApproval: Record<Approval["targetKind"], Kind> = { story: "story", canon: "canon", shotplan: "shotPlan", animatic: "animatic", anchor: "anchor", take: "take", audio: "audioMix", final: "export" };
  const replaceJobReferences = (job: ProductionJob) => {
    db.prepare("DELETE FROM record_refs WHERE owner_kind='job' AND owner_id=?").run(job.id);
    if (job.quoteId) refsFor("job", job.id, "quote", "quote", [job.quoteId]);
    if (job.receiptId) {
      const kind = (db.prepare("SELECT kind FROM records WHERE id=? LIMIT 1").get(job.receiptId) as { kind: Kind } | undefined)?.kind;
      if (!kind) throw new Error(`Unknown job receipt: ${job.receiptId}`);
      refsFor("job", job.id, "receipt", kind, [job.receiptId]);
    }
    if (job.resultId) {
      const kind = (db.prepare("SELECT kind FROM records WHERE id=? LIMIT 1").get(job.resultId) as { kind: Kind } | undefined)?.kind;
      if (!kind) throw new Error(`Unknown job result: ${job.resultId}`);
      refsFor("job", job.id, "result", kind, [job.resultId]);
    }
    refsFor("job", job.id, "resultAsset", "asset", job.resultAssetIds);
  };

  const read: ProductionReadPort = {
    getAccountPolicyRevision: readPolicyRevision,
    getLatestAccountPolicy: (scopeValue: BudgetScope) => {
      const scope=MoneyScopeSchema.parse(scopeValue);
      const row=db.prepare("SELECT revision_id FROM budget_policy_revisions r JOIN budget_policies p USING(policy_id) WHERE p.provider_id=? AND p.account_id=? AND p.currency_key=? AND p.unit=? AND r.revision=p.head_revision")
        .get(scope.providerId,scope.accountId,scope.currency ?? "",scope.unit) as {revision_id:string}|undefined;
      return row ? readPolicyRevision(row.revision_id) : null;
    },
    getBudgetAuthorizationRevision: readAuthorizationRevision,
    getLatestBudgetAuthorization: (projectId,policyId) => {
      const row=db.prepare("SELECT revision_id FROM budget_authorization_revisions r JOIN budget_authorizations a USING(authorization_id) WHERE a.project_id=? AND a.policy_id=? AND r.revision=a.head_revision")
        .get(projectId,policyId) as {revision_id:string}|undefined;
      return row ? readAuthorizationRevision(row.revision_id) : null;
    },
    getAccountEvidence: readEvidence,
    getLatestAccountEvidence: (providerId,credentialBindingId) => {
      const row=db.prepare("SELECT id FROM budget_account_evidence WHERE provider_id=? AND credential_binding_id=? ORDER BY observed_at DESC,id DESC LIMIT 1").get(providerId,credentialBindingId) as {id:string}|undefined;
      return row ? readEvidence(row.id) : null;
    },
    getBudgetQuote: readBudgetQuote,
    getBudgetQuoteForMediaQuote: mediaQuoteId => {
      const row=db.prepare("SELECT id FROM budget_quotes WHERE media_quote_id=?").get(mediaQuoteId) as {id:string}|undefined;
      return row ? readBudgetQuote(row.id) : null;
    },
    getQuoteAccountBinding: readBinding,
    getBudgetExecution: readExecution,
    getProofArtifact: readProofArtifact,
    getProviderCredentialGeneration: readCredentialGeneration,
    getQuoteProof: readQuoteProofByBudget,
    getExecutionProof: readExecutionProofById,
    getBudgetReservation: readReservation,
    getReservationByExecution: executionId => {
      const row=db.prepare("SELECT id FROM budget_reservations WHERE execution_id=?").get(executionId) as {id:string}|undefined;
      return row ? readReservation(row.id) : null;
    },
    getReservationByIdempotency: (projectId,idempotencyKey) => {
      const row=db.prepare("SELECT id FROM budget_reservations WHERE project_id=? AND idempotency_key=?").get(projectId,idempotencyKey) as {id:string}|undefined;
      return row ? readReservation(row.id) : null;
    },
    getReconciliationEvent: (providerId,accountId,eventKey) => {
      const row=db.prepare("SELECT sequence,payload,semantic_hash AS semanticHash FROM budget_reconciliation_events WHERE provider_id=? AND account_id=? AND event_key=?")
        .get(providerId,accountId,eventKey) as {sequence:number;payload:string;semanticHash:string}|undefined;
      return row ? readStoredEvidence(row.sequence,ReconciliationEvidenceSchema.parse(JSON.parse(row.payload)),row.semanticHash) : null;
    },
    listBudgetLedger: readLedger,
    getProject: id => json<Project>((db.prepare("SELECT payload FROM projects WHERE id=?").get(id) as {payload:string}|undefined)?.payload),
    listProjects(cursor, limit): ProjectListPage {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) throw new RangeError("limit must be between 1 and 24");
      let after: { updatedAt: number; id: string } | null = null;
      if (cursor) { try { const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {updatedAt:number;id:string}; if (!Number.isSafeInteger(v.updatedAt) || typeof v.id !== "string") throw new Error(); after = v; } catch { throw new TypeError("Invalid project cursor"); } }
      const rows = db.prepare(`SELECT id,name,profile_id AS profileId,updated_at AS updatedAt,save_version AS saveVersion,payload FROM projects ${after ? "WHERE updated_at < ? OR (updated_at = ? AND id > ?)" : ""} ORDER BY updated_at DESC,id ASC LIMIT ?`).all(...(after ? [after.updatedAt, after.updatedAt, after.id, limit + 1] : [limit + 1])) as (ProjectSummary & {payload:string})[];
      const projects = rows.slice(0, limit).map(row => { const p = JSON.parse(row.payload) as Project; return { id: p.id, name: p.name, profileId: p.profileId, updatedAt: p.updatedAt, saveVersion: p.saveVersion, stage: p.activeAudioMixRevisionId ? "audio" : p.activeShotPlanRevisionId ? "shots" : p.activeStoryRevisionId ? "script" : p.activeCanonRevisionIds.length ? "canon" : "setup" } as ProjectSummary; });
      const last = rows.length > limit ? projects.at(-1) : undefined;
      return { projects, nextCursor: last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString("base64url") : null };
    },
    getCanonRevision: id => get("canon", id),
    getLatestCanonRevision: entityId => json<CanonRevision>((db.prepare("SELECT payload FROM records WHERE kind='canon' AND json_extract(payload,'$.entityId')=? ORDER BY json_extract(payload,'$.revision') DESC LIMIT 1").get(entityId) as {payload:string}|undefined)?.payload),
    getCanonRevisionByHash: (entityId, contentHash) => json<CanonRevision>((db.prepare("SELECT payload FROM records WHERE kind='canon' AND natural_key=? LIMIT 1").get(`${entityId}:${contentHash}`) as {payload:string}|undefined)?.payload),
    listCanonRevisions: ids => ids.map(id => get<CanonRevision>("canon", id)).filter((v): v is CanonRevision => v !== null),
    getStoryRevision: id => get("story", id), getShotRevision: id => get("shot", id), getShotPlanRevision: id => get("shotPlan", id), getAnimaticRevision: id => get("animatic", id), getAudioMixRevision: id => get("audioMix", id),
    getAsset: id => get("asset", id), getAnchor: id => get("anchor", id), getApproval: id => get("approval", id),
    listApprovals: (targetKind, targetId) => list("approval", "AND json_extract(payload,'$.targetKind')=? AND json_extract(payload,'$.targetId')=?", [targetKind, targetId]),
    getTake: id => get("take", id),
    getTakeSelection(projectId, shotId): TakeSelection { const p = read.getProject(projectId); if (!p) return { takeId: null, version: 0 }; const row = db.prepare("SELECT take_id AS takeId FROM take_selections WHERE project_id=? AND shot_id=?").get(projectId, shotId) as {takeId:string|null}|undefined; return { takeId: row?.takeId ?? null, version: p.takeSelectionVersion }; },
    getSelectedTake: (projectId, shotId) => { const selection = read.getTakeSelection(projectId, shotId); return selection.takeId ? get("take", selection.takeId) : null; },
    listTakesForShot: id => list("take", "AND json_extract(payload,'$.shotRevisionId')=?", [id]), listAnchorsForShot: id => list("anchor", "AND json_extract(payload,'$.shotRevisionId')=?", [id]),
    getManifest: id => get("manifest", id), getExport: id => get("export", id), listProjectExports: id => list("export", "AND project_id=?", [id]),
    getJob: id => get("job", id), getJobByIdempotencyKey: (projectId, key) => get("job", (db.prepare("SELECT id FROM records WHERE kind='job' AND project_id=? AND natural_key=?").get(projectId, key) as {id:string}|undefined)?.id ?? ""),
    listProjectJobs: id => list("job", "AND project_id=?", [id]),
    listJobEvents: (jobId, after) => db.prepare("SELECT job_id AS jobId,sequence,at,status,message,progress FROM job_events WHERE job_id=? AND sequence>? ORDER BY sequence").all(jobId, after) as JobEventRecord[],
    getCapabilityReceipt: (providerId, modelId) => get("capability", `${providerId}:${modelId}`), getQuote: id => get("quote", id), getHonoredInputsReceipt: id => get("honoredInputs", id),
  };
  const writes: ProductionWritePort = {
    ...read,
    insertProofArtifact: value => atomicBudgetWrite(() => {
      let record:ProofArtifact;try{record=ProofArtifactSchema.parse(value);}catch{throw new Error("Provider proof artifact is invalid");}
      const payload=proofPayload(record),previous=readProofArtifact(record.hash);
      if(previous){if(canonicalJson(previous)!==canonicalJson(record))throw new Error("Conflicting immutable provider proof artifact");return {record:previous,created:false};}
      db.prepare("INSERT INTO provider_proof_artifacts(hash,kind,canonical_payload,created_at) VALUES(?,?,?,?)").run(record.hash,payload.kind,record.canonicalPayload,record.createdAt);
      return {record,created:true};
    }),
    compareAndSetProviderCredentialGeneration: (value, expectedRevision) => atomicBudgetWrite(() => {
      let record:ProviderCredentialGeneration;try{record=ProviderCredentialGenerationSchema.parse(value);}catch{throw new Error("Provider credential generation is invalid");}
      const current=readCredentialGeneration(record.providerId);
      if(current&&record.revision===current.revision&&canonicalJson(current)===canonicalJson(record))return expectedRevision===(current.revision===1?null:current.revision-1);
      if((current?.revision??null)!==expectedRevision)return false;
      if(!current){if(expectedRevision!==null||record.revision!==1) return false;}
      else if(record.revision!==current.revision+1||record.generationId===current.generationId||record.changedAt<current.changedAt||(record.accountId===current.accountId&&record.credentialFingerprint===current.credentialFingerprint))return false;
      db.prepare("INSERT INTO provider_credential_generations(provider_id,revision,generation_id,account_id,credential_fingerprint,changed_at) VALUES(?,?,?,?,?,?)").run(record.providerId,record.revision,record.generationId,record.accountId,record.credentialFingerprint,record.changedAt);
      if(current){const changed=db.prepare("UPDATE provider_credential_heads SET revision=?,generation_id=? WHERE provider_id=? AND revision=?").run(record.revision,record.generationId,record.providerId,current.revision).changes;if(changed!==1)throw new Error("Provider credential generation compare-and-set failed");}
      else db.prepare("INSERT INTO provider_credential_heads(provider_id,revision,generation_id) VALUES(?,?,?)").run(record.providerId,record.revision,record.generationId);
      return true;
    }),
    insertQuoteProof: value => atomicBudgetWrite(() => {
      const record=validateQuoteProof(value),previous=readQuoteProofByBudget(record.budgetQuoteId);
      if(previous){if(canonicalJson(previous)!==canonicalJson(record))throw new Error("Conflicting immutable provider quote proof link");return {record:previous,created:false};}
      db.prepare("INSERT INTO provider_quote_proofs(budget_quote_id,media_quote_kind,media_quote_id,artifact_hash) VALUES(?,?,?,?)").run(record.budgetQuoteId,"quote",record.mediaQuoteId,record.artifactHash);
      return {record,created:true};
    }),
    insertExecutionProof: value => atomicBudgetWrite(() => {
      const record=validateExecutionProof(value),previous=readExecutionProofById(record.executionId);
      if(previous){if(canonicalJson(previous)!==canonicalJson(record))throw new Error("Conflicting immutable provider execution proof link");return {record:previous,created:false};}
      db.prepare("INSERT INTO provider_execution_proofs(execution_id,reservation_id,artifact_hash) VALUES(?,?,?)").run(record.executionId,record.reservationId,record.artifactHash);
      return {record,created:true};
    }),
    appendAccountPolicy: (value, expectedRevision) => atomicBudgetWrite(() => {
      const record=AccountBudgetPolicySchema.parse(value);
      if (expectedRevision!==null && (!Number.isSafeInteger(expectedRevision)||expectedRevision<1)) throw new TypeError("Expected policy revision must be a positive safe integer or null");
      const headById=db.prepare("SELECT provider_id,account_id,currency,unit,head_revision FROM budget_policies WHERE policy_id=?").get(record.policyId) as {provider_id:string;account_id:string;currency:string|null;unit:string;head_revision:number}|undefined;
      const scopeHead=db.prepare("SELECT policy_id,head_revision FROM budget_policies WHERE provider_id=? AND account_id=? AND currency_key=? AND unit=?").get(record.providerId,record.accountId,record.currency??"",record.unit) as {policy_id:string;head_revision:number}|undefined;
      if (scopeHead && scopeHead.policy_id!==record.policyId) throw new Error("An account policy already owns this provider/account/unit/currency scope");
      if (headById && (headById.provider_id!==record.providerId||headById.account_id!==record.accountId||headById.currency!==record.currency||headById.unit!==record.unit)) throw new Error("Account policy scope is immutable");
      const current=headById?.head_revision ?? 0;
      if (current!==(expectedRevision??0)) return false;
      if (record.revision!==current+1) throw new Error("Account policy revision must increment the current revision by one");
      if (current===Number.MAX_SAFE_INTEGER) throw new RangeError("Account policy revision exceeds safe integer range");
      if (!headById) db.prepare("INSERT INTO budget_policies(policy_id,provider_id,account_id,currency,currency_key,unit,head_revision) VALUES(?,?,?,?,?,?,0)").run(record.policyId,record.providerId,record.accountId,record.currency,record.currency??"",record.unit);
      db.prepare("INSERT INTO budget_policy_revisions(revision_id,policy_id,revision,payload) VALUES(?,?,?,?)").run(record.revisionId,record.policyId,record.revision,toJson(record));
      const changed=db.prepare("UPDATE budget_policies SET head_revision=? WHERE policy_id=? AND head_revision=?").run(record.revision,record.policyId,current).changes;
      if (changed!==1) throw new Error("Account policy head changed during compare-and-append");
      return true;
    }),
    appendBudgetAuthorization: (value, expectedRevision) => atomicBudgetWrite(() => {
      const record=BudgetAuthorizationSchema.parse(value);
      if (expectedRevision!==null && (!Number.isSafeInteger(expectedRevision)||expectedRevision<1)) throw new TypeError("Expected authorization revision must be a positive safe integer or null");
      if (!read.getProject(record.projectId)) throw new Error(`Unknown authorization project: ${record.projectId}`);
      const policyRevision=readPolicyRevision(record.policyRevisionIdAtAuthorization);
      if (!policyRevision || policyRevision.policyId!==record.policyId) throw new Error("Authorization policy provenance does not match its policy scope");
      const headById=db.prepare("SELECT project_id,policy_id,head_revision FROM budget_authorizations WHERE authorization_id=?").get(record.authorizationId) as {project_id:string;policy_id:string;head_revision:number}|undefined;
      const scopeHead=db.prepare("SELECT authorization_id,head_revision FROM budget_authorizations WHERE project_id=? AND policy_id=?").get(record.projectId,record.policyId) as {authorization_id:string;head_revision:number}|undefined;
      if (scopeHead && scopeHead.authorization_id!==record.authorizationId) throw new Error("Authorization identity is immutable for a project policy scope");
      if (headById && (headById.project_id!==record.projectId||headById.policy_id!==record.policyId)) throw new Error("Authorization project and policy scope are immutable");
      const current=headById?.head_revision ?? 0;
      if (current!==(expectedRevision??0)) return false;
      if (record.revision!==current+1) throw new Error("Authorization revision must increment the current revision by one");
      if (current===Number.MAX_SAFE_INTEGER) throw new RangeError("Authorization revision exceeds safe integer range");
      if (!headById) db.prepare("INSERT INTO budget_authorizations(authorization_id,project_id,policy_id,head_revision) VALUES(?,?,?,0)").run(record.authorizationId,record.projectId,record.policyId);
      db.prepare("INSERT INTO budget_authorization_revisions(revision_id,authorization_id,revision,policy_revision_id,payload) VALUES(?,?,?,?,?)").run(record.revisionId,record.authorizationId,record.revision,record.policyRevisionIdAtAuthorization,toJson(record));
      const changed=db.prepare("UPDATE budget_authorizations SET head_revision=? WHERE authorization_id=? AND head_revision=?").run(record.revision,record.authorizationId,current).changes;
      if (changed!==1) throw new Error("Authorization head changed during compare-and-append");
      return true;
    }),
    insertAccountEvidence: value => {
      const record=AccountEvidenceSchema.parse(value),previous=readEvidence(record.id);
      if (previous) { if (canonicalJson(previous)!==canonicalJson(record)) throw new Error(`Conflicting immutable account evidence: ${record.id}`);return {record:previous,created:false}; }
      db.prepare("INSERT INTO budget_account_evidence(id,provider_id,account_id,credential_binding_id,observed_at,expires_at,payload) VALUES(?,?,?,?,?,?,?)").run(record.id,record.providerId,record.accountId,record.credentialBindingId,record.observedAt,record.expiresAt,toJson(record));
      return {record,created:true};
    },
    insertBudgetQuote: (value, bindingValue) => atomicBudgetWrite(() => {
      const record=BudgetQuoteSchema.parse(value),binding=bindingValue===null?null:QuoteAccountBindingSchema.parse(bindingValue);
      if (!read.getProject(record.projectId)) throw new Error(`Unknown budget quote project: ${record.projectId}`);
      if (record.mediaQuoteId!==null) {
        const mediaQuote=decodeBudget((db.prepare("SELECT payload FROM records WHERE kind='quote' AND id=?").get(record.mediaQuoteId) as {payload:string}|undefined)?.payload,{parse:(x)=>x as ProductionQuote});
        if (!mediaQuote || mediaQuote.projectId!==record.projectId || mediaQuote.providerId!==record.providerId || mediaQuote.modelId!==record.modelId || mediaQuote.operation!==record.operation || mediaQuote.inputHash!==record.inputHash) throw new Error("Budget quote does not match its immutable media quote");
      }
      if (binding) {
        const accountEvidence=readEvidence(binding.accountEvidenceId);
        if (binding.budgetQuoteId!==record.id || binding.providerId!==record.providerId || !accountEvidence || binding.providerId!==accountEvidence.providerId || binding.accountId!==accountEvidence.accountId || binding.credentialBindingId!==accountEvidence.credentialBindingId || binding.currency!==record.currency || binding.unit!==record.unit || binding.quotedAt<record.createdAt || binding.quotedAt<accountEvidence.observedAt || binding.quotedAt>=accountEvidence.expiresAt || record.expiresAt<=binding.quotedAt) throw new Error("Quote account binding does not match quote and account evidence");
      }
      const previous=readBudgetQuote(record.id);
      if (previous) {
        const oldBinding=readBinding(record.id);
        if (canonicalJson(previous)!==canonicalJson(record) || canonicalJson(oldBinding)!==canonicalJson(binding)) throw new Error(`Conflicting immutable budget quote: ${record.id}`);
        return {record:previous,created:false};
      }
      if (binding && readBinding(record.id)) throw new Error("Quote binding already exists for a different budget quote");
      db.prepare("INSERT INTO budget_quotes(id,project_id,media_quote_id,payload) VALUES(?,?,?,?)").run(record.id,record.projectId,record.mediaQuoteId,toJson(record));
      if (binding) db.prepare("INSERT INTO budget_quote_bindings(id,budget_quote_id,account_evidence_id,provider_id,account_id,credential_binding_id,currency,currency_key,unit,execution_semantic_hash,quoted_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(binding.id,binding.budgetQuoteId,binding.accountEvidenceId,binding.providerId,binding.accountId,binding.credentialBindingId,binding.currency,binding.currency??"",binding.unit,binding.executionSemanticHash,binding.quotedAt,toJson(binding));
      return {record,created:true};
    }),
    registerBudgetExecution: value => atomicBudgetWrite(() => {
      const record=BudgetExecutionSchema.parse(value);
      if (!read.getProject(record.projectId)) throw new Error(`Unknown budget execution project: ${record.projectId}`);
      const previous=readExecution(record.executionId);
      if (previous) { if (canonicalJson(previous)!==canonicalJson(record)) throw new Error(`Conflicting immutable budget execution: ${record.executionId}`);return {record:previous,created:false}; }
      const keyConflict=db.prepare("SELECT execution_id,payload FROM budget_executions WHERE project_id=? AND idempotency_key=?").get(record.projectId,record.idempotencyKey) as {execution_id:string;payload:string}|undefined;
      if (keyConflict) throw new Error("Budget execution idempotency key is already registered");
      if (record.kind==="media_job") {
        const job=decodeBudget((db.prepare("SELECT payload FROM records WHERE kind='job' AND id=?").get(record.executionId) as {payload:string}|undefined)?.payload,JobSchema);
        if (!job || job.projectId!==record.projectId || job.idempotencyKey!==record.idempotencyKey || job.requestHash!==record.requestHash || job.operation!==record.operation || job.providerId!==record.providerId || job.modelId!==record.modelId) throw new Error("Media budget execution must match its existing production job");
      }
      db.prepare("INSERT INTO budget_executions(execution_id,project_id,idempotency_key,kind,media_job_id,payload) VALUES(?,?,?,?,?,?)").run(record.executionId,record.projectId,record.idempotencyKey,record.kind,record.kind==="media_job"?record.executionId:null,toJson(record));
      return {record,created:true};
    }),
    insertBudgetReservation: value => atomicBudgetWrite(() => {
      const record=BudgetReservationSchema.parse(value),executionRecord=readExecution(record.execution.executionId);
      const oldById=readReservation(record.id),oldByExecution=read.getReservationByExecution(record.execution.executionId),oldByKey=read.getReservationByIdempotency(record.execution.projectId,record.execution.idempotencyKey);
      const existing=oldById??oldByExecution??oldByKey;
      if (existing) { if (canonicalJson(existing)!==canonicalJson(record) || [oldById,oldByExecution,oldByKey].some(item=>item!==null&&item!==undefined&&item.id!==record.id)) throw new Error("Conflicting immutable budget reservation or execution idempotency key");return {record:existing,created:false}; }
      if (!executionRecord || canonicalJson(executionRecord)!==canonicalJson(record.execution)) throw new Error("Reservation execution is not registered with identical immutable fields");
      const policy=readPolicyRevision(record.policyRevisionId),authorizationRecord=readAuthorizationRevision(record.authorizationRevisionId),quote=readBudgetQuote(record.budgetQuoteId),quoteBinding=readBinding(record.budgetQuoteId),accountEvidence=readEvidence(record.accountEvidenceId);
      const latestPolicy=read.getLatestAccountPolicy({providerId:record.providerId,accountId:record.accountId,currency:record.currency,unit:record.unit});
      const latestAuthorization=authorizationRecord?read.getLatestBudgetAuthorization(record.execution.projectId,authorizationRecord.policyId):null;
      if (!policy || !authorizationRecord || !quote || !quoteBinding || !accountEvidence || !latestPolicy || !latestAuthorization) throw new Error("Reservation pins must reference existing policy, authorization, quote, binding, and account evidence");
      const mediaQuote=quote.mediaQuoteId===null?null:read.getQuote(quote.mediaQuoteId);
      const policyScopeMatches=policy.providerId===record.providerId&&policy.accountId===record.accountId&&policy.currency===record.currency&&policy.unit===record.unit;
      const evidenceMatches=accountEvidence.id===record.accountEvidenceId&&accountEvidence.providerId===record.providerId&&accountEvidence.accountId===record.accountId&&accountEvidence.credentialBindingId===record.credentialBindingId;
      const authorizationPolicyProvenance=readPolicyRevision(authorizationRecord.policyRevisionIdAtAuthorization);
      const authorizationMatches=authorizationRecord.projectId===record.execution.projectId&&authorizationRecord.policyId===policy.policyId&&authorizationPolicyProvenance?.policyId===policy.policyId&&latestAuthorization.revisionId===authorizationRecord.revisionId;
      const quoteMatches=quote.projectId===record.execution.projectId&&quote.providerId===record.execution.providerId&&quote.modelId===record.execution.modelId&&quote.operation===record.execution.operation&&quote.unit===record.unit&&quote.currency===record.currency&&quote.estimateMax!==null&&quote.estimateMax===record.upperEstimate&&quote.entitlement!=="unknown";
      const bindingMatches=quoteBinding.id===record.quoteBindingId&&quoteBinding.budgetQuoteId===quote.id&&quoteBinding.accountEvidenceId===accountEvidence.id&&quoteBinding.providerId===record.providerId&&quoteBinding.accountId===record.accountId&&quoteBinding.credentialBindingId===record.credentialBindingId&&quoteBinding.currency===record.currency&&quoteBinding.unit===record.unit&&quoteBinding.executionSemanticHash===record.execution.executionSemanticHash;
      const mediaMatches=record.execution.kind==="text_proposal"?quote.mediaQuoteId===null:!!mediaQuote&&mediaQuote.id===quote.mediaQuoteId&&mediaQuote.projectId===record.execution.projectId&&mediaQuote.providerId===record.execution.providerId&&mediaQuote.modelId===record.execution.modelId&&mediaQuote.operation===record.execution.operation;
      const timingMatches=policy.createdAt<=record.reservedAt&&(policy.expiresAt===null||policy.expiresAt>record.reservedAt)&&authorizationRecord.createdAt<=record.reservedAt&&(authorizationRecord.expiresAt===null||authorizationRecord.expiresAt>record.reservedAt)&&accountEvidence.observedAt<=record.reservedAt&&record.reservedAt<accountEvidence.expiresAt&&quote.createdAt<=quoteBinding.quotedAt&&quoteBinding.quotedAt<=record.reservedAt&&record.reservedAt<quote.expiresAt;
      const currentPins=latestPolicy.revisionId===policy.revisionId&&latestPolicy.policyId===policy.policyId;
      const authorizationScope=authorizationRecord.allowedModelIds.includes(record.execution.modelId)&&authorizationRecord.allowedOperations.includes(record.execution.operation)&&quote.entitlement!=="unknown"&&authorizationRecord.entitlementModes.includes(quote.entitlement);
      if (!policyScopeMatches||!evidenceMatches||!authorizationMatches||!quoteMatches||!bindingMatches||!mediaMatches||!timingMatches||!currentPins||!authorizationScope||policy.revoked||authorizationRecord.revoked||quote.unit==="unknown") throw new Error("Reservation pins or current policy authorization are inconsistent");
      db.prepare("INSERT INTO budget_reservations(id,execution_id,project_id,idempotency_key,policy_revision_id,authorization_revision_id,budget_quote_id,quote_binding_id,account_evidence_id,provider_id,account_id,credential_binding_id,currency,currency_key,unit,utc_day,reserved_at,upper_estimate,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(record.id,record.execution.executionId,record.execution.projectId,record.execution.idempotencyKey,record.policyRevisionId,record.authorizationRevisionId,record.budgetQuoteId,record.quoteBindingId,record.accountEvidenceId,record.providerId,record.accountId,record.credentialBindingId,record.currency,record.currency??"",record.unit,record.utcDay,record.reservedAt,record.upperEstimate,toJson(record));
      return {record,created:true};
    }),
    appendReconciliationEvidence: value => atomicBudgetWrite(() => {
      const event=ReconciliationEvidenceSchema.parse(value),semanticHash=hashCanonicalJson(event);
      const previous=read.getReconciliationEvent(event.providerId,event.accountId,event.eventKey);
      if (previous) { if (previous.semanticHash!==semanticHash||canonicalJson(previous.evidence)!==canonicalJson(event)) throw new Error("Conflicting reconciliation event key");return {record:previous,created:false}; }
      const reservationRecord=readReservation(event.reservationId);
      if (!reservationRecord||reservationRecord.providerId!==event.providerId||reservationRecord.accountId!==event.accountId||reservationRecord.currency!==event.currency||reservationRecord.unit!==event.unit) throw new Error("Reconciliation event scope does not match reservation pins");
      const storedEvents=eventsForReservation(event.reservationId).map(item=>item.evidence);
      foldReservation(reservationRecord,[...storedEvents,event]);
      const next=(db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM budget_reconciliation_events").get() as {sequence:number}).sequence;
      if (!Number.isSafeInteger(next)) throw new RangeError("Reconciliation event sequence exceeds safe integer range");
      db.prepare("INSERT INTO budget_reconciliation_events(sequence,reservation_id,provider_id,account_id,event_key,semantic_hash,payload) VALUES(?,?,?,?,?,?,?)").run(next,event.reservationId,event.providerId,event.accountId,event.eventKey,semanticHash,toJson(event));
      return {record:readStoredEvidence(next,event,semanticHash),created:true};
    }),
    insertProject: p => {
      db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)").run(p.id, p.name, p.profileId, p.updatedAt, p.saveVersion, p.takeSelectionVersion, p.audioMixVersion, p.activeAudioMixRevisionId, toJson(p));
      syncProjectRefs(p);
    },
    compareAndSetProject: (p, expected) => {
      const changed = db.prepare("UPDATE projects SET name=?,profile_id=?,updated_at=?,save_version=?,take_selection_version=?,audio_mix_version=?,selected_audio_mix_id=?,payload=? WHERE id=? AND save_version=? AND take_selection_version=? AND audio_mix_version=?")
        .run(p.name, p.profileId, p.updatedAt, p.saveVersion, p.takeSelectionVersion, p.audioMixVersion, p.activeAudioMixRevisionId, toJson(p), p.id, expected, p.takeSelectionVersion, p.audioMixVersion).changes === 1;
      if (changed) syncProjectRefs(p);
      return changed;
    },
    insertCanonRevision: r => { insert("canon", r, null, `${r.entityId}:${r.contentHash}`); refsFor("canon", r.id, "asset", "asset", r.referenceAssetIds); },
    insertStoryRevision: r => { insert("story", r, r.projectId, `${r.projectId}:${r.contentHash}`); refsFor("story", r.id, "canon", "canon", r.canonRevisionIds); if (r.parentRevisionId) refsFor("story", r.id, "parent", "story", [r.parentRevisionId]); },
    insertShotRevisions: rs => rs.forEach(r => {
      insert("shot", r);
      refsFor("shot", r.id, "story", "story", [r.storyRevisionId]);
      refsFor("shot", r.id, "canon", "canon", [...r.castBindings.map(x=>x.canonRevisionId), r.locationRevisionId, r.styleRevisionId, ...r.propRevisionIds]);
      if (r.continuation) {
        refsFor("shot", r.id, "previousShot", "shot", [r.continuation.previousShotRevisionId]);
        refsFor("shot", r.id, "endFrame", "asset", [r.continuation.endFrameAssetId]);
      }
    }),
    insertShotPlanRevision: r => { insert("shotPlan", r, r.projectId, `${r.projectId}:${r.contentHash}`); refsFor("shotPlan",r.id,"story","story",[r.storyRevisionId]); refsFor("shotPlan",r.id,"shot","shot",r.orderedShotRevisionIds); },
    insertAnimaticRevision: r => { insert("animatic", r, r.projectId, `${r.projectId}:${r.contentHash}`); refsFor("animatic", r.id, "shotPlan", "shotPlan", [r.shotPlanRevisionId]); refsFor("animatic", r.id, "shot", "shot", r.slots.map(x => x.shotRevisionId)); refsFor("animatic", r.id, "anchor", "anchor", r.slots.flatMap(x => x.anchorId ? [x.anchorId] : [])); },
    insertRevisionDependencies: (id, ids) => {
      const owner = (db.prepare("SELECT kind FROM records WHERE id=?").get(id) as {kind:Kind}|undefined)?.kind;
      if (!owner || !REVISION_KINDS.has(owner)) throw new Error(`Unknown dependency owner revision: ${id}`);
      ids.forEach((target, ordinal) => {
        const kind = (db.prepare("SELECT kind FROM records WHERE id=?").get(target) as {kind:Kind}|undefined)?.kind;
        if (!kind || (!REVISION_KINDS.has(kind) && kind !== "asset")) throw new Error(`Unknown dependency revision or asset: ${target}`);
        ref.run(owner, id, "dependency", ordinal, kind, target);
      });
    },
    listDependentRevisionIds: id => (db.prepare("SELECT DISTINCT owner_id FROM record_refs WHERE target_id=? AND role='dependency' ORDER BY owner_id").all(id) as {owner_id:string}[]).map(x=>x.owner_id),
    insertAudioMixRevision: r => { insert("audioMix",r,r.projectId,`${r.projectId}:${r.contentHash}`); refsFor("audioMix",r.id,"story","story",[r.storyRevisionId]); refsFor("audioMix",r.id,"asset","asset",r.cues.map(x=>x.assetId)); const cue=db.prepare("INSERT INTO audio_cues(mix_id,ordinal,asset_id,payload) VALUES(?,?,?,?)"); r.cues.forEach((v,i)=>cue.run(r.id,i,v.assetId,toJson(v))); },
    insertAsset: (r: DurableMediaRecord) => { insert("asset",r.asset); db.prepare("INSERT INTO assets(asset_id,sha256,mime,byte_size,source_job_id) VALUES(?,?,?,?,?)").run(r.asset.id,r.asset.sha256,r.asset.mime,r.asset.byteSize,r.asset.sourceJobId); if(r.asset.sourceJobId) refsFor("asset",r.asset.id,"job","job",[r.asset.sourceJobId]); },
    insertAnchor: r => {
      insert("anchor", r);
      refsFor("anchor", r.id, "asset", "asset", [r.assetId]);
      refsFor("anchor", r.id, "shot", "shot", [r.shotRevisionId]);
      refsFor("anchor", r.id, "job", "job", [r.jobId]);
      if (r.receiptId) refsFor("anchor", r.id, "receipt", "honoredInputs", [r.receiptId]);
    },
    appendApproval: r => {
      const targetKind = kindForApproval[r.targetKind];
      insert("approval", r, null, r.id);
      db.prepare("INSERT INTO approvals(approval_id,target_kind,target_id,target_record_kind,target_record_id,target_hash,decision) VALUES(?,?,?,?,?,?,?)")
        .run(r.id, r.targetKind, r.targetId, targetKind, r.targetId, r.targetHash, r.decision);
      refsFor("approval", r.id, "target", targetKind, [r.targetId]);
    },
    insertTake: r => {
      insert("take", r);
      db.prepare("INSERT INTO takes(take_id,shot_revision_id,anchor_id,approval_id,job_id,asset_id,inputs_hash) VALUES(?,?,?,?,?,?,?)")
        .run(r.id, r.shotRevisionId, r.anchorId, r.approvalId, r.jobId, r.assetId, r.inputsHash);
      refsFor("take", r.id, "shot", "shot", [r.shotRevisionId]);
      refsFor("take", r.id, "anchor", "anchor", [r.anchorId]);
      refsFor("take", r.id, "approval", "approval", [r.approvalId]);
      refsFor("take", r.id, "asset", "asset", [r.assetId]);
      refsFor("take", r.id, "job", "job", [r.jobId]);
      refsFor("take", r.id, "receipt", "honoredInputs", [r.receiptId]);
    },
    compareAndSetSelectedTake: (projectId, shotId, takeId, expected) => { const changed = db.prepare("UPDATE projects SET take_selection_version=take_selection_version+1, payload=json_set(payload,'$.takeSelectionVersion',take_selection_version+1) WHERE id=? AND take_selection_version=?").run(projectId,expected).changes; if (!changed) return false; db.prepare("INSERT INTO take_selections(project_id,shot_id,take_id) VALUES(?,?,?) ON CONFLICT(project_id,shot_id) DO UPDATE SET take_id=excluded.take_id").run(projectId,shotId,takeId); return true; },
    compareAndSetAudioMix: (projectId, audioMixRevisionId, expected) => {
      const changed = db.prepare("UPDATE projects SET audio_mix_version=audio_mix_version+1, selected_audio_mix_id=?, payload=json_set(payload,'$.audioMixVersion',audio_mix_version+1,'$.activeAudioMixRevisionId',?) WHERE id=? AND audio_mix_version=? AND EXISTS(SELECT 1 FROM records WHERE kind='audioMix' AND id=? AND project_id=?)")
        .run(audioMixRevisionId, audioMixRevisionId, projectId, expected, audioMixRevisionId, projectId).changes === 1;
      if (!changed) return false;
      db.prepare("DELETE FROM project_refs WHERE project_id=? AND role='audioMix'").run(projectId);
      db.prepare("INSERT INTO project_refs(project_id,role,ordinal,target_kind,target_id) VALUES(?,'audioMix',0,'audioMix',?)")
        .run(projectId, audioMixRevisionId);
      return true;
    },
    insertManifest: r => {
      insert("manifest", r, r.projectId);
      db.prepare("INSERT INTO manifests(manifest_id,project_id,inputs_hash) VALUES(?,?,?)").run(r.id, r.projectId, r.inputsHash);
      refsFor("manifest", r.id, "story", "story", [r.storyRevisionId]);
      refsFor("manifest", r.id, "shotPlan", "shotPlan", [r.shotPlanRevisionId]);
      refsFor("manifest", r.id, "animatic", "animatic", [r.animaticRevisionId]);
      refsFor("manifest", r.id, "take", "take", r.shots.map(x => x.takeId));
      refsFor("manifest", r.id, "asset", "asset", [...r.shots.map(x => x.assetId), ...r.audioCues.map(x => x.assetId)]);
      if (r.audioMixRevisionId) refsFor("manifest", r.id, "audioMix", "audioMix", [r.audioMixRevisionId]);
    },
    insertExport: r => { const projectId=(db.prepare("SELECT project_id AS id FROM records WHERE kind='manifest' AND id=?").get(r.manifestId) as {id:string}|undefined)?.id ?? null; insert("export",r,projectId); refsFor("export",r.id,"manifest","manifest",[r.manifestId]); },
    compareAndSetExport: (r, status) => db.prepare("UPDATE records SET payload=? WHERE kind='export' AND id=? AND json_extract(payload,'$.status')=?").run(toJson(r),r.id,status).changes === 1,
    insertQuote: r => insert("quote",r,r.projectId), insertCapabilityReceipt: r => { const id=`${r.providerId}:${r.modelId}`; const old=get<CapabilityReceipt>("capability",id); if(old) { if(r.observedAt<=old.observedAt) throw new Error("Capability receipt must be newer than the stored observation"); db.prepare("UPDATE records SET payload=? WHERE kind='capability' AND id=?").run(toJson(r),id); } else insert("capability",r,null,id,id); }, insertHonoredInputsReceipt: r => { insert("honoredInputs",r); refsFor("honoredInputs",r.id,"job","job",[r.jobId]); },
    insertJob: (j, o) => {
      insert("job", j, j.projectId, j.idempotencyKey);
      db.prepare("INSERT INTO jobs(job_id,project_id,idempotency_key,status,provider_ref,request_hash) VALUES(?,?,?,?,?,?)")
        .run(j.id, j.projectId, j.idempotencyKey, j.status, j.providerRef, j.requestHash);
      db.prepare("INSERT INTO outbox(id,job_id,created_at) VALUES(?,?,?)").run(o.id, o.jobId, o.createdAt);
      replaceJobReferences(j);
    },
    ensureOutbox: intent => {
      if (!IdSchema.safeParse(intent.id).success || !IdSchema.safeParse(intent.jobId).success ||
          !Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0 ||
          intent.claimedAt !== null || intent.claimToken !== null) {
        throw new TypeError("A valid unclaimed outbox intent is required");
      }
      return db.prepare(`INSERT INTO outbox(id,job_id,created_at)
        SELECT ?,?,? WHERE EXISTS(
          SELECT 1 FROM jobs j JOIN records r ON r.kind='job' AND r.id=j.job_id WHERE j.job_id=?
        ) AND NOT EXISTS(SELECT 1 FROM outbox WHERE job_id=?)
        ON CONFLICT DO NOTHING`).run(intent.id, intent.jobId, intent.createdAt, intent.jobId, intent.jobId).changes === 1;
    },
    claimOutbox: (now, token, leaseUntil, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be 1..100");
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseUntil) || leaseUntil <= now || !token) throw new TypeError("A valid time and future outbox lease token are required");
      const rows = db.prepare("SELECT id,job_id AS jobId,created_at AS createdAt FROM outbox WHERE claim_until IS NULL OR claim_until<=? ORDER BY created_at,id LIMIT ?")
        .all(now, limit) as { id: string; jobId: string; createdAt: number }[];
      const update = db.prepare("UPDATE outbox SET claimed_at=?,claim_until=?,claim_token=? WHERE id=? AND (claim_until IS NULL OR claim_until<=?)");
      return rows.filter(row => update.run(now, leaseUntil, token, row.id, now).changes === 1)
        .map(row => ({ ...row, claimedAt: now, claimToken: token }));
    },
    claimJob: (id, now, lease) => {
      if (lease.jobId !== id || lease.leaseUntil <= now || !lease.leaseToken) throw new TypeError("A valid future job lease is required");
      const changed = db.prepare("INSERT INTO job_leases(job_id,lease_token,lease_until,heartbeat_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE kind='job' AND id=?) AND NOT EXISTS(SELECT 1 FROM job_leases WHERE job_id=? AND lease_until>?) ON CONFLICT(job_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,heartbeat_at=excluded.heartbeat_at WHERE job_leases.lease_until<=?")
        .run(id, lease.leaseToken, lease.leaseUntil, lease.heartbeatAt, id, id, now, now).changes;
      if (!changed) return null;
      db.prepare("UPDATE records SET payload=json_set(payload,'$.leaseToken',?,'$.leaseUntil',?,'$.heartbeatAt',?,'$.attempt',json_extract(payload,'$.attempt')+1) WHERE kind='job' AND id=?")
        .run(lease.leaseToken, lease.leaseUntil, lease.heartbeatAt, id);
      return get("job", id);
    },
    heartbeatJob: (id, token, heartbeatAt, leaseUntil) => {
      const now = storeNow();
      if (heartbeatAt > now || leaseUntil <= now) return false;
      const changed = db.prepare("UPDATE job_leases SET heartbeat_at=?,lease_until=? WHERE job_id=? AND lease_token=? AND lease_until>=? AND ? >= heartbeat_at")
        .run(heartbeatAt, leaseUntil, id, token, now, heartbeatAt).changes === 1;
      if (changed) db.prepare("UPDATE records SET payload=json_set(payload,'$.leaseUntil',?,'$.heartbeatAt',?) WHERE kind='job' AND id=?")
        .run(leaseUntil, heartbeatAt, id);
      return changed;
    },
    updateLeasedJob: (job, token) => {
      const current = get<ProductionJob>("job", job.id);
      if (!current || current.leaseToken !== token || job.leaseToken !== token || job.leaseUntil !== current.leaseUntil || job.heartbeatAt !== current.heartbeatAt || current.projectId !== job.projectId || current.operation !== job.operation || current.idempotencyKey !== job.idempotencyKey || current.requestHash !== job.requestHash || JSON.stringify(current.requestSnapshot) !== JSON.stringify(job.requestSnapshot) || current.createdAt !== job.createdAt) return false;
      const changed = db.prepare("UPDATE records SET payload=? WHERE kind='job' AND id=? AND EXISTS(SELECT 1 FROM job_leases WHERE job_id=? AND lease_token=? AND lease_until>=?)")
        .run(toJson(job), job.id, job.id, token, storeNow()).changes === 1;
      if (!changed) return false;
      db.prepare("UPDATE jobs SET status=?,provider_ref=? WHERE job_id=?").run(job.status, job.providerRef, job.id);
      replaceJobReferences(job);
      return true;
    },
    appendJobEvent: e => {
      const inserted = db.prepare("INSERT INTO job_events(job_id,sequence,at,status,message,progress) SELECT ?,?,?,?,?,? WHERE ?=COALESCE((SELECT MAX(sequence)+1 FROM job_events WHERE job_id=?),1)")
        .run(e.jobId, e.sequence, e.at, e.status, e.message, e.progress, e.sequence, e.jobId).changes;
      if (inserted !== 1) throw new Error("Job event sequence must increase by one");
    },
    releaseOutbox: (id, token) => db.prepare("UPDATE outbox SET claimed_at=NULL,claim_until=NULL,claim_token=NULL WHERE id=? AND claim_token=?").run(id,token).changes===1,
    acknowledgeOutbox: (id, token) => db.prepare("DELETE FROM outbox WHERE id=? AND claim_token=? AND claim_until>?").run(id,token,storeNow()).changes===1,
    heartbeatOutbox: (id, token, now, leaseUntil) => {
      const storeTime = storeNow();
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseUntil) || leaseUntil <= now ||
          !Number.isSafeInteger(storeTime) || storeTime < 0 || now > storeTime || leaseUntil <= storeTime || !token) {
        throw new TypeError("A valid time and future outbox heartbeat lease are required");
      }
      return db.prepare("UPDATE outbox SET claimed_at=?,claim_until=? WHERE id=? AND claim_token=? AND claim_until>? AND claim_until>? AND claimed_at<=? AND claim_until<=?")
        .run(now, leaseUntil, id, token, now, storeTime, now, leaseUntil).changes === 1;
    },
    requestJobCancellation: (id, expectedStatus, requestedAt) => {
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) throw new TypeError("Cancellation time must be a nonnegative safe integer");
      const changed = db.prepare("UPDATE records SET payload=json_set(payload,'$.status','cancel_requested','$.updatedAt',?) WHERE kind='job' AND id=? AND json_extract(payload,'$.status')=? AND ? NOT IN ('cancel_requested','completed','failed','canceled') AND ? >= json_extract(payload,'$.updatedAt') AND EXISTS(SELECT 1 FROM jobs WHERE job_id=? AND status=?)")
        .run(requestedAt, id, expectedStatus, expectedStatus, requestedAt, id, expectedStatus).changes;
      if (changed !== 1) return false;
      const mirrored = db.prepare("UPDATE jobs SET status='cancel_requested' WHERE job_id=? AND status=?").run(id, expectedStatus).changes;
      if (mirrored !== 1) throw new Error("Job status index changed during cancellation transaction");
      return true;
    },
  };
  const transaction = db.transaction((work: (tx: ProductionWritePort) => unknown) => {
    let active = true;
    const guardedMethods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
    const scopedWrites = new Proxy(writes, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const existing = guardedMethods.get(property);
        if (existing) return existing;
        const guarded = (...args: unknown[]) => {
          if (!active) throw new TypeError("SQLite transaction callback has ended");
          return Reflect.apply(value, target, args);
        };
        guardedMethods.set(property, guarded);
        return guarded;
      },
    }) as ProductionWritePort;
    try {
      const result = work(scopedWrites);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        // The synchronous caller gets the clear API error. Observe the async callback's
        // rejection too, since its continuation will hit the expired scoped port.
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("SQLite transaction callback must be synchronous");
      }
      return result;
    } finally {
      active = false;
    }
  });
  const store: SqliteProductionStore = { read, transaction: work => transaction.immediate(work as (tx: ProductionWritePort) => unknown) as never, close: () => db.close(), schemaVersion: () => (db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations").get() as {v:number}).v, pragmas: () => ({ journalMode: db.pragma("journal_mode", {simple:true}) as string, foreignKeys: db.pragma("foreign_keys", {simple:true}) as number, synchronous: db.pragma("synchronous", {simple:true}) as number, busyTimeout: db.pragma("busy_timeout", {simple:true}) as number }), integrityCheck: () => { const rows = db.pragma("integrity_check") as {integrity_check:string}[]; return { ok: rows.length===1 && rows[0].integrity_check === "ok", messages: rows.map(x=>x.integrity_check) }; } };
  return store;
}

export const openSqliteProductionStore = openProductionStore;

CREATE TABLE budget_policies (
  policy_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  currency TEXT,
  currency_key TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('minor_currency','spark_token')),
  head_revision INTEGER NOT NULL CHECK(head_revision BETWEEN 0 AND 9007199254740991),
  CHECK((unit='minor_currency' AND currency IS NOT NULL AND currency_key=currency) OR (unit='spark_token' AND currency IS NULL AND currency_key='')),
  UNIQUE(provider_id,account_id,unit,currency_key)
);
CREATE TABLE budget_policy_revisions (
  revision_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES budget_policies(policy_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  payload TEXT NOT NULL,
  UNIQUE(policy_id,revision),
  UNIQUE(revision_id,policy_id)
);
CREATE TABLE budget_authorizations (
  authorization_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  policy_id TEXT NOT NULL REFERENCES budget_policies(policy_id) ON DELETE RESTRICT,
  head_revision INTEGER NOT NULL CHECK(head_revision BETWEEN 0 AND 9007199254740991),
  UNIQUE(project_id,policy_id)
);
CREATE TABLE budget_authorization_revisions (
  revision_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL REFERENCES budget_authorizations(authorization_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  policy_revision_id TEXT NOT NULL REFERENCES budget_policy_revisions(revision_id) ON DELETE RESTRICT,
  payload TEXT NOT NULL,
  UNIQUE(authorization_id,revision)
);
CREATE TABLE budget_account_evidence (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  credential_binding_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK(observed_at BETWEEN 0 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(expires_at BETWEEN 0 AND 9007199254740991),
  payload TEXT NOT NULL,
  CHECK(expires_at>observed_at)
);
CREATE INDEX budget_account_evidence_latest ON budget_account_evidence(provider_id,credential_binding_id,observed_at DESC,id);
CREATE TABLE budget_quotes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  media_quote_kind TEXT NOT NULL DEFAULT 'quote' CHECK(media_quote_kind='quote'),
  media_quote_id TEXT UNIQUE,
  payload TEXT NOT NULL,
  FOREIGN KEY(media_quote_kind,media_quote_id) REFERENCES records(kind,id) ON DELETE RESTRICT
);
CREATE TABLE budget_quote_bindings (
  id TEXT PRIMARY KEY,
  budget_quote_id TEXT NOT NULL UNIQUE REFERENCES budget_quotes(id) ON DELETE RESTRICT,
  account_evidence_id TEXT NOT NULL REFERENCES budget_account_evidence(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  credential_binding_id TEXT NOT NULL,
  currency TEXT,
  currency_key TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('minor_currency','spark_token','unknown')),
  execution_semantic_hash TEXT NOT NULL,
  quoted_at INTEGER NOT NULL CHECK(quoted_at BETWEEN 0 AND 9007199254740991),
  payload TEXT NOT NULL,
  CHECK((unit='minor_currency' AND currency IS NOT NULL AND currency_key=currency) OR (unit='spark_token' AND currency IS NULL AND currency_key='') OR (unit='unknown' AND currency_key=COALESCE(currency,'')))
);
CREATE TABLE budget_executions (
  execution_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('media_job','text_proposal')),
  media_job_kind TEXT NOT NULL DEFAULT 'job' CHECK(media_job_kind='job'),
  media_job_id TEXT UNIQUE,
  payload TEXT NOT NULL,
  CHECK((kind='media_job' AND media_job_id IS NOT NULL AND media_job_id=execution_id) OR (kind='text_proposal' AND media_job_id IS NULL)),
  FOREIGN KEY(media_job_kind,media_job_id) REFERENCES records(kind,id) ON DELETE RESTRICT,
  UNIQUE(project_id,idempotency_key)
);
CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES budget_executions(execution_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  policy_revision_id TEXT NOT NULL REFERENCES budget_policy_revisions(revision_id) ON DELETE RESTRICT,
  authorization_revision_id TEXT NOT NULL REFERENCES budget_authorization_revisions(revision_id) ON DELETE RESTRICT,
  budget_quote_id TEXT NOT NULL REFERENCES budget_quotes(id) ON DELETE RESTRICT,
  quote_binding_id TEXT NOT NULL REFERENCES budget_quote_bindings(id) ON DELETE RESTRICT,
  account_evidence_id TEXT NOT NULL REFERENCES budget_account_evidence(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  credential_binding_id TEXT NOT NULL,
  currency TEXT,
  currency_key TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(unit IN ('minor_currency','spark_token')),
  utc_day TEXT NOT NULL,
  reserved_at INTEGER NOT NULL CHECK(reserved_at BETWEEN 0 AND 9007199254740991),
  upper_estimate INTEGER NOT NULL CHECK(upper_estimate BETWEEN 0 AND 9007199254740991),
  payload TEXT NOT NULL,
  CHECK((unit='minor_currency' AND currency IS NOT NULL AND currency_key=currency) OR (unit='spark_token' AND currency IS NULL AND currency_key='')),
  UNIQUE(project_id,idempotency_key)
);
CREATE INDEX budget_reservations_project_scope ON budget_reservations(project_id,provider_id,account_id,unit,currency_key);
CREATE INDEX budget_reservations_account_day ON budget_reservations(provider_id,account_id,unit,currency_key,utc_day);
CREATE TABLE budget_reconciliation_events (
  sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 9007199254740991),
  reservation_id TEXT NOT NULL REFERENCES budget_reservations(id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(provider_id,account_id,event_key)
);
CREATE INDEX budget_reconciliation_reservation_sequence ON budget_reconciliation_events(reservation_id,sequence);

CREATE TRIGGER budget_policies_identity_immutable BEFORE UPDATE ON budget_policies
WHEN NEW.policy_id!=OLD.policy_id OR NEW.provider_id!=OLD.provider_id OR NEW.account_id!=OLD.account_id OR NEW.currency IS NOT OLD.currency OR NEW.currency_key!=OLD.currency_key OR NEW.unit!=OLD.unit OR NEW.head_revision<OLD.head_revision
BEGIN SELECT RAISE(ABORT,'budget policy scope is immutable'); END;
CREATE TRIGGER budget_policies_no_delete BEFORE DELETE ON budget_policies BEGIN SELECT RAISE(ABORT,'budget policy identity is immutable'); END;
CREATE TRIGGER budget_authorizations_identity_immutable BEFORE UPDATE ON budget_authorizations
WHEN NEW.authorization_id!=OLD.authorization_id OR NEW.project_id!=OLD.project_id OR NEW.policy_id!=OLD.policy_id OR NEW.head_revision<OLD.head_revision
BEGIN SELECT RAISE(ABORT,'budget authorization scope is immutable'); END;
CREATE TRIGGER budget_authorizations_no_delete BEFORE DELETE ON budget_authorizations BEGIN SELECT RAISE(ABORT,'budget authorization identity is immutable'); END;

CREATE TRIGGER budget_policy_revisions_no_update BEFORE UPDATE ON budget_policy_revisions BEGIN SELECT RAISE(ABORT,'budget policy revisions are immutable'); END;
CREATE TRIGGER budget_policy_revisions_no_delete BEFORE DELETE ON budget_policy_revisions BEGIN SELECT RAISE(ABORT,'budget policy revisions are immutable'); END;
CREATE TRIGGER budget_authorization_revisions_no_update BEFORE UPDATE ON budget_authorization_revisions BEGIN SELECT RAISE(ABORT,'budget authorization revisions are immutable'); END;
CREATE TRIGGER budget_authorization_revisions_no_delete BEFORE DELETE ON budget_authorization_revisions BEGIN SELECT RAISE(ABORT,'budget authorization revisions are immutable'); END;
CREATE TRIGGER budget_account_evidence_no_update BEFORE UPDATE ON budget_account_evidence BEGIN SELECT RAISE(ABORT,'budget account evidence is immutable'); END;
CREATE TRIGGER budget_account_evidence_no_delete BEFORE DELETE ON budget_account_evidence BEGIN SELECT RAISE(ABORT,'budget account evidence is immutable'); END;
CREATE TRIGGER budget_quotes_no_update BEFORE UPDATE ON budget_quotes BEGIN SELECT RAISE(ABORT,'budget quotes are immutable'); END;
CREATE TRIGGER budget_quotes_no_delete BEFORE DELETE ON budget_quotes BEGIN SELECT RAISE(ABORT,'budget quotes are immutable'); END;
CREATE TRIGGER budget_quote_bindings_no_update BEFORE UPDATE ON budget_quote_bindings BEGIN SELECT RAISE(ABORT,'quote bindings are immutable'); END;
CREATE TRIGGER budget_quote_bindings_no_delete BEFORE DELETE ON budget_quote_bindings BEGIN SELECT RAISE(ABORT,'quote bindings are immutable'); END;
CREATE TRIGGER budget_executions_no_update BEFORE UPDATE ON budget_executions BEGIN SELECT RAISE(ABORT,'budget executions are immutable'); END;
CREATE TRIGGER budget_executions_no_delete BEFORE DELETE ON budget_executions BEGIN SELECT RAISE(ABORT,'budget executions are immutable'); END;
CREATE TRIGGER budget_reservations_no_update BEFORE UPDATE ON budget_reservations BEGIN SELECT RAISE(ABORT,'budget reservations are immutable'); END;
CREATE TRIGGER budget_reservations_no_delete BEFORE DELETE ON budget_reservations BEGIN SELECT RAISE(ABORT,'budget reservations are immutable'); END;
CREATE TRIGGER budget_reconciliation_events_no_update BEFORE UPDATE ON budget_reconciliation_events BEGIN SELECT RAISE(ABORT,'reconciliation events are immutable'); END;
CREATE TRIGGER budget_reconciliation_events_no_delete BEFORE DELETE ON budget_reconciliation_events BEGIN SELECT RAISE(ABORT,'reconciliation events are immutable'); END;
